import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { eventBus } from "../services/eventBus";
import { logger } from "../utils/logger";
import { magicBlockSessions } from "../services/magicBlockSessionManager";
import { ticketStore } from "../state/ticketStore";
import { privateEscrowIntentStore } from "../state/privateEscrowIntentStore";
import { buildPrivateEscrowIntentFromBundle } from "../services/perEscrowIntentService";

const FETCH_RETRY_MAX = 12;
const FETCH_RETRY_DELAY_MS = 1000;
const handoffProcessingLocks = new Map<string, Promise<void>>();

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTicketHandoffLock<T>(ticketId: string, work: () => Promise<T>): Promise<T> {
    const previous = handoffProcessingLocks.get(ticketId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    handoffProcessingLocks.set(ticketId, next);

    await previous.catch(() => undefined);
    try {
        return await work();
    } finally {
        release();
        if (handoffProcessingLocks.get(ticketId) === next) {
            handoffProcessingLocks.delete(ticketId);
        }
    }
}

export function initRollupListener(): void {
    eventBus.subscribe("negotiation_ready", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId, rollupMode: payload.rollupMode });
        listenerLog.info("rollup_negotiation_opening", {
            buyer: payload.buyer,
            seller: payload.seller,
        });

        const result = await magicBlockSessions.openForTicket(
            payload.ticketId,
            [payload.buyer, payload.seller],
            payload.rollupMode
        );

        if (!result.success) {
            listenerLog.error("rollup_negotiation_open_failed", {}, new Error(result.error || "Unknown rollup session open failure"));
            return;
        }

        eventBus.publish("middleman_response", {
            ticket_id: payload.ticketId,
            content: `${payload.rollupMode} negotiation session is live. Submit terms through the rollup session now.`,
            phase: "rollup_negotiation",
            timestamp: new Date().toISOString(),
        });
    });

    eventBus.subscribe("rollup_consensus_reached", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId });
        const ticket = await ticketStore.getTicket(payload.ticketId);
        if (!ticket) {
            listenerLog.warn("rollup_consensus_ticket_missing", { agentId: payload.agentId });
            return;
        }

        if (ticket.rollup_mode === "PER") {
            listenerLog.info("per_consensus_signal_received_waiting_for_handoff_bundle", {
                agentId: payload.agentId,
                commitSignature: payload.commitSignature || null,
            });
            return;
        }

        let committed:
            | {
                agreedPriceLamports: bigint;
                agreedAsset: string;
                buyerCollateralLamports: bigint;
                sellerCollateralLamports: bigint;
                status: string;
                sessionPda: string;
            }
            | null = null;

        for (let attempt = 1; attempt <= FETCH_RETRY_MAX; attempt++) {
            try {
                const fetched = await magicBlockSessions.fetchCommittedTerms(payload.ticketId);
                if (
                    fetched.status === "consensusReached" ||
                    fetched.agreedPriceLamports > 0n ||
                    fetched.buyerCollateralLamports > 0n ||
                    fetched.sellerCollateralLamports > 0n
                ) {
                    committed = fetched;
                    break;
                }
            } catch (error: any) {
                listenerLog.warn("rollup_commit_fetch_retry", {
                    attempt,
                    error: error?.message || String(error),
                });
            }

            await sleep(FETCH_RETRY_DELAY_MS);
        }

        if (!committed) {
            listenerLog.error("rollup_commit_fetch_failed", {}, new Error("Committed rollup state was not visible on L1"));
            return;
        }

        magicBlockSessions.completeTicketSession(payload.ticketId);

        eventBus.publish("agreement_detected", {
            ticketId: payload.ticketId,
            price: Number(committed.agreedPriceLamports) / LAMPORTS_PER_SOL,
            collateral_buyer: Number(committed.buyerCollateralLamports) / LAMPORTS_PER_SOL,
            collateral_seller: Number(committed.sellerCollateralLamports) / LAMPORTS_PER_SOL,
            asset_type: committed.agreedAsset,
            confidence: 100,
            buyer: ticket.buyer,
            seller: ticket.seller,
        });

        listenerLog.info("rollup_agreement_promoted_to_l1_pipeline", {
            sessionPda: committed.sessionPda,
            agreedAsset: committed.agreedAsset,
            agreedPriceLamports: committed.agreedPriceLamports.toString(),
        });
    });

    eventBus.subscribe("private_handoff_bundle_ready", async (payload) => {
        await withTicketHandoffLock(payload.ticketId, async () => {
            const listenerLog = logger.withContext({ ticket_id: payload.ticketId, source: "per_private_handoff_bundle" });
            const ticket = await ticketStore.getTicket(payload.ticketId);
            if (!ticket) {
                listenerLog.warn("per_handoff_bundle_ticket_missing", { agentId: payload.agentId });
                return;
            }

            if (ticket.rollup_mode !== "PER") {
                listenerLog.warn("per_handoff_bundle_ignored_for_non_per_ticket", {
                    rollupMode: ticket.rollup_mode,
                });
                return;
            }

            const existingIntent = await privateEscrowIntentStore.getLatestByTicket(payload.ticketId);
            if (
                existingIntent &&
                existingIntent.rollupMode === "PER" &&
                existingIntent.buyer === ticket.buyer &&
                existingIntent.seller === ticket.seller &&
                existingIntent.sessionPda === payload.bundle.sessionPda &&
                existingIntent.termsHash === payload.bundle.termsHash
            ) {
                listenerLog.info("per_handoff_bundle_duplicate_ignored", {
                    agentId: payload.agentId,
                    intentId: existingIntent.intentId,
                    sessionPda: existingIntent.sessionPda,
                    termsHash: existingIntent.termsHash,
                });
                return;
            }

            const intent = await buildPrivateEscrowIntentFromBundle({
                ticketId: payload.ticketId,
                buyer: ticket.buyer,
                seller: ticket.seller,
                bundle: payload.bundle,
            });

            const proofWriteSignature = await magicBlockSessions.recordPrivateHandoffProof(
                payload.ticketId,
                intent
            );
            const proof = await magicBlockSessions.fetchLivePrivateHandoffProof(payload.ticketId);

            if (
                proof.sessionPda !== intent.sessionPda ||
                proof.buyer !== intent.buyer ||
                proof.seller !== intent.seller ||
                proof.termsHash !== intent.termsHash ||
                proof.buyerPaymentFundingHash !== intent.fundingCommitments.buyerPaymentHash ||
                proof.buyerCollateralFundingHash !== intent.fundingCommitments.buyerCollateralHash ||
                proof.sellerCollateralFundingHash !== intent.fundingCommitments.sellerCollateralHash ||
                proof.buyerCollateralCiphertext !== intent.encryptedTerms.buyerCollateral.account ||
                proof.sellerCollateralCiphertext !== intent.encryptedTerms.sellerCollateral.account ||
                proof.paymentAmountCiphertext !== intent.encryptedTerms.paymentAmount.account ||
                proof.settlementResultCiphertext !== intent.encryptedTerms.settlementResult.account ||
                proof.networkEncryptionKeyPda !== intent.encryptedTerms.networkEncryptionKeyPda
            ) {
                throw new Error(
                    `PER handoff proof written on TEE did not match the generated escrow intent for ticket ${payload.ticketId}`
                );
            }

            await privateEscrowIntentStore.save(intent);

            eventBus.publish("private_escrow_intent_ready", {
                ticketId: payload.ticketId,
                intentId: intent.intentId,
                rollupMode: "PER",
                negotiationSource: "PER",
                sessionPda: intent.sessionPda,
                termsHash: intent.termsHash,
                assetMint: intent.assetMint,
                status: intent.status,
            });

            listenerLog.info("per_agreement_promoted_from_handoff_bundle", {
                sessionPda: intent.sessionPda,
                intentId: intent.intentId,
                termsHash: intent.termsHash,
                proofWriteSignature,
                proofRecordedAt: proof.proofRecordedAt,
            });
        });
    });

    logger.info("rollup_listener_initialized");
}

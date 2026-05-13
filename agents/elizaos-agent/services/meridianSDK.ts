import { EventEmitter } from "events";
import { createRequire } from "module";
import type {
    Deal,
    DirectMessage,
    OfferCreationParams,
    OfferData,
} from "@agentotc/sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import {
    dealTracker,
    isCompletionEvidenceSatisfied,
    type AgentRole,
} from "./dealTracker.js";
import { zerionCli } from "./zerionCli.js";

const require = createRequire(import.meta.url);
const { AgentOTC } = require("@agentotc/sdk") as typeof import("@agentotc/sdk");
type AgentOTCClient = InstanceType<typeof AgentOTC>;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

type MatchListener = (deal: Deal) => void;

function parseNumberishEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function parseSecretKey(raw: string): Uint8Array {
    const trimmed = raw.trim();

    if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed) as number[];
        return Uint8Array.from(parsed);
    }

    try {
        const decoded = bs58.decode(trimmed);
        if (decoded.length >= 32) {
            return decoded;
        }
    } catch {
        // fall through
    }

    const base64 = Buffer.from(trimmed, "base64");
    if (base64.length >= 32) {
        return new Uint8Array(base64);
    }

    throw new Error("Unsupported private key format. Use base58, base64, or JSON array secret keys.");
}

function resolveRoleEnv(role: AgentRole, key: string): string | undefined {
    const prefix = role === "buyer" ? "BUYER" : "SELLER";
    return process.env[`${prefix}_${key}`] || process.env[key];
}

function currentTimeoutMs(): number {
    return parseNumberishEnv("AGENT_ACTION_TIMEOUT_MS", 120_000);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiresFullUmbra(privateMode: boolean): boolean {
    return (
        privateMode &&
        (process.env.AIROTC_REQUIRE_FULL_UMBRA === "true" ||
            process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE === "FULL_UMBRA")
    );
}

function isTerminalPhase(phase: string | null | undefined): boolean {
    return Boolean(phase && ["completed", "settled", "failed", "cancelled", "disputed"].includes(phase));
}

class MeridianSDKService extends EventEmitter {
    private client: AgentOTCClient | null = null;
    private keypair: Keypair | null = null;
    private currentDeal: Deal | null = null;
    private role: AgentRole = "buyer";
    private privateMode = true;
    private matchListeners = new Set<MatchListener>();
    private rpcCandidates: string[] = [];
    private sessionStartedAt = 0;

    async initialize(role: AgentRole, privateMode: boolean): Promise<void> {
        if (this.client) {
            throw new Error("AIR OTC agent SDK already initialized in this process");
        }

        this.role = role;
        this.privateMode = privateMode;
        this.sessionStartedAt = Date.now();

        const privateKey =
            resolveRoleEnv(role, "PRIVATE_KEY") ||
            process.env.AGENT_PRIVATE_KEY;

        if (!privateKey) {
            throw new Error(
                `Missing ${role.toUpperCase()}_PRIVATE_KEY or AGENT_PRIVATE_KEY for ElizaOS agent runtime`
            );
        }

        this.keypair = Keypair.fromSecretKey(parseSecretKey(privateKey));

        const apiUrl =
            resolveRoleEnv(role, "API_URL") ||
            process.env.AIROTC_API_URL ||
            process.env.OBSERVATORY_URL ||
            process.env.API_URL ||
            "http://localhost:3000";
        const wsUrl =
            resolveRoleEnv(role, "WS_URL") ||
            process.env.AIROTC_WS_URL ||
            process.env.WS_URL ||
            "ws://localhost:3001";
        const rpcUrl =
            process.env.SOLANA_RPC_PRIMARY ||
            process.env.SOLANA_RPC_URL ||
            "https://api.devnet.solana.com";
        this.rpcCandidates = Array.from(
            new Set(
                [
                    rpcUrl,
                    process.env.SOLANA_RPC_URL,
                    process.env.SOLANA_RPC_PRIMARY,
                    "https://api.devnet.solana.com",
                ].filter((value): value is string => Boolean(value && value.trim().length > 0))
            )
        );
        const apiKey =
            resolveRoleEnv(role, "API_KEY") ||
            process.env.AGENT_API_KEY;

        const persistLocalState =
            process.env.AIROTC_PERSIST_AGENT_STATE === "true" ||
            process.env.AIROTC_USE_PREWARMED_UMBRA_SETTLEMENT_WALLETS === "true";

        this.client = new AgentOTC({
            apiKey,
            walletPrivateKey: bs58.encode(this.keypair.secretKey),
            apiUrl,
            wsUrl,
            rpcUrl,
            legacyWsEvents: false,
            persistLocalState,
            privateMode,
            strictOpaquePerMode: privateMode,
        });

        this.attachClientListeners(this.client);
        await this.client.register();
        await this.client.connect();
        await this.client.publishEncryptionKey().catch(() => undefined);
        await this.cancelStaleOwnOffers().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            dealTracker.note(`Stale-offer cleanup skipped: ${message}`);
        });
        this.client.setAutoApprovalPolicy({
            allowedAssets: [this.getTradeAsset(), this.getTradeAssetMint()],
            maxPrice: this.getTradePriceSol() * 2,
            maxCollateral: this.getTradeCollateralSol() * 2,
            requireStealthSettlement: true,
        });

        dealTracker.update({
            role,
            privateMode,
            wallet: this.keypair.publicKey.toBase58(),
            currentPhase: "idle",
            lastNote: "AIR OTC external agent initialized through the public SDK",
        });

        await this.refreshDynamicState();
    }

    getClient(): AgentOTCClient {
        if (!this.client) {
            throw new Error("AIR OTC agent SDK has not been initialized");
        }
        return this.client;
    }

    getRole(): AgentRole {
        return this.role;
    }

    isPrivateMode(): boolean {
        return this.privateMode;
    }

    getWalletAddress(): string {
        if (!this.keypair) {
            throw new Error("Agent wallet not initialized");
        }
        return this.keypair.publicKey.toBase58();
    }

    async shutdown(): Promise<void> {
        if (this.client) {
            this.client.disconnect();
        }
        this.currentDeal = null;
        this.client = null;
    }

    async refreshDynamicState(): Promise<void> {
        await this.refreshWalletBalance();

        if (!this.currentDeal && this.role === "seller") {
            await this.recoverMatchedDealFromOffer();
        }

        if (!this.currentDeal && this.role === "buyer") {
            await this.refreshVisibleOffers();
        }

        if (this.currentDeal) {
            try {
                const status = await this.currentDeal.refreshStatus();
                const terminal = ["completed", "settled"].includes(status.phase);
                const nextSnapshot = dealTracker.update({
                    activeTicketId: this.currentDeal.id,
                    currentPhase: status.phase,
                });
                dealTracker.update({
                    dealCompleted: terminal && isCompletionEvidenceSatisfied(nextSnapshot),
                });
            } catch {
                // Keep the live event state if a status refresh is transiently unavailable.
            }
        }
    }

    async recoverMatchedDealFromOffer(): Promise<Deal | null> {
        const activeOfferId = dealTracker.getSnapshot().activeOfferId;
        if (!activeOfferId || this.currentDeal) {
            return this.currentDeal;
        }

        const client = this.getClient();
        const offer = await (client as any).offers.get(activeOfferId).catch(() => null);
        const ticketId = offer?.ticket?.id || null;
        if (!ticketId) {
            return null;
        }

        client.promoteOfferWalletsToTicket(activeOfferId, ticketId);
        const deal = client.getDeal(ticketId);
        this.setActiveDeal(deal);
        dealTracker.update({
            activeOfferMode: offer?.mode || dealTracker.getSnapshot().activeOfferMode,
            lastNote: `Recovered matched ticket ${ticketId} from offer ${activeOfferId}`,
        });
        return deal;
    }

    async refreshWalletBalance(): Promise<number> {
        if (!this.keypair) {
            throw new Error("Agent wallet not initialized");
        }

        let lastError: unknown = null;

        for (const rpcUrl of this.rpcCandidates) {
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    const connection = new Connection(rpcUrl, "confirmed");
                    const balanceLamports = await connection.getBalance(this.keypair.publicKey);
                    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
                    dealTracker.update({ balanceSol });
                    return balanceSol;
                } catch (error) {
                    lastError = error;
                    await sleep(500 * attempt);
                }
            }
        }

        const previous = dealTracker.getSnapshot().balanceSol;
        if (previous > 0) {
            dealTracker.note(
                `Balance refresh temporarily failed; continuing with previous balance ${previous.toFixed(6)} SOL`
            );
            return previous;
        }

        throw lastError instanceof Error
            ? lastError
            : new Error("Unable to fetch wallet balance from any configured RPC endpoint");
    }

    async refreshVisibleOffers(): Promise<OfferData[]> {
        const client = this.getClient();
        const allOffers = await client.offers.list({ status: "active" }).catch(() => []);
        const oppositeMode = this.role === "buyer" ? "sell" : "buy";
        const expectedCounterparty = this.getExpectedCounterpartyWallet();
        const freshnessCutoff = this.sessionStartedAt - 5_000;
        const filtered = allOffers.filter((offer: OfferData) => {
            if (offer.mode !== oppositeMode) {
                return false;
            }
            if (expectedCounterparty && offer.creator?.wallet !== expectedCounterparty) {
                return false;
            }
            if (offer.createdAt) {
                const createdAtMs = new Date(offer.createdAt).getTime();
                if (Number.isFinite(createdAtMs) && createdAtMs < freshnessCutoff) {
                    return false;
                }
            }
            return true;
        });
        const ranked = filtered.sort((a: OfferData, b: OfferData) => {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bTime - aTime;
        });
        dealTracker.update({ visibleOffers: ranked });
        return ranked;
    }

    async postCanonicalOffer(): Promise<OfferData> {
        const client = this.getClient();
        const existing = dealTracker.getSnapshot().activeOfferId;
        if (existing) {
            const match = dealTracker
                .getSnapshot()
                .visibleOffers.find((offer) => offer.id === existing);
            if (match) {
                return match;
            }
        }

        const params: OfferCreationParams = {
            asset: this.getTradeAsset(),
            amount: this.getTradeAmount(),
            price: this.getTradePriceSol(),
            collateral: this.getTradeCollateralSol(),
            mode: this.role === "seller" ? "sell" : "buy",
            rollupMode: this.privateMode ? "PER" : "ER",
        };

        await zerionCli.verifyPreTrade(this.role, this.getWalletAddress());
        const offer = await client.offers.create(params);
        dealTracker.update({
            activeOfferId: offer.id,
            activeOfferMode: offer.mode,
            lastNote: `Posted ${offer.mode} offer ${offer.id}`,
        });
        return offer;
    }

    async browseAndAcceptBestOffer(): Promise<Deal | null> {
        const client = this.getClient();
        const offers = await this.refreshVisibleOffers();
        const candidate = offers.find((offer) => {
            const rollupOkay = !this.privateMode || offer.rollupMode === "PER" || !offer.rollupMode;
            return offer.status === "active" && rollupOkay;
        });

        if (!candidate) {
            dealTracker.note("No compatible offer is available yet");
            return null;
        }

        await zerionCli.verifyPreTrade(this.role, this.getWalletAddress());
        const deal = await client.offers.accept(candidate.id);
        this.setActiveDeal(deal);
        dealTracker.update({
            activeOfferId: candidate.id,
            activeOfferMode: candidate.mode,
            lastNote: `Accepted offer ${candidate.id} and entered ticket ${deal.id}`,
        });
        return deal;
    }

    async waitForMatchedDeal(timeoutMs = 180_000): Promise<Deal> {
        if (this.currentDeal) {
            return this.currentDeal;
        }

        return new Promise<Deal>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.matchListeners.delete(onMatch);
                reject(new Error(`Timed out waiting for matched deal after ${timeoutMs}ms`));
            }, timeoutMs);

            const onMatch: MatchListener = (deal) => {
                clearTimeout(timeout);
                this.matchListeners.delete(onMatch);
                resolve(deal);
            };

            this.matchListeners.add(onMatch);
        });
    }

    async completeCanonicalPrivateAgreement(): Promise<void> {
        const deal = await this.requireCurrentDeal();

        if (!dealTracker.getSnapshot().rollupSessionReady) {
            await deal.waitForRollupSessionReady(currentTimeoutMs());
            dealTracker.update({ rollupSessionReady: true });
        }

        if (dealTracker.getSnapshot().privateAgreementComplete) {
            return;
        }

        await deal.completePrivateAgreement({
            assetMint: this.getTradeAsset(),
            priceSol: this.getTradePriceSol(),
            buyerCollateralSol: this.getTradeCollateralSol(),
            sellerCollateralSol: this.getTradeCollateralSol(),
            quantity: this.getTradeAmount(),
        });

        dealTracker.update({
            privateAgreementComplete: true,
            lastNote: `Private agreement finalized for ticket ${deal.id}`,
        });
    }

    async autoFundCurrentDeal(): Promise<void> {
        const deal = await this.requireCurrentDeal();

        await deal.waitForFundingRequest({ timeoutMs: currentTimeoutMs() });
        dealTracker.update({ fundingRequestPending: true });
        await deal.autoFundPrivateDeal({ timeoutMs: currentTimeoutMs() });

        dealTracker.update({
            fundingRequestPending: false,
            confidentialFundingSubmitted: true,
            lastNote: `Confidential funding submitted for ticket ${deal.id}`,
        });
        console.log(`[ELIZA-AIR OTC] confidential funding submitted for ${deal.id}`);
    }

    async sendCanonicalEncryptedDelivery(): Promise<void> {
        const deal = await this.requireCurrentDeal();
        const payload =
            process.env.ENCRYPTED_DELIVERY_PAYLOAD ||
            process.env.AIROTC_DELIVERY_PAYLOAD ||
            "ACCESS_TOKEN=ACCESS_TOKEN_12345";

        await deal.sendEncryptedDelivery(payload, {
            label: "AIR OTC encrypted delivery",
        });

        dealTracker.update({
            encryptedDeliverySent: true,
            lastNote: `Encrypted delivery sent for ticket ${deal.id}`,
        });
        console.log(`[ELIZA-AIR OTC] encrypted delivery sent for ${deal.id}`);
    }

    async checkEncryptedDelivery(timeoutMs = 8_000): Promise<DirectMessage | null> {
        const deal = await this.requireCurrentDeal();

        try {
            const message = await deal.waitForEncryptedDelivery({
                timeoutMs,
                pollIntervalMs: 2_000,
            });
            dealTracker.update({
                encryptedDeliveryReceived: true,
                lastEncryptedDelivery: message,
                lastNote: `Encrypted delivery received for ticket ${deal.id}`,
            });
            console.log(`[ELIZA-AIR OTC] encrypted delivery received for ${deal.id}`);
            return message;
        } catch {
            dealTracker.note("Encrypted delivery not available yet");
            return null;
        }
    }

    async confirmCurrentPrivateDelivery(): Promise<void> {
        const deal = await this.requireCurrentDeal();
        await deal.waitForReleaseRequest({
            timeoutMs: currentTimeoutMs(),
            requestKind: "BUYER_RELEASE_CONFIRMATION",
        });
        await deal.confirmPrivateDelivery({
            timeoutMs: currentTimeoutMs(),
            requestKind: "BUYER_RELEASE_CONFIRMATION",
        });

        dealTracker.update({
            privateDeliveryConfirmed: true,
            releaseRequestPending: false,
            lastNote: `Private delivery confirmed for ticket ${deal.id}`,
        });
        console.log(`[ELIZA-AIR OTC] private delivery release confirmed for ${deal.id}`);
    }

    async waitForSettlement(timeoutMs = 240_000): Promise<void> {
        const deal = await this.requireCurrentDeal();
        await deal.waitForPhase(["settled", "completed"], { timeoutMs });
        const fullUmbraSatisfied =
            !requiresFullUmbra(this.privateMode) ||
            dealTracker.getSnapshot().umbraLifecycleComplete;
        const nextSnapshot = dealTracker.update({
            dealCompleted: fullUmbraSatisfied,
            currentPhase: "completed",
            lastNote: fullUmbraSatisfied
                ? `Ticket ${deal.id} completed successfully`
                : `Ticket ${deal.id} settled; waiting for full Umbra lifecycle evidence`,
        });
        dealTracker.update({
            dealCompleted: fullUmbraSatisfied && isCompletionEvidenceSatisfied(nextSnapshot),
        });
    }

    async completeUmbraLifecycle(): Promise<void> {
        const deal = await this.requireCurrentDeal();
        const result = await (deal as any).autoCompleteUmbraLifecycle({
            timeoutMs: currentTimeoutMs(),
            amountLamports: this.resolveUmbraLifecycleAmountLamports(),
        });
        const nextSnapshot = dealTracker.update({
            umbraLifecyclePending: false,
            umbraLifecycleComplete: true,
            umbraLifecycleRole: result?.role || dealTracker.getSnapshot().umbraLifecycleRole,
            umbraLifecyclePhases: (result?.phases || []).map((phase: any) => phase.phase),
            umbraLifecycleFinalWallet: result?.finalWallet || null,
            lastNote: `Full Umbra lifecycle completed for ticket ${deal.id}`,
        });
        dealTracker.update({
            dealCompleted:
                ["completed", "settled"].includes(nextSnapshot.currentPhase) &&
                isCompletionEvidenceSatisfied(nextSnapshot),
        });
        console.log(`[ELIZA-AIR OTC] full Umbra lifecycle completed for ${deal.id}`);
    }

    private async requireCurrentDeal(): Promise<Deal> {
        if (this.currentDeal) {
            return this.currentDeal;
        }

        return this.waitForMatchedDeal();
    }

    private attachClientListeners(client: AgentOTCClient): void {
        client.on("deal_matched", (deal: Deal) => {
            void this.acceptMatchedDeal(deal);
        });

        client.on("phase_changed", (update: any) => {
            const nextPhase = update?.phase || update?.payload?.phase || dealTracker.getSnapshot().currentPhase;
            const ticketId = update?.ticketId || update?.payload?.ticketId || this.currentDeal?.id || null;
            if (!this.isRelevantTicket(ticketId)) {
                return;
            }
            const nextSnapshot = dealTracker.update({
                activeTicketId: ticketId,
                currentPhase: nextPhase,
            });
            dealTracker.update({
                dealCompleted:
                    ["completed", "settled"].includes(nextPhase) &&
                    isCompletionEvidenceSatisfied(nextSnapshot),
            });
        });

        client.on("rollup_session_ready", (payload: any) => {
            if (payload?.ticketId && this.isRelevantTicket(payload.ticketId)) {
                dealTracker.update({
                    activeTicketId: payload.ticketId,
                    rollupSessionReady: true,
                    lastNote: `Rollup session ready for ${payload.ticketId}`,
                });
            }
        });

        client.on("confidential_funding_request", (request: any) => {
            if (request?.ticketId && this.isRelevantTicket(request.ticketId)) {
                dealTracker.update({
                    activeTicketId: request.ticketId,
                    fundingRequestPending: true,
                    lastNote: `Funding request received for ${request.ticketId}`,
                });
            }
        });

        client.on("release_approval_request", (request: any) => {
            if (request?.ticketId && this.isRelevantTicket(request.ticketId)) {
                dealTracker.update({
                    activeTicketId: request.ticketId,
                    releaseRequestPending: true,
                    releaseRequestKind: request.requestKind || null,
                    currentPhase:
                        dealTracker.getSnapshot().currentPhase === "idle"
                            ? "awaiting_buyer_release_confirmation"
                            : dealTracker.getSnapshot().currentPhase,
                    lastNote: `Release request received for ${request.ticketId}`,
                });
            }
        });

        client.on("umbra_lifecycle_request", (request: any) => {
            if (request?.ticketId && this.isRelevantTicket(request.ticketId)) {
                dealTracker.update({
                    activeTicketId: request.ticketId,
                    umbraLifecyclePending: true,
                    umbraLifecycleComplete: false,
                    umbraLifecycleRole: request.role || null,
                    umbraLifecyclePhases: Array.isArray(request.requiredPhases)
                        ? request.requiredPhases
                        : [],
                    lastNote: `Full Umbra lifecycle requested for ${request.ticketId}`,
                });
            }
        });

        client.on("deal_complete", (ticketId: string) => {
            if (!this.isRelevantTicket(ticketId)) {
                return;
            }
            const fullUmbraSatisfied =
                !requiresFullUmbra(this.privateMode) ||
                dealTracker.getSnapshot().umbraLifecycleComplete;
            const nextSnapshot = dealTracker.update({
                activeTicketId: ticketId,
                currentPhase: "completed",
                lastNote: fullUmbraSatisfied
                    ? `Deal ${ticketId} completed`
                    : `Deal ${ticketId} completed on deal state; waiting for full Umbra lifecycle evidence`,
            });
            dealTracker.update({
                dealCompleted: fullUmbraSatisfied && isCompletionEvidenceSatisfied(nextSnapshot),
            });
        });
    }

    private setActiveDeal(deal: Deal): void {
        this.currentDeal = deal;
        this.matchListeners.forEach((listener) => listener(deal));
        this.matchListeners.clear();
        dealTracker.update({
            activeTicketId: deal.id,
            currentPhase: "rollup_negotiation",
        });
    }

    private async acceptMatchedDeal(deal: Deal): Promise<void> {
        if (!this.currentDeal) {
            const status = await deal.refreshStatus().catch(() => null);
            if (isTerminalPhase(status?.phase)) {
                dealTracker.note(`Ignored stale terminal ticket ${deal.id} (${status?.phase})`);
                return;
            }
        }

        this.setActiveDeal(deal);
        dealTracker.note(`Matched into ticket ${deal.id}`);
    }

    private isRelevantTicket(ticketId: string | null | undefined): ticketId is string {
        if (!ticketId) {
            return false;
        }
        if (this.currentDeal) {
            return this.currentDeal.id === ticketId;
        }
        const activeTicketId = dealTracker.getSnapshot().activeTicketId;
        return activeTicketId === ticketId;
    }

    private async cancelStaleOwnOffers(): Promise<void> {
        const client = this.getClient();
        const ownOffers = await (client.offers as any).mine({ status: "active" }).catch(() => []);
        const now = Date.now();
        const maxAgeMs = parseNumberishEnv("AIROTC_STALE_OFFER_MAX_AGE_MS", 15 * 60_000);

        for (const offer of ownOffers) {
            if (offer.ticket?.id) {
                continue;
            }

            const createdAtMs = offer.createdAt ? new Date(offer.createdAt).getTime() : 0;
            if (createdAtMs && now - createdAtMs < maxAgeMs) {
                continue;
            }

            await (client.offers as any).cancel(offer.id).catch(() => undefined);
        }
    }

    private getExpectedCounterpartyWallet(): string | null {
        if (this.role === "buyer") {
            return process.env.AIROTC_EXPECTED_SELLER_WALLET || null;
        }
        return process.env.AIROTC_EXPECTED_BUYER_WALLET || null;
    }

    private getTradeAsset(): string {
        return process.env.AIROTC_TRADE_ASSET || "SOL";
    }

    private getTradeAssetMint(): string {
        const configured =
            process.env.AIROTC_TRADE_ASSET_MINT || this.getTradeAsset();
        const upper = configured.toUpperCase();
        if (upper === "SOL" || upper === "WSOL") {
            return WSOL_MINT;
        }
        return configured;
    }

    private getTradeAmount(): number {
        return parseNumberishEnv("AIROTC_TRADE_AMOUNT", 1);
    }

    private getTradePriceSol(): number {
        return parseNumberishEnv("AIROTC_TRADE_PRICE_SOL", 0.1);
    }

    private getTradeCollateralSol(): number {
        return parseNumberishEnv("AIROTC_TRADE_COLLATERAL_SOL", 0.02);
    }

    private resolveUmbraLifecycleAmountLamports(): string {
        const override = process.env.AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS;
        if (override && /^[1-9]\d*$/.test(override)) {
            return override;
        }

        const role = dealTracker.getSnapshot().umbraLifecycleRole || this.role;
        const amountSol =
            role === "buyer"
                ? this.getTradeCollateralSol()
                : this.getTradePriceSol() + this.getTradeCollateralSol();
        const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
        if (!Number.isSafeInteger(lamports) || lamports <= 0) {
            throw new Error("Unable to resolve a positive Umbra lifecycle amount");
        }
        return String(lamports);
    }
}

export const meridianSDK = new MeridianSDKService();

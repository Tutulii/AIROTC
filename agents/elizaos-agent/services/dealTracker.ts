import type { DirectMessage, OfferData } from "@agentotc/sdk";

export type AgentRole = "buyer" | "seller";

export type AgentLoopAction =
    | "WAIT"
    | "POST_OFFER"
    | "BROWSE_AND_ACCEPT_OFFER"
    | "COMPLETE_PRIVATE_AGREEMENT"
    | "AUTO_FUND_PRIVATE_DEAL"
    | "SEND_ENCRYPTED_DELIVERY"
    | "CHECK_ENCRYPTED_DELIVERY"
    | "CONFIRM_PRIVATE_DELIVERY"
    | "COMPLETE_UMBRA_LIFECYCLE"
    | "STOP";

export interface AgentLoopDecision {
    action: AgentLoopAction;
    reason: string;
}

export interface AgentLoopSnapshot {
    role: AgentRole;
    privateMode: boolean;
    wallet: string | null;
    balanceSol: number;
    visibleOffers: OfferData[];
    activeOfferId: string | null;
    activeOfferMode: "buy" | "sell" | null;
    activeTicketId: string | null;
    currentPhase: string;
    rollupSessionReady: boolean;
    privateAgreementComplete: boolean;
    fundingRequestPending: boolean;
    confidentialFundingSubmitted: boolean;
    releaseRequestPending: boolean;
    releaseRequestKind: string | null;
    encryptedDeliverySent: boolean;
    encryptedDeliveryReceived: boolean;
    lastEncryptedDelivery: DirectMessage | null;
    privateDeliveryConfirmed: boolean;
    umbraLifecyclePending: boolean;
    umbraLifecycleComplete: boolean;
    umbraLifecycleRole: "buyer" | "seller" | null;
    umbraLifecyclePhases: string[];
    umbraLifecycleFinalWallet: string | null;
    dealCompleted: boolean;
    lastAction: AgentLoopAction | null;
    lastReason: string | null;
    lastError: string | null;
    lastNote: string | null;
    startedAt: string;
    updatedAt: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

function createInitialSnapshot(): AgentLoopSnapshot {
    const now = nowIso();
    return {
        role: "buyer",
        privateMode: true,
        wallet: null,
        balanceSol: 0,
        visibleOffers: [],
        activeOfferId: null,
        activeOfferMode: null,
        activeTicketId: null,
        currentPhase: "idle",
        rollupSessionReady: false,
        privateAgreementComplete: false,
        fundingRequestPending: false,
        confidentialFundingSubmitted: false,
        releaseRequestPending: false,
        releaseRequestKind: null,
        encryptedDeliverySent: false,
        encryptedDeliveryReceived: false,
        lastEncryptedDelivery: null,
        privateDeliveryConfirmed: false,
        umbraLifecyclePending: false,
        umbraLifecycleComplete: false,
        umbraLifecycleRole: null,
        umbraLifecyclePhases: [],
        umbraLifecycleFinalWallet: null,
        dealCompleted: false,
        lastAction: null,
        lastReason: null,
        lastError: null,
        lastNote: null,
        startedAt: now,
        updatedAt: now,
    };
}

function isTerminalPhase(phase: string): boolean {
    return ["completed", "settled", "failed", "cancelled", "disputed"].includes(phase);
}

function isFailedTerminalPhase(phase: string): boolean {
    return ["failed", "cancelled", "disputed"].includes(phase);
}

function isSuccessfulTerminalPhase(phase: string): boolean {
    return ["completed", "settled"].includes(phase);
}

function requiresFullUmbra(snapshot: AgentLoopSnapshot): boolean {
    return (
        snapshot.privateMode &&
        (process.env.AIROTC_REQUIRE_FULL_UMBRA === "true" ||
            process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE === "FULL_UMBRA")
    );
}

function requiresEncryptedDelivery(snapshot: AgentLoopSnapshot): boolean {
    return snapshot.privateMode && process.env.AIROTC_REQUIRE_ENCRYPTED_DELIVERY === "true";
}

function requiresPrivateRelease(snapshot: AgentLoopSnapshot): boolean {
    return snapshot.privateMode && process.env.AIROTC_REQUIRE_PRIVATE_RELEASE === "true";
}

export function isCompletionEvidenceSatisfied(snapshot: AgentLoopSnapshot): boolean {
    if (requiresFullUmbra(snapshot) && !snapshot.umbraLifecycleComplete) {
        return false;
    }

    if (requiresEncryptedDelivery(snapshot)) {
        if (snapshot.role === "seller" && !snapshot.encryptedDeliverySent) {
            return false;
        }
        if (snapshot.role === "buyer" && !snapshot.encryptedDeliveryReceived) {
            return false;
        }
    }

    if (requiresPrivateRelease(snapshot) && snapshot.role === "buyer" && !snapshot.privateDeliveryConfirmed) {
        return false;
    }

    return true;
}

export function recommendNextAction(snapshot: AgentLoopSnapshot): AgentLoopDecision {
    if (isFailedTerminalPhase(snapshot.currentPhase)) {
        return {
            action: "STOP",
            reason: "The deal reached a failed terminal state.",
        };
    }

    if ((snapshot.dealCompleted || isTerminalPhase(snapshot.currentPhase)) && isCompletionEvidenceSatisfied(snapshot)) {
        return {
            action: "STOP",
            reason: "The deal already reached a terminal state.",
        };
    }

    if (!snapshot.activeTicketId) {
        if (snapshot.role === "seller") {
            if (!snapshot.activeOfferId) {
                return {
                    action: "POST_OFFER",
                    reason: "The seller is idle and should publish the canonical private sell offer.",
                };
            }

            return {
                action: "WAIT",
                reason: "The seller already has an offer live and should wait for a buyer to match it.",
            };
        }

        return {
            action: "BROWSE_AND_ACCEPT_OFFER",
            reason: "The buyer has no active ticket yet and should browse the market for a matching private offer.",
        };
    }

    if (!snapshot.rollupSessionReady) {
        return {
            action: "WAIT",
            reason: "A ticket exists, but the rollup session is not ready yet.",
        };
    }

    if (!snapshot.privateAgreementComplete) {
        return {
            action: "COMPLETE_PRIVATE_AGREEMENT",
            reason: "The rollup session is ready and the private agreement has not been finalized yet.",
        };
    }

    if (!snapshot.confidentialFundingSubmitted) {
        return {
            action: "AUTO_FUND_PRIVATE_DEAL",
            reason: "The private agreement is finalized and the confidential funding step is still outstanding.",
        };
    }

    if (snapshot.role === "seller") {
        const deliveryWindowOpen =
            snapshot.currentPhase === "delivery" ||
            snapshot.currentPhase === "awaiting_buyer_release_confirmation" ||
            snapshot.releaseRequestPending;
        const postFundingDeliveryWindowOpen =
            deliveryWindowOpen ||
            snapshot.umbraLifecyclePending ||
            [
                "escrow_created",
                "created_awaiting_deposits",
                "umbra_lifecycle_pending",
                "awaiting_settlement_plan_approvals",
                "awaiting_release_approvals",
            ].includes(snapshot.currentPhase);

        if (postFundingDeliveryWindowOpen && !snapshot.encryptedDeliverySent) {
            return {
                action: "SEND_ENCRYPTED_DELIVERY",
                reason: "Funding is done; seller should deliver before entering the slower Umbra payout lifecycle.",
            };
        }

        if (requiresFullUmbra(snapshot) && snapshot.umbraLifecyclePending && !snapshot.umbraLifecycleComplete) {
            return {
                action: "COMPLETE_UMBRA_LIFECYCLE",
                reason: "The deal settled but full Umbra payout evidence is still required.",
            };
        }

        return {
            action: "WAIT",
            reason: "The seller is waiting for the buyer to confirm delivery and complete settlement.",
        };
    }

    if (!snapshot.encryptedDeliveryReceived) {
        return {
            action: "CHECK_ENCRYPTED_DELIVERY",
            reason: "The buyer should poll the encrypted DM channel for seller delivery.",
        };
    }

    if (!snapshot.privateDeliveryConfirmed) {
        return {
            action: "CONFIRM_PRIVATE_DELIVERY",
            reason: "The buyer received the encrypted delivery and should confirm private release.",
        };
    }

    if (requiresFullUmbra(snapshot) && snapshot.umbraLifecyclePending && !snapshot.umbraLifecycleComplete) {
        return {
            action: "COMPLETE_UMBRA_LIFECYCLE",
            reason: "The deal settled but full Umbra payout evidence is still required.",
        };
    }

    if (
        requiresFullUmbra(snapshot) &&
        isSuccessfulTerminalPhase(snapshot.currentPhase) &&
        !snapshot.umbraLifecycleComplete
    ) {
        return {
            action: "WAIT",
            reason: "The deal reached settlement and the agent is waiting for the full Umbra lifecycle request.",
        };
    }

    if (isTerminalPhase(snapshot.currentPhase) && !isCompletionEvidenceSatisfied(snapshot)) {
        return {
            action: "WAIT",
            reason: "The deal is terminal, but required proof evidence is still missing.",
        };
    }

    return {
        action: "WAIT",
        reason: "The buyer has already confirmed delivery and should wait for final settlement.",
    };
}

export function buildSnapshotSummary(snapshot: AgentLoopSnapshot): string {
    const offers =
        snapshot.visibleOffers.length === 0
            ? "none"
            : snapshot.visibleOffers
                  .slice(0, 5)
                  .map(
                      (offer) =>
                          `${offer.id} | ${offer.mode.toUpperCase()} ${offer.amount} ${offer.asset} @ ${offer.price} SOL | collateral ${offer.collateral} SOL | ${offer.rollupMode ?? "ER"}`
                  )
                  .join("\n");

    const next = recommendNextAction(snapshot);

    return [
        `Role: ${snapshot.role.toUpperCase()}`,
        `Private mode: ${snapshot.privateMode ? "PER" : "ER"}`,
        `Wallet: ${snapshot.wallet ?? "unknown"}`,
        `Balance: ${snapshot.balanceSol.toFixed(4)} SOL`,
        `Active offer: ${snapshot.activeOfferId ?? "none"}`,
        `Active ticket: ${snapshot.activeTicketId ?? "none"}`,
        `Current phase: ${snapshot.currentPhase}`,
        `Rollup ready: ${snapshot.rollupSessionReady ? "yes" : "no"}`,
        `Agreement complete: ${snapshot.privateAgreementComplete ? "yes" : "no"}`,
        `Funding request pending: ${snapshot.fundingRequestPending ? "yes" : "no"}`,
        `Funding submitted: ${snapshot.confidentialFundingSubmitted ? "yes" : "no"}`,
        `Release request pending: ${snapshot.releaseRequestPending ? "yes" : "no"}`,
        `Encrypted delivery sent: ${snapshot.encryptedDeliverySent ? "yes" : "no"}`,
        `Encrypted delivery received: ${snapshot.encryptedDeliveryReceived ? "yes" : "no"}`,
        `Private delivery confirmed: ${snapshot.privateDeliveryConfirmed ? "yes" : "no"}`,
        `Umbra lifecycle pending: ${snapshot.umbraLifecyclePending ? "yes" : "no"}`,
        `Umbra lifecycle complete: ${snapshot.umbraLifecycleComplete ? "yes" : "no"}`,
        `Umbra lifecycle role: ${snapshot.umbraLifecycleRole ?? "none"}`,
        `Umbra lifecycle phases: ${
            snapshot.umbraLifecyclePhases.length > 0
                ? snapshot.umbraLifecyclePhases.join(",")
                : "none"
        }`,
        `Umbra final wallet: ${snapshot.umbraLifecycleFinalWallet ?? "none"}`,
        `Deal completed: ${snapshot.dealCompleted ? "yes" : "no"}`,
        `Last note: ${snapshot.lastNote ?? "none"}`,
        `Last error: ${snapshot.lastError ?? "none"}`,
        "",
        "Visible offers:",
        offers,
        "",
        `Recommended next action: ${next.action}`,
        `Why: ${next.reason}`,
    ].join("\n");
}

class DealTracker {
    private snapshot: AgentLoopSnapshot = createInitialSnapshot();

    reset(): void {
        this.snapshot = createInitialSnapshot();
    }

    update(patch: Partial<AgentLoopSnapshot>): AgentLoopSnapshot {
        this.snapshot = {
            ...this.snapshot,
            ...patch,
            updatedAt: nowIso(),
        };
        return this.getSnapshot();
    }

    noteAction(action: AgentLoopAction, reason: string): void {
        this.update({
            lastAction: action,
            lastReason: reason,
            lastNote: `${action}: ${reason}`,
            lastError: null,
        });
    }

    note(message: string): void {
        this.update({ lastNote: message });
    }

    noteError(message: string): void {
        this.update({ lastError: message, lastNote: `error: ${message}` });
    }

    getSnapshot(): AgentLoopSnapshot {
        return {
            ...this.snapshot,
            visibleOffers: [...this.snapshot.visibleOffers],
        };
    }

    getSummary(): string {
        return buildSnapshotSummary(this.snapshot);
    }

    getRecommendation(): AgentLoopDecision {
        return recommendNextAction(this.snapshot);
    }
}

export const dealTracker = new DealTracker();

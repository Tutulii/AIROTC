import { logger } from '../lib/logger';
import { getEscrowProgram, CONNECTION, ESCROW_PROGRAM_ID } from './program';
import { getIO } from '../ws/socket';
import { handleDealSuccess, handleDealCancel } from '../services/reputation.service';
import { webhookDealUpdate } from '../services/webhook.service';

let isListening = false;

// Bounded deduplication — evicts oldest entries when limit is reached
const MAX_PROCESSED_EVENTS = 10_000;
const processedEvents = new Set<string>();

function trackEvent(key: string): boolean {
    if (processedEvents.has(key)) return false; // already seen
    processedEvents.add(key);
    // Evict oldest entries when Set grows too large (Set preserves insertion order)
    if (processedEvents.size > MAX_PROCESSED_EVENTS) {
        const firstKey = processedEvents.values().next().value;
        if (firstKey) processedEvents.delete(firstKey);
    }
    return true; // new event
}

const handleEventBroadcast = async (eventName: string, eventObj: any, slot: number, signature: string) => {
    try {
        const key = `${signature}-${eventName}`;
        if (!trackEvent(key)) return; // deduplicated

        let mappedAction: string = "unknown";
        let dealId: string = eventObj.dealId ? eventObj.dealId.toString() : eventObj.deal?.toString();

        let actor: string = "";
        if (eventObj.actor) actor = eventObj.actor.toString();
        else if (eventObj.buyer) actor = eventObj.buyer.toString();
        else if (eventObj.seller) actor = eventObj.seller.toString();

        let amountStr: string | undefined;

        // Collect participant wallets for webhook dispatch
        const participantWallets: string[] = [];
        if (eventObj.buyer) participantWallets.push(eventObj.buyer.toString());
        if (eventObj.seller) participantWallets.push(eventObj.seller.toString());
        if (eventObj.middleman) participantWallets.push(eventObj.middleman.toString());

        if (eventName === "DealCreated") {
            mappedAction = "deal_created";
        } else if (eventName === "CollateralLockedEvent") {
            mappedAction = (eventObj.role as any)?.buyer ? "buyer_deposit" : "seller_deposit";
            amountStr = eventObj.amount?.toString();
        } else if (eventName === "PaymentLockedEvent") {
            mappedAction = "funded"; // or buyer_deposit if you track explicitly
            amountStr = eventObj.amount?.toString();
        } else if (eventName === "FundsReleased") {
            mappedAction = "released";
        } else if (eventName === "DealCancelled") {
            mappedAction = "cancelled";
        } else {
            return; // Ignore unrelated
        }

        const blockTime = await CONNECTION.getBlockTime(slot);
        const timestamp = blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString();

        if (!dealId) return;

        const payload = {
            dealId,
            event: mappedAction,
            actor: actor || "unknown",
            amount: amountStr,
            slot,
            signature,
            timestamp
        };

        // WebSocket push
        const io = getIO();
        io.to(`deal:${dealId}`).emit("deal_update", payload);

        // Webhook push (fire-and-forget)
        if (participantWallets.length > 0) {
            webhookDealUpdate({
                dealId,
                event: mappedAction,
                actor: actor || "unknown",
                amount: amountStr,
                signature,
                timestamp,
                participantWallets,
            });
        }

        logger.info(`[EVENT] ${mappedAction} → deal: ${dealId} → ${amountStr ? amountStr + ' lamports' : 'updated'} (sig: ${signature})`);

        // ── REPUTATION UPDATE ──
        // Trigger reputation calculation when deals complete or cancel
        if (mappedAction === 'released') {
            const buyerWallet = eventObj.buyer?.toString() || '';
            const sellerWallet = eventObj.seller?.toString() || '';
            if (buyerWallet && sellerWallet) {
                handleDealSuccess(dealId, buyerWallet, sellerWallet, amountStr || '0', 0)
                    .catch(e => logger.error("reputation_success_failed", {}, e));
            }
        } else if (mappedAction === 'cancelled') {
            const buyerWallet = eventObj.buyer?.toString() || '';
            const sellerWallet = eventObj.seller?.toString() || '';
            if (buyerWallet && sellerWallet) {
                handleDealCancel(dealId, buyerWallet, sellerWallet)
                    .catch(e => logger.error("reputation_cancel_failed", {}, e));
            }
        }
    } catch (e) {
        // Safe isolation, failures never crash
    }
};

export const initializeEventListener = () => {
    if (isListening) return;

    try {
        const program = getEscrowProgram();

        program.addEventListener("DealCreated", (evt, slot, sig) => handleEventBroadcast("DealCreated", evt, slot, sig));
        program.addEventListener("CollateralLockedEvent", (evt, slot, sig) => handleEventBroadcast("CollateralLockedEvent", evt, slot, sig));
        program.addEventListener("PaymentLockedEvent", (evt, slot, sig) => handleEventBroadcast("PaymentLockedEvent", evt, slot, sig));
        program.addEventListener("FundsReleased", (evt, slot, sig) => handleEventBroadcast("FundsReleased", evt, slot, sig));
        program.addEventListener("DealCancelled", (evt, slot, sig) => handleEventBroadcast("DealCancelled", evt, slot, sig));

        isListening = true;
        logger.info("info", { detail: { detail: `📡 Anchor Event Listener Mounted on Program: ${ESCROW_PROGRAM_ID.toBase58()}` } });

        // Fallback robustness mapper bypassing failed sockets via direct Logs evaluation
        CONNECTION.onLogs(ESCROW_PROGRAM_ID, async (logs, ctx) => {
            if (logs.err) return;
            const slot = ctx.slot;
            const signature = logs.signature;

            logs.logs.forEach(log => {
                if (log.startsWith("Program data: ")) {
                    try {
                        const encodedData = log.replace("Program data: ", "");
                        const event = program.coder.events.decode(encodedData);
                        if (event) {
                            handleEventBroadcast(event.name, event.data, slot, signature);
                        }
                    } catch (e) { }
                }
            });
        }, "confirmed");

    } catch (e) {
        logger.error("error");
    }
};

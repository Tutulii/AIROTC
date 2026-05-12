/**
 * Deterministic Deal Replay Tool (Level 5 Adversarial Hardening)
 *
 * Replays a deal's audit trail events in order and validates
 * that each state transition is legal according to the phase machine.
 *
 * Usage: npx ts-node scripts/replayDeal.ts --ticket <ticketId>
 *
 * This is used for:
 *   - Post-incident forensics
 *   - Dispute investigation
 *   - Proving deterministic behavior to auditors
 */

import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

const VALID_TRANSITIONS: Record<string, string[]> = {
    negotiation: ["escrow_created", "cancelled"],
    escrow_created: ["awaiting_deposits", "cancelled"],
    awaiting_deposits: ["delivery", "cancelled"],
    delivery: ["completed", "disputed", "cancelled"],
    disputed: ["completed", "cancelled", "refunded"],
    completed: [],
    cancelled: [],
    refunded: [],
};

async function replayDeal(ticketId: string): Promise<void> {
    console.log(`\n🔄 REPLAYING DEAL: ${ticketId}\n${"=".repeat(60)}`);

    // 1. Verify audit chain integrity
    const auditLogs = await prisma.auditLog.findMany({
        where: { ticketId },
        orderBy: { createdAt: "asc" },
    });

    if (auditLogs.length === 0) {
        console.log("❌ No audit logs found for this deal.");
        return;
    }

    console.log(`📋 Found ${auditLogs.length} audit entries\n`);

    let chainValid = true;
    let lastHash = "GENESIS";

    for (let i = 0; i < auditLogs.length; i++) {
        const log = auditLogs[i];
        const expectedHash = crypto
            .createHash("sha256")
            .update(`${lastHash}|${log.ticketId}|${log.event}|${log.data}`)
            .digest("hex");

        const hashMatch = log.hash === expectedHash;
        if (!hashMatch) {
            chainValid = false;
            console.log(`  ❌ HASH MISMATCH at entry ${i + 1}: ${log.event}`);
            console.log(`     Expected: ${expectedHash.substring(0, 16)}...`);
            console.log(`     Actual:   ${log.hash.substring(0, 16)}...`);
        } else {
            console.log(`  ✅ [${i + 1}] ${log.event} @ ${log.createdAt.toISOString()}`);
        }

        lastHash = log.hash;
    }

    console.log(`\n${"─".repeat(40)}`);
    console.log(`Hash chain: ${chainValid ? "✅ VALID" : "❌ TAMPERED"}`);

    // 2. Replay phase transitions
    console.log(`\n📊 PHASE TRANSITION REPLAY\n${"─".repeat(40)}`);

    const phaseState = await prisma.dealPhaseState.findUnique({ where: { ticketId } });
    if (!phaseState) {
        console.log("⚠️  No phase state found.");
    } else {
        let history: string[] = [];
        try {
            history = JSON.parse(phaseState.historyJson);
        } catch { }

        let transitionsValid = true;
        for (let i = 1; i < history.length; i++) {
            const from = history[i - 1];
            const to = history[i];
            const valid = VALID_TRANSITIONS[from]?.includes(to) ?? false;
            const mark = valid ? "✅" : "❌";
            console.log(`  ${mark} ${from} → ${to}`);
            if (!valid) transitionsValid = false;
        }

        console.log(`\n  Current phase: ${phaseState.phase}`);
        console.log(`  Transitions: ${transitionsValid ? "✅ ALL VALID" : "❌ ILLEGAL TRANSITION DETECTED"}`);
    }

    // 3. Transaction history
    console.log(`\n💰 TRANSACTIONS\n${"─".repeat(40)}`);

    const deal = await prisma.deal.findUnique({ where: { ticketId } });
    if (deal) {
        const txs = await prisma.transaction.findMany({
            where: { dealId: deal.id },
            orderBy: { createdAt: "asc" },
        });
        for (const tx of txs) {
            console.log(`  📝 ${tx.type} | ${tx.status} | ${tx.txSignature?.substring(0, 20)}...`);
        }
        if (txs.length === 0) console.log("  (none)");
    }

    // 4. Verdict
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🏁 REPLAY COMPLETE`);
    console.log(`   Chain integrity: ${chainValid ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`   Deal status: ${deal?.status || "unknown"}`);
    console.log(`${"=".repeat(60)}\n`);

    await prisma.$disconnect();
}

// CLI entry point
const args = process.argv.slice(2);
const ticketIdx = args.indexOf("--ticket");
if (ticketIdx < 0 || !args[ticketIdx + 1]) {
    console.error("Usage: npx ts-node scripts/replayDeal.ts --ticket <ticketId>");
    process.exit(1);
}

replayDeal(args[ticketIdx + 1]).catch((e) => {
    console.error("Replay failed:", e);
    process.exit(1);
});

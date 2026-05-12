import { calculateReputation } from '../src/utils/reputation';

console.log("=== RUNNING REPUTATION TESTS ===");

const score1 = calculateReputation({ totalDeals: 0, successfulDeals: 0, cancelledDeals: 0, disputedDeals: 0, totalVolume: "0", avgSettlementTime: 0 });
console.log("→ Case 1 (New Agent):", score1, "| Expected: 5\n");

const score2 = calculateReputation({ totalDeals: 10, successfulDeals: 10, cancelledDeals: 0, disputedDeals: 0, totalVolume: "5000", avgSettlementTime: 300 });
console.log("→ Case 2 (10 deals, low volume):", score2, "| Expected: Moderate (NOT high)\n");

const score3 = calculateReputation({ totalDeals: 50, successfulDeals: 48, cancelledDeals: 1, disputedDeals: 1, totalVolume: "10000000000", avgSettlementTime: 120 });
console.log("→ Case 3 (High success, High volume):", score3, "| Expected: High score (80+)\n");

const score4 = calculateReputation({ totalDeals: 10, successfulDeals: 5, cancelledDeals: 2, disputedDeals: 3, totalVolume: "1000000", avgSettlementTime: 600 });
console.log("→ Case 4 (High disputes):", score4, "| Expected: Strong penalty\n");

const score5a = calculateReputation({ totalDeals: 100, successfulDeals: 98, cancelledDeals: 2, disputedDeals: 0, totalVolume: "10000000", avgSettlementTime: 50 });
const score5b = calculateReputation({ totalDeals: 100, successfulDeals: 98, cancelledDeals: 2, disputedDeals: 0, totalVolume: "10000000", avgSettlementTime: 6000 });
console.log("→ Case 5 (Fast vs Slow): Fast=", score5a, "Slow=", score5b, "| Expected: Fast slightly higher\n");

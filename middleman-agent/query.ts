import { prisma } from './src/lib/prisma';
import { negotiationStore } from './src/state/negotiationStore';

async function main() {
  const t = "TCK-696EDB75";
  const history = await negotiationStore.getNegotiationHistory(t);

  console.log("HISTORY:");
  for (const h of history) {
    console.log(`[${h.proposedBy}] price=${h.proposedPrice} colBuy=${h.collateralBuyer} colSel=${h.collateralSeller} agree=${h.agreementScore}`);
  }

  const s = await negotiationStore.getLatestSignals(t);
  console.log("SIGNALS:");
  console.log(s);
}

main().then(() => process.exit(0));

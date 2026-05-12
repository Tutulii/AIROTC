import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function test() {
  const agent = await prisma.agent.create({
    data: {
      wallet: "test_wallet_123",
    },
  });

  console.log("[PRISMA TEST] Agent created:", agent);
}

test();

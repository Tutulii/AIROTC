-- CreateTable
CREATE TABLE "Negotiation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "proposedPrice" DOUBLE PRECISION,
    "collateralBuyer" DOUBLE PRECISION,
    "collateralSeller" DOUBLE PRECISION,
    "proposedBy" TEXT NOT NULL,
    "agreementScore" INTEGER NOT NULL,
    "rawText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Negotiation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Negotiation" ADD CONSTRAINT "Negotiation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

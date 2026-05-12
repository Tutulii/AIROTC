/*
  Warnings:

  - Added the required column `buyerId` to the `Deal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `middlemanId` to the `Deal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sellerId` to the `Deal` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "buyerId" TEXT NOT NULL,
ADD COLUMN     "middlemanId" TEXT NOT NULL,
ADD COLUMN     "sellerId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_middlemanId_fkey" FOREIGN KEY ("middlemanId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

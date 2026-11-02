-- AlterTable
ALTER TABLE "Job" ADD COLUMN "receiverAltEmail" TEXT,
ADD COLUMN "receiverAltPhone" TEXT,
ADD COLUMN "dgDocumentId" TEXT;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN "dgDocumentId" TEXT;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_dgDocumentId_fkey" FOREIGN KEY ("dgDocumentId") REFERENCES "ComplianceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_dgDocumentId_fkey" FOREIGN KEY ("dgDocumentId") REFERENCES "ComplianceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

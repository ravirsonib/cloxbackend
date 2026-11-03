-- AlterTable
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "receiverAltEmail" TEXT,
ADD COLUMN IF NOT EXISTS "receiverAltPhone" TEXT,
ADD COLUMN IF NOT EXISTS "dgDocumentId" TEXT;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN IF NOT EXISTS "dgDocumentId" TEXT;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_dgDocumentId_fkey'
  ) THEN
    ALTER TABLE "Job" ADD CONSTRAINT "Job_dgDocumentId_fkey" FOREIGN KEY ("dgDocumentId") REFERENCES "ComplianceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Proposal_dgDocumentId_fkey'
  ) THEN
    ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_dgDocumentId_fkey" FOREIGN KEY ("dgDocumentId") REFERENCES "ComplianceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;


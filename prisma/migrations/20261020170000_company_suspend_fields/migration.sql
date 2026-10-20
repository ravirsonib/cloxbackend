-- Soft-disable (suspend) metadata for Super Admin company disable
ALTER TABLE "Company" ADD COLUMN "statusBeforeSuspend" "CompanyStatus";
ALTER TABLE "Company" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "suspendedReason" TEXT;
ALTER TABLE "Company" ADD COLUMN "suspendedNote" TEXT;

CREATE INDEX "Company_suspendedAt_idx" ON "Company"("suspendedAt");

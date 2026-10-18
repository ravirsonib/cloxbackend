-- M2 compliance & documents

ALTER TYPE "CompanyStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "CompanyStatus" ADD VALUE 'INFO_REQUESTED';
ALTER TYPE "CompanyStatus" ADD VALUE 'PENDING_PAYMENT';
ALTER TYPE "CompanyStatus" ADD VALUE 'PENDING_COMPLIANCE_DOCS';
ALTER TYPE "CompanyStatus" ADD VALUE 'PENDING_SETTLEMENT_SETUP';
ALTER TYPE "CompanyStatus" ADD VALUE 'PENDING_FLEET_READINESS';
ALTER TYPE "CompanyStatus" ADD VALUE 'BID_ELIGIBLE';

ALTER TYPE "ComplianceDocType" ADD VALUE 'GOVERNMENT_ID';
ALTER TYPE "ComplianceDocType" ADD VALUE 'SELFIE';
ALTER TYPE "ComplianceDocType" ADD VALUE 'RWC';
ALTER TYPE "ComplianceDocType" ADD VALUE 'PUBLIC_LIABILITY';
ALTER TYPE "ComplianceDocType" ADD VALUE 'CARGO_INSURANCE';

ALTER TYPE "ComplianceDocStatus" ADD VALUE 'UPLOAD_PENDING';

CREATE TYPE "ComplianceCaseType" AS ENUM ('SENDER_KYB', 'SENDER_KYC', 'CARRIER_KYB');
CREATE TYPE "ComplianceCaseStatus" AS ENUM ('OPEN', 'INFO_REQUESTED', 'ESCALATED', 'APPROVED', 'REJECTED', 'CLOSED');

CREATE TABLE "ComplianceCase" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "caseType" "ComplianceCaseType" NOT NULL,
    "status" "ComplianceCaseStatus" NOT NULL DEFAULT 'OPEN',
    "regionId" TEXT,
    "submittedByUserId" TEXT,
    "assignedAdminId" TEXT,
    "decisionNote" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComplianceCase_status_createdAt_idx" ON "ComplianceCase"("status", "createdAt");
CREATE INDEX "ComplianceCase_companyId_status_idx" ON "ComplianceCase"("companyId", "status");
CREATE INDEX "ComplianceCase_regionId_status_idx" ON "ComplianceCase"("regionId", "status");
CREATE INDEX "ComplianceCase_caseType_status_idx" ON "ComplianceCase"("caseType", "status");

ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ComplianceDocument" ADD COLUMN "caseId" TEXT;
ALTER TABLE "ComplianceDocument" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "ComplianceDocument" ADD COLUMN "sizeBytes" INTEGER;
ALTER TABLE "ComplianceDocument" ADD COLUMN "originalFilename" TEXT;
ALTER TABLE "ComplianceDocument" ADD COLUMN "uploadedByUserId" TEXT;
ALTER TABLE "ComplianceDocument" ADD COLUMN "reviewNote" TEXT;

-- Default stays UPLOADED at DB level; app creates rows as UPLOAD_PENDING
-- (new enum values cannot be used as DEFAULT in the same transaction).

CREATE INDEX "ComplianceDocument_caseId_idx" ON "ComplianceDocument"("caseId");
CREATE INDEX "ComplianceDocument_status_expiresAt_idx" ON "ComplianceDocument"("status", "expiresAt");

ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "ComplianceCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

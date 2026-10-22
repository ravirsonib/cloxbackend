-- AlterEnum ComplianceCaseType
ALTER TYPE "ComplianceCaseType" ADD VALUE IF NOT EXISTS 'COMPANY_PROFILE_CHANGE';

-- AlterTable ComplianceCase
ALTER TABLE "ComplianceCase" ADD COLUMN IF NOT EXISTS "proposedChanges" JSONB;

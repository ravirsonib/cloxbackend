-- AlterEnum ComplianceDocType
ALTER TYPE "ComplianceDocType" ADD VALUE IF NOT EXISTS 'DG_LICENCE';

-- AlterEnum ComplianceCaseType
ALTER TYPE "ComplianceCaseType" ADD VALUE IF NOT EXISTS 'CARRIER_FLEET_RWC';

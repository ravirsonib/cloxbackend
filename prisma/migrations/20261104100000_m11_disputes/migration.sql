-- AlterEnum
ALTER TYPE "SurchargeStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "DisputeType" AS ENUM ('WAITING_SURCHARGE', 'MASS_SURCHARGE', 'DAMAGE', 'CANCELLATION', 'GENERAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "DisputeStatus" AS ENUM ('OPEN_TRIAGE', 'TRIAGED', 'ESCALATED_STATE', 'ESCALATED_SUPER', 'RESOLVED', 'REJECTED', 'CLOSED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "DisputeRuling" AS ENUM ('FAVOR_SENDER', 'FAVOR_CARRIER', 'SPLIT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "DisputeFinancialAdjustment" AS ENUM ('NONE', 'REFUND_SENDER', 'WAIVE_SURCHARGE', 'ADJUST_PAYOUT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Dispute" (
    "id" TEXT NOT NULL,
    "disputeNumber" TEXT NOT NULL,
    "type" "DisputeType" NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN_TRIAGE',
    "jobId" TEXT NOT NULL,
    "tripId" TEXT,
    "surchargeId" TEXT,
    "openedByUserId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "regionId" TEXT,
    "territoryId" TEXT,
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "disputedAmountCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contactedSender" BOOLEAN NOT NULL DEFAULT false,
    "contactedCarrier" BOOLEAN NOT NULL DEFAULT false,
    "evidenceComplete" BOOLEAN NOT NULL DEFAULT false,
    "triageNotes" TEXT,
    "triagedByAdminId" TEXT,
    "triagedAt" TIMESTAMP(3),
    "assignedAdminId" TEXT,
    "ruling" "DisputeRuling",
    "rulingNotes" TEXT,
    "resolvedByAdminId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "financialAdjustment" "DisputeFinancialAdjustment",
    "adjustmentAmountCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Dispute_disputeNumber_key" ON "Dispute"("disputeNumber");
CREATE INDEX IF NOT EXISTS "Dispute_jobId_idx" ON "Dispute"("jobId");
CREATE INDEX IF NOT EXISTS "Dispute_tripId_idx" ON "Dispute"("tripId");
CREATE INDEX IF NOT EXISTS "Dispute_surchargeId_idx" ON "Dispute"("surchargeId");
CREATE INDEX IF NOT EXISTS "Dispute_companyId_idx" ON "Dispute"("companyId");
CREATE INDEX IF NOT EXISTS "Dispute_regionId_status_idx" ON "Dispute"("regionId", "status");
CREATE INDEX IF NOT EXISTS "Dispute_territoryId_status_idx" ON "Dispute"("territoryId", "status");
CREATE INDEX IF NOT EXISTS "Dispute_status_idx" ON "Dispute"("status");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES "Surcharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedByUserId_fkey" FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "LocalTerritory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_triagedByAdminId_fkey" FOREIGN KEY ("triagedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolvedByAdminId_fkey" FOREIGN KEY ("resolvedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

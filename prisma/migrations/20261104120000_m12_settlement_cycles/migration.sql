-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SettlementCycleStatus') THEN
        CREATE TYPE "SettlementCycleStatus" AS ENUM ('OPEN', 'PROCESSING', 'COMPLETED', 'FAILED');
    END IF;
END $$;

-- AlterTable
ALTER TABLE "SettlementLine" ADD COLUMN IF NOT EXISTS "cycleId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SettlementCycle" (
    "id" TEXT NOT NULL,
    "cycleNumber" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "scheduledDisburseAt" TIMESTAMP(3) NOT NULL,
    "status" "SettlementCycleStatus" NOT NULL DEFAULT 'OPEN',
    "disbursedAt" TIMESTAMP(3),
    "totalAccruedCents" INTEGER NOT NULL DEFAULT 0,
    "totalDisbursedCents" INTEGER NOT NULL DEFAULT 0,
    "carrierPayoutCents" INTEGER NOT NULL DEFAULT 0,
    "adminPayoutCents" INTEGER NOT NULL DEFAULT 0,
    "hqHoldingCents" INTEGER NOT NULL DEFAULT 0,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SettlementCycle_cycleNumber_key" ON "SettlementCycle"("cycleNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SettlementCycle_status_idx" ON "SettlementCycle"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SettlementCycle_periodStart_periodEnd_idx" ON "SettlementCycle"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SettlementLine_cycleId_idx" ON "SettlementLine"("cycleId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SettlementLine_cycleId_fkey'
    ) THEN
        ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "SettlementCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

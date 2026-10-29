-- Per-admin Super/State/Local packages (Option 1 + A). Carrier stays 70%.

CREATE TABLE "AdminRevenueSplitPackage" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "superPercent" INTEGER NOT NULL,
    "statePercent" INTEGER NOT NULL,
    "localPercent" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRevenueSplitPackage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminRevenueSplitPackage_adminUserId_publishedAt_idx" ON "AdminRevenueSplitPackage"("adminUserId", "publishedAt");
CREATE INDEX "AdminRevenueSplitPackage_effectiveFrom_idx" ON "AdminRevenueSplitPackage"("effectiveFrom");

ALTER TABLE "AdminRevenueSplitPackage" ADD CONSTRAINT "AdminRevenueSplitPackage_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminRevenueSplitPackage" ADD CONSTRAINT "AdminRevenueSplitPackage_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SettlementLine" ADD COLUMN IF NOT EXISTS "adminPackageId" TEXT;

CREATE INDEX IF NOT EXISTS "SettlementLine_adminPackageId_idx" ON "SettlementLine"("adminPackageId");

ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_adminPackageId_fkey" FOREIGN KEY ("adminPackageId") REFERENCES "AdminRevenueSplitPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

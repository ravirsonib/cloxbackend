-- Dynamic revenue split (1A seat overrides + 2A carrier fixed 70%)

CREATE TYPE "RevenueSplitScopeType" AS ENUM ('REGION', 'TERRITORY');

CREATE TABLE "RevenueSplitOverride" (
    "id" TEXT NOT NULL,
    "scopeType" "RevenueSplitScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "superPercent" INTEGER NOT NULL,
    "statePercent" INTEGER NOT NULL,
    "localPercent" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueSplitOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RevenueSplitOverride_scopeType_scopeId_publishedAt_idx" ON "RevenueSplitOverride"("scopeType", "scopeId", "publishedAt");
CREATE INDEX "RevenueSplitOverride_effectiveFrom_idx" ON "RevenueSplitOverride"("effectiveFrom");

ALTER TABLE "RevenueSplitOverride" ADD CONSTRAINT "RevenueSplitOverride_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SettlementLine" ADD COLUMN IF NOT EXISTS "policyVersionId" TEXT;
ALTER TABLE "SettlementLine" ADD COLUMN IF NOT EXISTS "overrideId" TEXT;
ALTER TABLE "SettlementLine" ADD COLUMN IF NOT EXISTS "adminUserId" TEXT;

CREATE INDEX IF NOT EXISTS "SettlementLine_policyVersionId_idx" ON "SettlementLine"("policyVersionId");
CREATE INDEX IF NOT EXISTS "SettlementLine_overrideId_idx" ON "SettlementLine"("overrideId");
CREATE INDEX IF NOT EXISTS "SettlementLine_adminUserId_idx" ON "SettlementLine"("adminUserId");

ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "RevenueSplitOverride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed national default if missing (idempotent)
INSERT INTO "PolicyVersion" ("id", "key", "version", "payload", "publishedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       'revenue_split.v1',
       1,
       '{"carrierPercent":70,"superPercent":15,"statePercent":10,"localPercent":5,"notes":"Pilot default (G0)"}'::jsonb,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "PolicyVersion" WHERE "key" = 'revenue_split.v1' AND "version" = 1
);

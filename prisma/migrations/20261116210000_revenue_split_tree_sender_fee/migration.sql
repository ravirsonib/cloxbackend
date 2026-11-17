-- Sender platform fee + min CLOX floor on PlatformSettings
CREATE TYPE "SenderPlatformFeeMode" AS ENUM ('EXCLUSIVE', 'INCLUSIVE');

ALTER TABLE "PlatformSettings"
  ADD COLUMN IF NOT EXISTS "senderPlatformFeePercent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "senderPlatformFeeMode" "SenderPlatformFeeMode" NOT NULL DEFAULT 'EXCLUSIVE',
  ADD COLUMN IF NOT EXISTS "minPlatformPercent" INTEGER NOT NULL DEFAULT 10;

-- Per-carrier uplift
CREATE TABLE IF NOT EXISTS "CompanyRevenueUplift" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "bonusPercent" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "publishedBy" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyRevenueUplift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CompanyRevenueUplift_companyId_publishedAt_idx"
  ON "CompanyRevenueUplift"("companyId", "publishedAt");
CREATE INDEX IF NOT EXISTS "CompanyRevenueUplift_effectiveFrom_idx"
  ON "CompanyRevenueUplift"("effectiveFrom");

ALTER TABLE "CompanyRevenueUplift"
  ADD CONSTRAINT "CompanyRevenueUplift_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyRevenueUplift"
  ADD CONSTRAINT "CompanyRevenueUplift_publishedBy_fkey"
  FOREIGN KEY ("publishedBy") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-sender fee override
CREATE TABLE IF NOT EXISTS "CompanySenderFeeOverride" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "feePercent" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "publishedBy" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanySenderFeeOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CompanySenderFeeOverride_companyId_publishedAt_idx"
  ON "CompanySenderFeeOverride"("companyId", "publishedAt");
CREATE INDEX IF NOT EXISTS "CompanySenderFeeOverride_effectiveFrom_idx"
  ON "CompanySenderFeeOverride"("effectiveFrom");

ALTER TABLE "CompanySenderFeeOverride"
  ADD CONSTRAINT "CompanySenderFeeOverride_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanySenderFeeOverride"
  ADD CONSTRAINT "CompanySenderFeeOverride_publishedBy_fkey"
  FOREIGN KEY ("publishedBy") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Convert existing admin packages from absolute % of gross → % of CLOX pool (sum 100).
-- Only rewrite rows whose three shares sum to something other than 100 (legacy absolute).
UPDATE "AdminRevenueSplitPackage" AS pkg
SET
  "superPercent" = CASE
    WHEN (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") = 0 THEN 100
    WHEN (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") = 100 THEN pkg."superPercent"
    ELSE ROUND(pkg."superPercent"::numeric * 100 / (pkg."superPercent" + pkg."statePercent" + pkg."localPercent"))::integer
  END,
  "statePercent" = CASE
    WHEN (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") = 0 THEN 0
    WHEN (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") = 100 THEN pkg."statePercent"
    ELSE ROUND(pkg."statePercent"::numeric * 100 / (pkg."superPercent" + pkg."statePercent" + pkg."localPercent"))::integer
  END,
  "localPercent" = CASE
    WHEN (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") = 0 THEN 0
    WHEN (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") = 100 THEN pkg."localPercent"
    ELSE (
      100
      - ROUND(pkg."superPercent"::numeric * 100 / (pkg."superPercent" + pkg."statePercent" + pkg."localPercent"))::integer
      - ROUND(pkg."statePercent"::numeric * 100 / (pkg."superPercent" + pkg."statePercent" + pkg."localPercent"))::integer
    )
  END
WHERE (pkg."superPercent" + pkg."statePercent" + pkg."localPercent") <> 100;

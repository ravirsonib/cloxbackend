-- AlterEnum TripExceptionStatus
ALTER TYPE "TripExceptionStatus" ADD VALUE IF NOT EXISTS 'RESOLVED_RELISTED';

-- AlterTable Company
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "reliabilityScore" INTEGER NOT NULL DEFAULT 100;

-- AlterTable Driver
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "reliabilityScore" INTEGER NOT NULL DEFAULT 100;

-- AlterTable Job
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "marketplacePriority" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "rescueDiscountPercent" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "rescuedFromExceptionId" TEXT;

CREATE INDEX IF NOT EXISTS "Job_marketplacePriority_status_publishedAt_idx"
  ON "Job"("marketplacePriority", "status", "publishedAt");

-- CreateTable PlatformSettings
CREATE TABLE IF NOT EXISTS "PlatformSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "rescueDiscountPercent" INTEGER NOT NULL DEFAULT 10,
  "marketplaceRelistSlaMs" INTEGER NOT NULL DEFAULT 300000,
  "driverUnavailableScoreDelta" INTEGER NOT NULL DEFAULT 5,
  "carrierMarketplaceReleaseScoreDelta" INTEGER NOT NULL DEFAULT 10,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PlatformSettings" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;

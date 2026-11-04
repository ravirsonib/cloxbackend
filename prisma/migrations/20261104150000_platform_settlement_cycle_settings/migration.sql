-- AlterTable PlatformSettings to add dynamic settlement cycle cadence and cutoff hour
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "settlementCycleCadenceDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "settlementCutoffHour" INTEGER NOT NULL DEFAULT 4;

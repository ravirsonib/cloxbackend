-- NHVR EWD / fatigue fields on Driver + EWD tables (schema was ahead of migrations).

-- CreateEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FatigueScheme') THEN
        CREATE TYPE "FatigueScheme" AS ENUM ('STANDARD', 'BFM', 'AFM');
    END IF;
END $$;

-- CreateEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EwdActivityType') THEN
        CREATE TYPE "EwdActivityType" AS ENUM ('REST', 'WORK');
    END IF;
END $$;

-- CreateEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EwdBreachSeverity') THEN
        CREATE TYPE "EwdBreachSeverity" AS ENUM ('MINOR', 'SUBSTANTIAL', 'SEVERE', 'CRITICAL');
    END IF;
END $$;

-- CreateEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DailySheetStatus') THEN
        CREATE TYPE "DailySheetStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'VERIFIED');
    END IF;
END $$;

-- AlterTable Driver
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "baseTimezone" TEXT DEFAULT 'Australia/Sydney';
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "fatigueScheme" "FatigueScheme" NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "bfmAccreditationNumber" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "EwdWorkRestRecord" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "activity" "EwdActivityType" NOT NULL,
    "workType" TEXT DEFAULT 'DRIVING',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "odometerStart" INTEGER,
    "odometerEnd" INTEGER,
    "locationStart" TEXT,
    "locationEnd" TEXT,
    "latStart" DOUBLE PRECISION,
    "lngStart" DOUBLE PRECISION,
    "latEnd" DOUBLE PRECISION,
    "lngEnd" DOUBLE PRECISION,
    "vehicleRego" TEXT,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "editReason" TEXT,
    "originalRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EwdWorkRestRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EwdDailySheet" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "totalWorkMinutes" INTEGER NOT NULL DEFAULT 0,
    "totalRestMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" "DailySheetStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "driverSignature" TEXT,
    "signedAt" TIMESTAMP(3),
    "declarationText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EwdDailySheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EwdBreachRecord" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "severity" "EwdBreachSeverity" NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "actualMinutes" INTEGER NOT NULL,
    "allowableMinutes" INTEGER NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EwdBreachRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EwdRoadsideSession" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "accessPin" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "accessedCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EwdRoadsideSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EwdWorkRestRecord_driverId_startTime_idx" ON "EwdWorkRestRecord"("driverId", "startTime");

CREATE INDEX IF NOT EXISTS "EwdDailySheet_driverId_date_idx" ON "EwdDailySheet"("driverId", "date");

CREATE UNIQUE INDEX IF NOT EXISTS "EwdDailySheet_driverId_date_key" ON "EwdDailySheet"("driverId", "date");

CREATE INDEX IF NOT EXISTS "EwdBreachRecord_driverId_detectedAt_idx" ON "EwdBreachRecord"("driverId", "detectedAt");

CREATE INDEX IF NOT EXISTS "EwdRoadsideSession_accessPin_isActive_idx" ON "EwdRoadsideSession"("accessPin", "isActive");

CREATE INDEX IF NOT EXISTS "EwdRoadsideSession_driverId_expiresAt_idx" ON "EwdRoadsideSession"("driverId", "expiresAt");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EwdWorkRestRecord_driverId_fkey') THEN
        ALTER TABLE "EwdWorkRestRecord" ADD CONSTRAINT "EwdWorkRestRecord_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EwdDailySheet_driverId_fkey') THEN
        ALTER TABLE "EwdDailySheet" ADD CONSTRAINT "EwdDailySheet_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EwdBreachRecord_driverId_fkey') THEN
        ALTER TABLE "EwdBreachRecord" ADD CONSTRAINT "EwdBreachRecord_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EwdRoadsideSession_driverId_fkey') THEN
        ALTER TABLE "EwdRoadsideSession" ADD CONSTRAINT "EwdRoadsideSession_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

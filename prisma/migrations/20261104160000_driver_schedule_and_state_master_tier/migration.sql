-- CreateEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DriverAvailabilityType') THEN
        CREATE TYPE "DriverAvailabilityType" AS ENUM ('ANNUAL_LEAVE', 'MEDICAL_LEAVE', 'ROSTERED_OFF', 'PERSONAL', 'OVERTIME_AVAILABLE');
    END IF;
END $$;

-- CreateEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DriverScheduleStatus') THEN
        CREATE TYPE "DriverScheduleStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
    END IF;
END $$;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "enableStateMasterTier" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DriverScheduleEntry" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "DriverAvailabilityType" NOT NULL DEFAULT 'ROSTERED_OFF',
    "status" "DriverScheduleStatus" NOT NULL DEFAULT 'APPROVED',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverScheduleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DriverScheduleEntry_driverId_status_startAt_endAt_idx" ON "DriverScheduleEntry"("driverId", "status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DriverScheduleEntry_companyId_startAt_endAt_idx" ON "DriverScheduleEntry"("companyId", "startAt", "endAt");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DriverScheduleEntry_driverId_fkey') THEN
        ALTER TABLE "DriverScheduleEntry" ADD CONSTRAINT "DriverScheduleEntry_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DriverScheduleEntry_companyId_fkey') THEN
        ALTER TABLE "DriverScheduleEntry" ADD CONSTRAINT "DriverScheduleEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DriverScheduleEntry_createdById_fkey') THEN
        ALTER TABLE "DriverScheduleEntry" ADD CONSTRAINT "DriverScheduleEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DriverScheduleEntry_reviewedById_fkey') THEN
        ALTER TABLE "DriverScheduleEntry" ADD CONSTRAINT "DriverScheduleEntry_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

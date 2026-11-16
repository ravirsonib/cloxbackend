-- Fleet+ management: MAINTENANCE status, entitlements, cost profiles, logs, work orders

-- AlterEnum VehicleStatus
ALTER TYPE "VehicleStatus" ADD VALUE IF NOT EXISTS 'MAINTENANCE';

-- CreateEnum
CREATE TYPE "FleetPlusTier" AS ENUM ('FREE_TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE');
CREATE TYPE "FleetPlusStatus" AS ENUM ('NONE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE "VehicleCostProfileUnit" AS ENUM ('PER_KM', 'PER_HR');
CREATE TYPE "VehicleCostKind" AS ENUM ('FUEL', 'WAGE', 'TOLL', 'MAINTENANCE', 'OTHER');
CREATE TYPE "VehicleMaintenanceCause" AS ENUM ('RWC_EXPIRED', 'SERVICE_INTERVAL', 'SAFETY_FAIL', 'MANUAL');
CREATE TYPE "VehicleFuelLogSource" AS ENUM ('MANUAL', 'TRIP_ODOMETER', 'TELEMATICS_STUB');

-- AlterTable Vehicle (Fleet+ cost / service profile)
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "fuelType" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "serviceIntervalKm" INTEGER;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "lastServiceOdometerKm" INTEGER;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "maintenanceRatePerKm" DECIMAL(12,4);
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "costProfileUnit" "VehicleCostProfileUnit";
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "costProfileRate" DECIMAL(12,4);
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "purchasePriceAud" DECIMAL(14,2);
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "residualValueAud" DECIMAL(14,2);
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "lifecycleMonths" INTEGER;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "maintenanceCause" "VehicleMaintenanceCause";
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "maintenanceStartedAt" TIMESTAMP(3);

-- CreateTable CompanyFleetPlus
CREATE TABLE IF NOT EXISTS "CompanyFleetPlus" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tier" "FleetPlusTier" NOT NULL DEFAULT 'FREE_TRIAL',
    "status" "FleetPlusStatus" NOT NULL DEFAULT 'NONE',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "stripeSubscriptionId" TEXT,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyFleetPlus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFleetPlus_companyId_key" ON "CompanyFleetPlus"("companyId");

ALTER TABLE "CompanyFleetPlus"
  DROP CONSTRAINT IF EXISTS "CompanyFleetPlus_companyId_fkey";
ALTER TABLE "CompanyFleetPlus"
  ADD CONSTRAINT "CompanyFleetPlus_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable VehicleFuelLog
CREATE TABLE IF NOT EXISTS "VehicleFuelLog" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "liters" DECIMAL(12,3) NOT NULL,
    "amountAud" DECIMAL(14,2) NOT NULL,
    "odometerKm" INTEGER,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "VehicleFuelLogSource" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleFuelLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VehicleFuelLog_vehicleId_loggedAt_idx" ON "VehicleFuelLog"("vehicleId", "loggedAt");
CREATE INDEX IF NOT EXISTS "VehicleFuelLog_companyId_loggedAt_idx" ON "VehicleFuelLog"("companyId", "loggedAt");

ALTER TABLE "VehicleFuelLog"
  DROP CONSTRAINT IF EXISTS "VehicleFuelLog_vehicleId_fkey";
ALTER TABLE "VehicleFuelLog"
  ADD CONSTRAINT "VehicleFuelLog_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VehicleFuelLog"
  DROP CONSTRAINT IF EXISTS "VehicleFuelLog_companyId_fkey";
ALTER TABLE "VehicleFuelLog"
  ADD CONSTRAINT "VehicleFuelLog_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable VehicleCostEntry
CREATE TABLE IF NOT EXISTS "VehicleCostEntry" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "VehicleCostKind" NOT NULL,
    "amountAud" DECIMAL(14,2) NOT NULL,
    "tripId" TEXT,
    "notes" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleCostEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VehicleCostEntry_vehicleId_loggedAt_idx" ON "VehicleCostEntry"("vehicleId", "loggedAt");
CREATE INDEX IF NOT EXISTS "VehicleCostEntry_companyId_loggedAt_idx" ON "VehicleCostEntry"("companyId", "loggedAt");
CREATE INDEX IF NOT EXISTS "VehicleCostEntry_tripId_idx" ON "VehicleCostEntry"("tripId");

ALTER TABLE "VehicleCostEntry"
  DROP CONSTRAINT IF EXISTS "VehicleCostEntry_vehicleId_fkey";
ALTER TABLE "VehicleCostEntry"
  ADD CONSTRAINT "VehicleCostEntry_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VehicleCostEntry"
  DROP CONSTRAINT IF EXISTS "VehicleCostEntry_companyId_fkey";
ALTER TABLE "VehicleCostEntry"
  ADD CONSTRAINT "VehicleCostEntry_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable VehicleMaintenanceWorkOrder
CREATE TABLE IF NOT EXISTS "VehicleMaintenanceWorkOrder" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cause" "VehicleMaintenanceCause" NOT NULL,
    "notes" TEXT,
    "tripId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleMaintenanceWorkOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VehicleMaintenanceWorkOrder_vehicleId_openedAt_idx" ON "VehicleMaintenanceWorkOrder"("vehicleId", "openedAt");
CREATE INDEX IF NOT EXISTS "VehicleMaintenanceWorkOrder_companyId_clearedAt_idx" ON "VehicleMaintenanceWorkOrder"("companyId", "clearedAt");

ALTER TABLE "VehicleMaintenanceWorkOrder"
  DROP CONSTRAINT IF EXISTS "VehicleMaintenanceWorkOrder_vehicleId_fkey";
ALTER TABLE "VehicleMaintenanceWorkOrder"
  ADD CONSTRAINT "VehicleMaintenanceWorkOrder_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VehicleMaintenanceWorkOrder"
  DROP CONSTRAINT IF EXISTS "VehicleMaintenanceWorkOrder_companyId_fkey";
ALTER TABLE "VehicleMaintenanceWorkOrder"
  ADD CONSTRAINT "VehicleMaintenanceWorkOrder_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

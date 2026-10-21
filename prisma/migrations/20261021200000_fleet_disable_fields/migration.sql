-- Carrier fleet/driver disable metadata (reason + note)
ALTER TABLE "Vehicle" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Vehicle" ADD COLUMN "disabledReason" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "disabledNote" TEXT;

ALTER TABLE "Driver" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN "disabledReason" TEXT;
ALTER TABLE "Driver" ADD COLUMN "disabledNote" TEXT;

-- AlterTable Driver — personal / emergency + AU residential address
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "emergencyContactName" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "emergencyContactPhone" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "addressLine1" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "suburb" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "postcode" TEXT;

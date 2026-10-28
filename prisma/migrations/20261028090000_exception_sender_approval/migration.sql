-- AlterEnum TripExceptionStatus
ALTER TYPE "TripExceptionStatus" ADD VALUE IF NOT EXISTS 'AWAITING_SENDER_APPROVAL';

-- AlterTable TripException — propose-then-commit replacement fields
ALTER TABLE "TripException" ADD COLUMN IF NOT EXISTS "proposedVehicleId" TEXT;
ALTER TABLE "TripException" ADD COLUMN IF NOT EXISTS "proposedDriverId" TEXT;
ALTER TABLE "TripException" ADD COLUMN IF NOT EXISTS "proposedAt" TIMESTAMP(3);
ALTER TABLE "TripException" ADD COLUMN IF NOT EXISTS "proposedByUserId" TEXT;

DO $$ BEGIN
  ALTER TABLE "TripException"
    ADD CONSTRAINT "TripException_proposedVehicleId_fkey"
    FOREIGN KEY ("proposedVehicleId") REFERENCES "Vehicle"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TripException"
    ADD CONSTRAINT "TripException_proposedDriverId_fkey"
    FOREIGN KEY ("proposedDriverId") REFERENCES "Driver"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

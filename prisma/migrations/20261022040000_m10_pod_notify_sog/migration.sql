-- M10: per-stop approaching / AT_DROPOFF notify + driver-SOG POD fields
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "approachingNotifiedAt" TIMESTAMP(3);
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "approachingSource" TEXT;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "atDropoffNotifiedAt" TIMESTAMP(3);
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "podStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "signedAt" TIMESTAMP(3);
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "signerName" TEXT;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "signatureStorageKey" TEXT;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "signatureContentHash" TEXT;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "receiverPresentAttested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "goodsPhotoRefs" JSONB;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "podFinalizedAt" TIMESTAMP(3);
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "podPackageStorageKey" TEXT;
ALTER TABLE "TripStopProgress" ADD COLUMN IF NOT EXISTS "signaturePdfStorageKey" TEXT;

CREATE INDEX IF NOT EXISTS "TripStopProgress_podStatus_idx" ON "TripStopProgress"("podStatus");

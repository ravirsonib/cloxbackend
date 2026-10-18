-- M5 driver onboarding: licence fields + invite token

ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "licenceClass" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "licenceExpiry" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "nhvrAcknowledgedAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "inviteTokenHash" TEXT;
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "inviteExpiresAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "inviteAcceptedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Driver_inviteTokenHash_idx" ON "Driver"("inviteTokenHash");

-- Allow orphan drivers (no company) for assignability gate
ALTER TABLE "Driver" ALTER COLUMN "companyId" DROP NOT NULL;

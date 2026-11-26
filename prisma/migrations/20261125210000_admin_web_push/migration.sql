-- Phase 4: Extend PushDevice, NotificationPreference, and PushDelivery for Ops AdminUser (Web PWA Push).

ALTER TABLE "PushDevice" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "PushDevice" ADD COLUMN "adminUserId" TEXT;

ALTER TABLE "NotificationPreference" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "NotificationPreference" ADD COLUMN "adminUserId" TEXT;

ALTER TABLE "PushDelivery" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "PushDelivery" ADD COLUMN "adminUserId" TEXT;

CREATE INDEX "PushDevice_adminUserId_isActive_idx" ON "PushDevice"("adminUserId", "isActive");
CREATE INDEX "PushDevice_adminUserId_deviceId_idx" ON "PushDevice"("adminUserId", "deviceId");

CREATE UNIQUE INDEX "NotificationPreference_adminUserId_key" ON "NotificationPreference"("adminUserId");

CREATE INDEX "PushDelivery_adminUserId_createdAt_idx" ON "PushDelivery"("adminUserId", "createdAt");

ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

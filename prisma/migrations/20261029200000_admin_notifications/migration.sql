-- AlterEnum: Ops inbox types (Phase A)
ALTER TYPE "NotificationType" ADD VALUE 'COMPLIANCE_CASE_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'COMPLIANCE_CASE_RESUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_PARTNER_KYB_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'COMPLIANCE_ESCALATED';
ALTER TYPE "NotificationType" ADD VALUE 'TRIP_EXCEPTION_ESCALATED';
ALTER TYPE "NotificationType" ADD VALUE 'FLEET_RWC_REVIEW_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'DRIVER_LICENCE_REVIEW_OPENED';

-- AlterTable: polymorphic recipient (marketplace User XOR AdminUser)
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "Notification" ADD COLUMN "adminUserId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "regionId" TEXT;

CREATE INDEX "Notification_adminUserId_readAt_createdAt_idx" ON "Notification"("adminUserId", "readAt", "createdAt");
CREATE INDEX "Notification_adminUserId_createdAt_idx" ON "Notification"("adminUserId", "createdAt");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

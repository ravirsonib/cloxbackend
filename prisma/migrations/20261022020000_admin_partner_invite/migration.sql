-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('INVITED', 'PENDING_DOCS', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- AlterEnum
ALTER TYPE "CompanyType" ADD VALUE 'ADMIN_PARTNER';

-- AlterEnum
ALTER TYPE "ComplianceDocType" ADD VALUE 'MASTER_ADMIN_AGREEMENT';

-- AlterEnum
ALTER TYPE "ComplianceCaseType" ADD VALUE 'ADMIN_PARTNER_KYB';

-- AlterTable AdminUser
ALTER TABLE "AdminUser" ADD COLUMN "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "AdminUser" ADD COLUMN "phone" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "companyId" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "leadId" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "inviteTokenHash" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "inviteExpiresAt" TIMESTAMP(3);
ALTER TABLE "AdminUser" ADD COLUMN "inviteAcceptedAt" TIMESTAMP(3);
ALTER TABLE "AdminUser" ADD COLUMN "declarationAccuracy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminUser" ADD COLUMN "declarationNda" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminUser" ADD COLUMN "declarationNonCompete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminUser" ADD COLUMN "profileJson" JSONB;

-- Backfill: inactive admins → SUSPENDED; active stay ACTIVE (default)
UPDATE "AdminUser" SET "status" = 'SUSPENDED' WHERE "active" = false;

-- CreateIndex
CREATE INDEX "AdminUser_companyId_idx" ON "AdminUser"("companyId");
CREATE INDEX "AdminUser_status_idx" ON "AdminUser"("status");
CREATE INDEX "AdminUser_inviteTokenHash_idx" ON "AdminUser"("inviteTokenHash");
CREATE INDEX "AdminUser_leadId_idx" ON "AdminUser"("leadId");

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

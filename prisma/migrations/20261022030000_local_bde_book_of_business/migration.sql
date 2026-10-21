-- Local BDE book of business: company attribution, invites, prospects

CREATE TYPE "ProspectStage" AS ENUM ('LEAD', 'CONTACTED', 'INVITED', 'ONBOARDING', 'WON', 'LOST');

ALTER TABLE "Company" ADD COLUMN "referredByAdminUserId" TEXT;
ALTER TABLE "Company" ADD COLUMN "referredAt" TIMESTAMP(3);

CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "ownerAdminUserId" TEXT NOT NULL,
    "companyType" "CompanyType" NOT NULL,
    "legalName" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "stage" "ProspectStage" NOT NULL DEFAULT 'LEAD',
    "notes" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompanyInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedByAdminUserId" TEXT NOT NULL,
    "companyType" "CompanyType" NOT NULL,
    "email" TEXT NOT NULL,
    "legalNameHint" TEXT,
    "homeRegionId" TEXT,
    "localTerritoryId" TEXT,
    "prospectId" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyInvite_tokenHash_key" ON "CompanyInvite"("tokenHash");
CREATE INDEX "Company_referredByAdminUserId_idx" ON "Company"("referredByAdminUserId");
CREATE INDEX "Prospect_ownerAdminUserId_stage_createdAt_idx" ON "Prospect"("ownerAdminUserId", "stage", "createdAt");
CREATE INDEX "Prospect_companyId_idx" ON "Prospect"("companyId");
CREATE INDEX "Prospect_email_idx" ON "Prospect"("email");
CREATE INDEX "CompanyInvite_invitedByAdminUserId_createdAt_idx" ON "CompanyInvite"("invitedByAdminUserId", "createdAt");
CREATE INDEX "CompanyInvite_email_idx" ON "CompanyInvite"("email");
CREATE INDEX "CompanyInvite_prospectId_idx" ON "CompanyInvite"("prospectId");
CREATE INDEX "CompanyInvite_companyId_idx" ON "CompanyInvite"("companyId");

ALTER TABLE "Company" ADD CONSTRAINT "Company_referredByAdminUserId_fkey" FOREIGN KEY ("referredByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_ownerAdminUserId_fkey" FOREIGN KEY ("ownerAdminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CompanyInvite" ADD CONSTRAINT "CompanyInvite_invitedByAdminUserId_fkey" FOREIGN KEY ("invitedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyInvite" ADD CONSTRAINT "CompanyInvite_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CompanyInvite" ADD CONSTRAINT "CompanyInvite_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

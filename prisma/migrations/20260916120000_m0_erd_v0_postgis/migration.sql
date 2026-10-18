-- M0 ERD v0 + PostGIS

CREATE EXTENSION IF NOT EXISTS postgis;

-- AlterEnum
ALTER TYPE "AdminRole" ADD VALUE 'STATE_MASTER';
ALTER TYPE "AdminRole" ADD VALUE 'LOCAL_BDE';

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SENDER', 'TRANSPORT_COMPANY', 'DRIVER');
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE "CompanyType" AS ENUM ('SENDER', 'CARRIER');
CREATE TYPE "CompanyStatus" AS ENUM ('DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'REJECTED');
CREATE TYPE "AdminScopeType" AS ENUM ('STATE', 'LOCAL');
CREATE TYPE "VehicleStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'RETIRED');
CREATE TYPE "DriverStatus" AS ENUM ('INVITED', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE "ComplianceDocType" AS ENUM ('ABN_EXTRACT', 'DRIVER_LICENCE', 'VEHICLE_REGO', 'INSURANCE', 'NHVR', 'OTHER');
CREATE TYPE "ComplianceDocStatus" AS ENUM ('UPLOADED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'BIDDING', 'ASSIGNED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "JobPricingModel" AS ENUM ('PER_KM', 'HOURLY');
CREATE TYPE "ProposalStatus" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'ACCEPTED', 'REJECTED', 'EXPIRED');
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'LOCKED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "TripStatus" AS ENUM ('PENDING_GATES', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'IN_TRANSIT', 'AT_DROPOFF', 'COMPLETED', 'CANCELLED', 'BREAKDOWN');
CREATE TYPE "PaymentEventType" AS ENUM ('CHARGE', 'REFUND', 'TRANSFER', 'TRANSFER_REVERSAL', 'ADJUSTMENT');
CREATE TYPE "PaymentEventStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "SettlementRecipientType" AS ENUM ('CARRIER', 'SUPER_ADMIN', 'STATE_MASTER', 'LOCAL_BDE', 'HQ_HOLDING');
CREATE TYPE "SettlementLineStatus" AS ENUM ('ACCRUED', 'PAYABLE', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LocalTerritory" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LocalTerritory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminScope" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "scopeType" "AdminScopeType" NOT NULL,
    "regionId" TEXT,
    "localTerritoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminScope_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" "PlatformRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "name" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "type" "CompanyType" NOT NULL,
    "status" "CompanyStatus" NOT NULL DEFAULT 'DRAFT',
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "abn" TEXT,
    "acn" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "homeRegionId" TEXT,
    "stripeCustomerId" TEXT,
    "stripeConnectAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "VehicleStatus" NOT NULL DEFAULT 'DRAFT',
    "label" TEXT,
    "registration" TEXT,
    "vehicleClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'INVITED',
    "licenceNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplianceDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "docType" "ComplianceDocType" NOT NULL,
    "status" "ComplianceDocStatus" NOT NULL DEFAULT 'UPLOADED',
    "storageKey" TEXT,
    "contentHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "senderCompanyId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "pricingModel" "JobPricingModel" NOT NULL,
    "originRegionId" TEXT,
    "originTerritoryId" TEXT,
    "estimateExGstCents" INTEGER,
    "estimateGstCents" INTEGER,
    "estimateIncGstCents" INTEGER,
    "receiverName" TEXT,
    "receiverEmail" TEXT,
    "receiverPhone" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobStop" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stopType" TEXT NOT NULL,
    "label" TEXT,
    "addressLine" TEXT,
    "suburb" TEXT,
    "state" TEXT,
    "postcode" TEXT,
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobStop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "carrierCompanyId" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'SUBMITTED',
    "amountExGstCents" INTEGER NOT NULL,
    "amountGstCents" INTEGER NOT NULL,
    "amountIncGstCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "carrierCompanyId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'PENDING_GATES',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "podStorageKey" TEXT,
    "podCapturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "type" "PaymentEventType" NOT NULL,
    "status" "PaymentEventStatus" NOT NULL DEFAULT 'PENDING',
    "amountExGstCents" INTEGER NOT NULL,
    "amountGstCents" INTEGER NOT NULL,
    "amountIncGstCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "stripePaymentIntentId" TEXT,
    "stripeTransferId" TEXT,
    "stripeRefundId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SettlementLine" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "recipientType" "SettlementRecipientType" NOT NULL,
    "sharePercent" INTEGER,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "status" "SettlementLineStatus" NOT NULL DEFAULT 'ACCRUED',
    "regionId" TEXT,
    "territoryId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorAdminId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "correlationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- Indexes & uniques
CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");
CREATE UNIQUE INDEX "LocalTerritory_regionId_code_key" ON "LocalTerritory"("regionId", "code");
CREATE INDEX "LocalTerritory_regionId_idx" ON "LocalTerritory"("regionId");
CREATE INDEX "AdminScope_adminUserId_idx" ON "AdminScope"("adminUserId");
CREATE INDEX "AdminScope_regionId_idx" ON "AdminScope"("regionId");
CREATE INDEX "AdminScope_localTerritoryId_idx" ON "AdminScope"("localTerritoryId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_companyId_idx" ON "User"("companyId");
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");
CREATE INDEX "Company_type_status_idx" ON "Company"("type", "status");
CREATE INDEX "Company_abn_idx" ON "Company"("abn");
CREATE INDEX "Company_homeRegionId_idx" ON "Company"("homeRegionId");
CREATE INDEX "Vehicle_companyId_status_idx" ON "Vehicle"("companyId", "status");
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");
CREATE INDEX "Driver_companyId_status_idx" ON "Driver"("companyId", "status");
CREATE INDEX "ComplianceDocument_companyId_status_idx" ON "ComplianceDocument"("companyId", "status");
CREATE INDEX "ComplianceDocument_vehicleId_idx" ON "ComplianceDocument"("vehicleId");
CREATE INDEX "ComplianceDocument_driverId_idx" ON "ComplianceDocument"("driverId");
CREATE INDEX "ComplianceDocument_expiresAt_idx" ON "ComplianceDocument"("expiresAt");
CREATE INDEX "Job_senderCompanyId_status_idx" ON "Job"("senderCompanyId", "status");
CREATE INDEX "Job_originRegionId_idx" ON "Job"("originRegionId");
CREATE INDEX "Job_status_publishedAt_idx" ON "Job"("status", "publishedAt");
CREATE UNIQUE INDEX "JobStop_jobId_sequence_key" ON "JobStop"("jobId", "sequence");
CREATE INDEX "JobStop_jobId_idx" ON "JobStop"("jobId");
CREATE INDEX "Proposal_jobId_status_idx" ON "Proposal"("jobId", "status");
CREATE INDEX "Proposal_carrierCompanyId_status_idx" ON "Proposal"("carrierCompanyId", "status");
CREATE UNIQUE INDEX "Assignment_jobId_key" ON "Assignment"("jobId");
CREATE UNIQUE INDEX "Assignment_proposalId_key" ON "Assignment"("proposalId");
CREATE INDEX "Assignment_carrierCompanyId_status_idx" ON "Assignment"("carrierCompanyId", "status");
CREATE INDEX "Assignment_driverId_idx" ON "Assignment"("driverId");
CREATE INDEX "Assignment_vehicleId_idx" ON "Assignment"("vehicleId");
CREATE UNIQUE INDEX "Trip_jobId_key" ON "Trip"("jobId");
CREATE UNIQUE INDEX "Trip_assignmentId_key" ON "Trip"("assignmentId");
CREATE INDEX "Trip_status_idx" ON "Trip"("status");
CREATE UNIQUE INDEX "PaymentEvent_idempotencyKey_key" ON "PaymentEvent"("idempotencyKey");
CREATE INDEX "PaymentEvent_jobId_type_status_idx" ON "PaymentEvent"("jobId", "type", "status");
CREATE INDEX "PaymentEvent_stripePaymentIntentId_idx" ON "PaymentEvent"("stripePaymentIntentId");
CREATE INDEX "SettlementLine_jobId_idx" ON "SettlementLine"("jobId");
CREATE INDEX "SettlementLine_recipientType_status_idx" ON "SettlementLine"("recipientType", "status");
CREATE UNIQUE INDEX "PolicyVersion_key_version_key" ON "PolicyVersion"("key", "version");
CREATE INDEX "PolicyVersion_key_publishedAt_idx" ON "PolicyVersion"("key", "publishedAt");
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
CREATE INDEX "AuditEvent_actorAdminId_createdAt_idx" ON "AuditEvent"("actorAdminId", "createdAt");

-- Foreign keys
ALTER TABLE "LocalTerritory" ADD CONSTRAINT "LocalTerritory_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminScope" ADD CONSTRAINT "AdminScope_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminScope" ADD CONSTRAINT "AdminScope_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminScope" ADD CONSTRAINT "AdminScope_localTerritoryId_fkey" FOREIGN KEY ("localTerritoryId") REFERENCES "LocalTerritory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Company" ADD CONSTRAINT "Company_homeRegionId_fkey" FOREIGN KEY ("homeRegionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_senderCompanyId_fkey" FOREIGN KEY ("senderCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_originRegionId_fkey" FOREIGN KEY ("originRegionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_originTerritoryId_fkey" FOREIGN KEY ("originTerritoryId") REFERENCES "LocalTerritory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobStop" ADD CONSTRAINT "JobStop_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_carrierCompanyId_fkey" FOREIGN KEY ("carrierCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_carrierCompanyId_fkey" FOREIGN KEY ("carrierCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

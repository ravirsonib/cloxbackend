-- CreateEnum
CREATE TYPE "RateFloorVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateTable
CREATE TABLE "RateFloorVersion" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "RateFloorVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "referenceDieselCpl" DOUBLE PRECISION NOT NULL DEFAULT 211.4,
    "labourRateHrCents" INTEGER NOT NULL DEFAULT 3440,
    "minHours" DOUBLE PRECISION NOT NULL DEFAULT 4.0,
    "minKmChargeKm" DOUBLE PRECISION NOT NULL DEFAULT 25.0,
    "backhaulFactor" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "createdByAdminId" TEXT,
    "publishedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateFloorVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateFloorLine" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "vehicleClassCode" TEXT NOT NULL,
    "hourlyFloorCents" INTEGER NOT NULL,
    "kmFloorCents" INTEGER NOT NULL,
    "variableKmCents" INTEGER NOT NULL DEFAULT 0,
    "litresPerKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "basis" TEXT NOT NULL DEFAULT 'D',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateFloorLine_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "rateFloorVersionId" TEXT;
ALTER TABLE "Job" ADD COLUMN "rateFloorExGstCents" INTEGER;
ALTER TABLE "Job" ADD COLUMN "rateFloorIncGstCents" INTEGER;
ALTER TABLE "Job" ADD COLUMN "rateFloorBreakdown" JSONB;

-- CreateIndex
CREATE INDEX "RateFloorVersion_status_idx" ON "RateFloorVersion"("status");

-- CreateIndex
CREATE INDEX "RateFloorLine_vehicleClassCode_idx" ON "RateFloorLine"("vehicleClassCode");

-- CreateIndex
CREATE UNIQUE INDEX "RateFloorLine_versionId_vehicleClassCode_key" ON "RateFloorLine"("versionId", "vehicleClassCode");

-- AddForeignKey
ALTER TABLE "RateFloorVersion" ADD CONSTRAINT "RateFloorVersion_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateFloorVersion" ADD CONSTRAINT "RateFloorVersion_publishedByAdminId_fkey" FOREIGN KEY ("publishedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateFloorLine" ADD CONSTRAINT "RateFloorLine_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RateFloorVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_rateFloorVersionId_fkey" FOREIGN KEY ("rateFloorVersionId") REFERENCES "RateFloorVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

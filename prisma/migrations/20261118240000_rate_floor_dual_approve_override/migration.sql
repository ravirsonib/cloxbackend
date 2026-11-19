-- AlterTable RateFloorVersion — dual-approve
ALTER TABLE "RateFloorVersion" ADD COLUMN "approvalSubmittedAt" TIMESTAMP(3);
ALTER TABLE "RateFloorVersion" ADD COLUMN "approvedByAdminId" TEXT;

-- AddForeignKey
ALTER TABLE "RateFloorVersion" ADD CONSTRAINT "RateFloorVersion_approvedByAdminId_fkey" FOREIGN KEY ("approvedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable RateFloorOverride
CREATE TABLE "RateFloorOverride" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "approvedByAdminId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "floorExGstCentsOverride" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateFloorOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateFloorOverride_jobId_expiresAt_idx" ON "RateFloorOverride"("jobId", "expiresAt");

-- CreateIndex
CREATE INDEX "RateFloorOverride_expiresAt_idx" ON "RateFloorOverride"("expiresAt");

-- AddForeignKey
ALTER TABLE "RateFloorOverride" ADD CONSTRAINT "RateFloorOverride_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateFloorOverride" ADD CONSTRAINT "RateFloorOverride_approvedByAdminId_fkey" FOREIGN KEY ("approvedByAdminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

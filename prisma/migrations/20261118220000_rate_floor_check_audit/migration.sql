-- CreateEnum
CREATE TYPE "RateFloorCheckResult" AS ENUM ('PASS', 'REJECT', 'OVERRIDE');

-- CreateTable
CREATE TABLE "RateFloorCheck" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "actorUserId" TEXT,
    "actorAdminId" TEXT,
    "versionId" TEXT NOT NULL,
    "fuelIndexId" TEXT,
    "inputs" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "floorExGstCents" INTEGER NOT NULL,
    "floorIncGstCents" INTEGER NOT NULL,
    "offeredIncGstCents" INTEGER,
    "result" "RateFloorCheckResult" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateFloorCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateFloorCheck_jobId_idx" ON "RateFloorCheck"("jobId");

-- CreateIndex
CREATE INDEX "RateFloorCheck_versionId_idx" ON "RateFloorCheck"("versionId");

-- CreateIndex
CREATE INDEX "RateFloorCheck_result_idx" ON "RateFloorCheck"("result");

-- CreateIndex
CREATE INDEX "RateFloorCheck_createdAt_idx" ON "RateFloorCheck"("createdAt");

-- AddForeignKey
ALTER TABLE "RateFloorCheck" ADD CONSTRAINT "RateFloorCheck_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateFloorCheck" ADD CONSTRAINT "RateFloorCheck_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RateFloorVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

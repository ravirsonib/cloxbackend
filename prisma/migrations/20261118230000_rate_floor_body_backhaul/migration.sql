-- AlterTable Job — backhaul flag
ALTER TABLE "Job" ADD COLUMN "isBackhaul" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RateFloorBodyLoading" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "bodyCode" TEXT NOT NULL,
    "loadingPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minHours" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateFloorBodyLoading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateFloorBodyLoading_bodyCode_idx" ON "RateFloorBodyLoading"("bodyCode");

-- CreateIndex
CREATE UNIQUE INDEX "RateFloorBodyLoading_versionId_bodyCode_key" ON "RateFloorBodyLoading"("versionId", "bodyCode");

-- AddForeignKey
ALTER TABLE "RateFloorBodyLoading" ADD CONSTRAINT "RateFloorBodyLoading_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RateFloorVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

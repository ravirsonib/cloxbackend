-- CreateTable
CREATE TABLE "RateFloorLabourMultiplier" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "periodCode" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateFloorLabourMultiplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateFloorLabourMultiplier_periodCode_idx" ON "RateFloorLabourMultiplier"("periodCode");

-- CreateIndex
CREATE UNIQUE INDEX "RateFloorLabourMultiplier_versionId_periodCode_key" ON "RateFloorLabourMultiplier"("versionId", "periodCode");

-- AddForeignKey
ALTER TABLE "RateFloorLabourMultiplier" ADD CONSTRAINT "RateFloorLabourMultiplier_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RateFloorVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

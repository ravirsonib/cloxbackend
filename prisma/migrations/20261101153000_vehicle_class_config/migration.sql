-- CreateTable
CREATE TABLE "VehicleClassConfig" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "maxChargeableWeightKg" DOUBLE PRECISION NOT NULL,
    "maxLengthCm" DOUBLE PRECISION NOT NULL,
    "maxWidthCm" DOUBLE PRECISION NOT NULL,
    "maxHeightCm" DOUBLE PRECISION NOT NULL,
    "minLicenceClass" TEXT NOT NULL,
    "suggestedGvmKg" INTEGER NOT NULL,
    "suggestedTareKg" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleClassConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleClassConfig_code_key" ON "VehicleClassConfig"("code");

-- CreateIndex
CREATE INDEX "VehicleClassConfig_rank_idx" ON "VehicleClassConfig"("rank");

-- CreateIndex
CREATE INDEX "VehicleClassConfig_isActive_idx" ON "VehicleClassConfig"("isActive");

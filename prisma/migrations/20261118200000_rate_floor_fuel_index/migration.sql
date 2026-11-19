-- AlterTable PlatformSettings — Wave 2 fuel index knobs
ALTER TABLE "PlatformSettings" ADD COLUMN "fuelStaleDays" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "PlatformSettings" ADD COLUMN "fuelMoveConfirmPercent" DOUBLE PRECISION NOT NULL DEFAULT 8;
ALTER TABLE "PlatformSettings" ADD COLUMN "fuelWeeklyChangeCapPercent" DOUBLE PRECISION NOT NULL DEFAULT 15;

-- CreateTable
CREATE TABLE "FuelIndex" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "dieselCpl" DOUBLE PRECISION NOT NULL,
    "enteredByAdminId" TEXT,
    "confirmedByAdminId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelIndex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FuelIndex_weekStart_key" ON "FuelIndex"("weekStart");

-- CreateIndex
CREATE INDEX "FuelIndex_weekStart_idx" ON "FuelIndex"("weekStart");

-- AddForeignKey
ALTER TABLE "FuelIndex" ADD CONSTRAINT "FuelIndex_enteredByAdminId_fkey" FOREIGN KEY ("enteredByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelIndex" ADD CONSTRAINT "FuelIndex_confirmedByAdminId_fkey" FOREIGN KEY ("confirmedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

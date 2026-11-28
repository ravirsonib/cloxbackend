-- CreateEnum
CREATE TYPE "SenderAddressRole" AS ENUM ('PICKUP', 'DROPOFF', 'BOTH');

-- CreateTable
CREATE TABLE "SenderSavedAddress" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" "SenderAddressRole" NOT NULL DEFAULT 'BOTH',
    "addressLine" TEXT NOT NULL,
    "suburb" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "defaultContactName" TEXT,
    "defaultContactPhone" TEXT,
    "defaultContactEmail" TEXT,
    "isDefaultPickup" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderSavedAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SenderSavedAddress_companyId_role_idx" ON "SenderSavedAddress"("companyId", "role");

-- CreateIndex
CREATE INDEX "SenderSavedAddress_companyId_isDefaultPickup_idx" ON "SenderSavedAddress"("companyId", "isDefaultPickup");

-- AddForeignKey
ALTER TABLE "SenderSavedAddress" ADD CONSTRAINT "SenderSavedAddress_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

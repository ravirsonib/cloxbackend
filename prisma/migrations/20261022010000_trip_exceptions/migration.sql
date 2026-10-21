-- CreateEnum
CREATE TYPE "TripExceptionKind" AS ENUM ('DRIVER_UNAVAILABLE', 'VEHICLE_BREAKDOWN', 'ACCIDENT', 'TRAFFIC', 'OTHER');

-- CreateEnum
CREATE TYPE "TripExceptionPhase" AS ENUM ('PRE_TRIP', 'MID_TRIP');

-- CreateEnum
CREATE TYPE "TripExceptionStatus" AS ENUM ('OPEN', 'AWAITING_CARRIER', 'REASSIGN_IN_PROGRESS', 'ESCALATED', 'RESOLVED_REASSIGNED', 'RESOLVED_CONTINUED', 'RESOLVED_CANCELLED', 'CLOSED');

-- CreateTable
CREATE TABLE "TripException" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "tripId" TEXT,
    "companyId" TEXT NOT NULL,
    "reportedByUserId" TEXT NOT NULL,
    "kind" "TripExceptionKind" NOT NULL,
    "phase" "TripExceptionPhase" NOT NULL,
    "status" "TripExceptionStatus" NOT NULL DEFAULT 'AWAITING_CARRIER',
    "reasonCode" TEXT,
    "note" TEXT,
    "gpsLat" DOUBLE PRECISION,
    "gpsLng" DOUBLE PRECISION,
    "photoDocumentId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripException_companyId_status_openedAt_idx" ON "TripException"("companyId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "TripException_assignmentId_status_idx" ON "TripException"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "TripException_tripId_idx" ON "TripException"("tripId");

-- CreateIndex
CREATE INDEX "TripException_jobId_idx" ON "TripException"("jobId");

-- AddForeignKey
ALTER TABLE "TripException" ADD CONSTRAINT "TripException_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripException" ADD CONSTRAINT "TripException_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripException" ADD CONSTRAINT "TripException_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripException" ADD CONSTRAINT "TripException_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

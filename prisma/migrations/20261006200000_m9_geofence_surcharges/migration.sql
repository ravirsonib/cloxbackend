-- M9: geofence dwell + surcharges

ALTER TYPE "PaymentEventType" ADD VALUE IF NOT EXISTS 'SURCHARGE';

CREATE TYPE "SurchargeKind" AS ENUM ('WAITING', 'MASS');
CREATE TYPE "SurchargeStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'WAIVED');

CREATE TABLE "TripStopProgress" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "jobStopId" TEXT NOT NULL,
    "insideCount" INTEGER NOT NULL DEFAULT 0,
    "currentlyInside" BOOLEAN NOT NULL DEFAULT false,
    "enteredAt" TIMESTAMP(3),
    "exitedAt" TIMESTAMP(3),
    "waitStartedAt" TIMESTAMP(3),
    "freeWaitEndsAt" TIMESTAMP(3),
    "waitOverageMinutes" INTEGER NOT NULL DEFAULT 0,
    "arrivalRecorded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripStopProgress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TripStopProgress_tripId_jobStopId_key" ON "TripStopProgress"("tripId", "jobStopId");
CREATE INDEX "TripStopProgress_tripId_idx" ON "TripStopProgress"("tripId");
CREATE INDEX "TripStopProgress_jobStopId_idx" ON "TripStopProgress"("jobStopId");

ALTER TABLE "TripStopProgress" ADD CONSTRAINT "TripStopProgress_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TripStopProgress" ADD CONSTRAINT "TripStopProgress_jobStopId_fkey" FOREIGN KEY ("jobStopId") REFERENCES "JobStop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Surcharge" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "kind" "SurchargeKind" NOT NULL,
    "status" "SurchargeStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "amountExGstCents" INTEGER NOT NULL,
    "amountGstCents" INTEGER NOT NULL,
    "amountIncGstCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "paymentEventId" TEXT,
    "stopProgressId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "paidAt" TIMESTAMP(3),
    "waivedAt" TIMESTAMP(3),
    "waivedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Surcharge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Surcharge_paymentEventId_key" ON "Surcharge"("paymentEventId");
CREATE UNIQUE INDEX "Surcharge_idempotencyKey_key" ON "Surcharge"("idempotencyKey");
CREATE INDEX "Surcharge_jobId_status_idx" ON "Surcharge"("jobId", "status");
CREATE INDEX "Surcharge_tripId_kind_status_idx" ON "Surcharge"("tripId", "kind", "status");
CREATE INDEX "Surcharge_status_idx" ON "Surcharge"("status");

ALTER TABLE "Surcharge" ADD CONSTRAINT "Surcharge_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Surcharge" ADD CONSTRAINT "Surcharge_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Surcharge" ADD CONSTRAINT "Surcharge_paymentEventId_fkey" FOREIGN KEY ("paymentEventId") REFERENCES "PaymentEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Surcharge" ADD CONSTRAINT "Surcharge_stopProgressId_fkey" FOREIGN KEY ("stopProgressId") REFERENCES "TripStopProgress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- M10 — hourly run sheet odometer start/end + GPS variance flag
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "odometerStartKm" DOUBLE PRECISION;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "odometerEndKm" DOUBLE PRECISION;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "odometerGpsDistanceKm" DOUBLE PRECISION;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "odometerDiscrepancyFlag" BOOLEAN NOT NULL DEFAULT false;

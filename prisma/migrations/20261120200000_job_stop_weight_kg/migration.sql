-- Per-stop cargo mass: PICKUP = load on, DROPOFF = load off (kg).
ALTER TABLE "JobStop" ADD COLUMN "weightKg" DOUBLE PRECISION;

-- Class-based freight rates (Ops rate card + sender guidance) + job pricing class snapshot.

ALTER TABLE "VehicleClassConfig"
  ADD COLUMN IF NOT EXISTS "perKmRateCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "hourlyRateCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "perKmMinBaseCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "hourlyMinBaseCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "perKmGuidanceMinCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "perKmGuidanceMaxCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "hourlyGuidanceMinCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "hourlyGuidanceMaxCents" INTEGER;

ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS "pricingVehicleClass" TEXT;

-- Seed midpoints from docs/product/vehicle-type-average-pricing.md (AUD ex-GST → cents).
UPDATE "VehicleClassConfig" SET
  "perKmRateCents" = 250,
  "hourlyRateCents" = 8500,
  "perKmMinBaseCents" = 5000,
  "hourlyMinBaseCents" = 34000,
  "perKmGuidanceMinCents" = 200,
  "perKmGuidanceMaxCents" = 300,
  "hourlyGuidanceMinCents" = 7000,
  "hourlyGuidanceMaxCents" = 10000
WHERE "code" = 'UTE' AND "perKmRateCents" IS NULL;

UPDATE "VehicleClassConfig" SET
  "perKmRateCents" = 300,
  "hourlyRateCents" = 10500,
  "perKmMinBaseCents" = 6000,
  "hourlyMinBaseCents" = 42000,
  "perKmGuidanceMinCents" = 250,
  "perKmGuidanceMaxCents" = 350,
  "hourlyGuidanceMinCents" = 8500,
  "hourlyGuidanceMaxCents" = 12000
WHERE "code" = 'VAN' AND "perKmRateCents" IS NULL;

UPDATE "VehicleClassConfig" SET
  "perKmRateCents" = 415,
  "hourlyRateCents" = 13000,
  "perKmMinBaseCents" = 8000,
  "hourlyMinBaseCents" = 52000,
  "perKmGuidanceMinCents" = 350,
  "perKmGuidanceMaxCents" = 480,
  "hourlyGuidanceMinCents" = 11000,
  "hourlyGuidanceMaxCents" = 15000
WHERE "code" = 'RIGID_1_2T' AND "perKmRateCents" IS NULL;

UPDATE "VehicleClassConfig" SET
  "perKmRateCents" = 500,
  "hourlyRateCents" = 15500,
  "perKmMinBaseCents" = 10000,
  "hourlyMinBaseCents" = 62000,
  "perKmGuidanceMinCents" = 400,
  "perKmGuidanceMaxCents" = 550,
  "hourlyGuidanceMinCents" = 12000,
  "hourlyGuidanceMaxCents" = 17000
WHERE "code" = 'RIGID_3_4T' AND "perKmRateCents" IS NULL;

UPDATE "VehicleClassConfig" SET
  "perKmRateCents" = 775,
  "hourlyRateCents" = 22000,
  "perKmMinBaseCents" = 15000,
  "hourlyMinBaseCents" = 88000,
  "perKmGuidanceMinCents" = 650,
  "perKmGuidanceMaxCents" = 900,
  "hourlyGuidanceMinCents" = 18000,
  "hourlyGuidanceMaxCents" = 26000
WHERE "code" = 'SEMI' AND "perKmRateCents" IS NULL;

UPDATE "VehicleClassConfig" SET
  "perKmRateCents" = 900,
  "hourlyRateCents" = 28000,
  "perKmMinBaseCents" = 20000,
  "hourlyMinBaseCents" = 112000,
  "perKmGuidanceMinCents" = 750,
  "perKmGuidanceMaxCents" = 1100,
  "hourlyGuidanceMinCents" = 22000,
  "hourlyGuidanceMaxCents" = 32000
WHERE "code" = 'BDOUBLE' AND "perKmRateCents" IS NULL;

-- Backfill pricing class on existing jobs from preferred/recommended.
UPDATE "Job"
SET "pricingVehicleClass" = COALESCE("minVehicleClass", "recommendedVehicleClass")
WHERE "pricingVehicleClass" IS NULL
  AND ("minVehicleClass" IS NOT NULL OR "recommendedVehicleClass" IS NOT NULL);

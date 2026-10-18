-- M4 carrier onboarding: Connect payouts, capabilities, fleet mass fields

ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "stripeConnectPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "serviceRegionCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "tareKg" INTEGER;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "gvmKg" INTEGER;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "gcmKg" INTEGER;

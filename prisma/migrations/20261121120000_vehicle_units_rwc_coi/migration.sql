-- Multi-unit RWC/COI: combination units with independent rego + inspection docs.

CREATE TYPE "VehicleUnitRole" AS ENUM ('POWERED', 'TRAILER_1', 'TRAILER_2', 'TRAILER_3');
CREATE TYPE "CombinationConfig" AS ENUM ('NONE', 'SEMI', 'BDOUBLE', 'RT_DOUBLE', 'RT_TRIPLE');

ALTER TABLE "Vehicle" ADD COLUMN "combinationConfig" "CombinationConfig" NOT NULL DEFAULT 'NONE';

CREATE TABLE "VehicleUnit" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "role" "VehicleUnitRole" NOT NULL,
    "registration" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VehicleUnit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VehicleUnit_vehicleId_role_key" ON "VehicleUnit"("vehicleId", "role");
CREATE INDEX "VehicleUnit_vehicleId_idx" ON "VehicleUnit"("vehicleId");

ALTER TABLE "VehicleUnit" ADD CONSTRAINT "VehicleUnit_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComplianceDocument" ADD COLUMN "vehicleUnitId" TEXT;
CREATE INDEX "ComplianceDocument_vehicleUnitId_idx" ON "ComplianceDocument"("vehicleUnitId");
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_vehicleUnitId_fkey"
  FOREIGN KEY ("vehicleUnitId") REFERENCES "VehicleUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill combinationConfig from vehicle class.
UPDATE "Vehicle" SET "combinationConfig" = 'SEMI'
  WHERE UPPER(COALESCE("vehicleClass", '')) IN ('SEMI', 'CONTAINER');
UPDATE "Vehicle" SET "combinationConfig" = 'BDOUBLE'
  WHERE UPPER(COALESCE("vehicleClass", '')) = 'BDOUBLE';
UPDATE "Vehicle" SET "combinationConfig" = 'RT_DOUBLE'
  WHERE UPPER(COALESCE("vehicleClass", '')) = 'ROAD_TRAIN';

-- Backfill POWERED unit for every vehicle (copy registration).
INSERT INTO "VehicleUnit" ("id", "vehicleId", "role", "registration", "label", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v."id", 'POWERED', v."registration", v."label", NOW(), NOW()
FROM "Vehicle" v
WHERE NOT EXISTS (
  SELECT 1 FROM "VehicleUnit" u WHERE u."vehicleId" = v."id" AND u."role" = 'POWERED'
);

-- Trailer placeholders for artic classes (registration null until carrier fills).
INSERT INTO "VehicleUnit" ("id", "vehicleId", "role", "registration", "label", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v."id", 'TRAILER_1', NULL, 'Trailer 1', NOW(), NOW()
FROM "Vehicle" v
WHERE v."combinationConfig" IN ('SEMI', 'BDOUBLE', 'RT_DOUBLE', 'RT_TRIPLE')
  AND NOT EXISTS (
    SELECT 1 FROM "VehicleUnit" u WHERE u."vehicleId" = v."id" AND u."role" = 'TRAILER_1'
  );

INSERT INTO "VehicleUnit" ("id", "vehicleId", "role", "registration", "label", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v."id", 'TRAILER_2', NULL, 'Trailer 2', NOW(), NOW()
FROM "Vehicle" v
WHERE v."combinationConfig" IN ('BDOUBLE', 'RT_DOUBLE', 'RT_TRIPLE')
  AND NOT EXISTS (
    SELECT 1 FROM "VehicleUnit" u WHERE u."vehicleId" = v."id" AND u."role" = 'TRAILER_2'
  );

INSERT INTO "VehicleUnit" ("id", "vehicleId", "role", "registration", "label", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v."id", 'TRAILER_3', NULL, 'Trailer 3', NOW(), NOW()
FROM "Vehicle" v
WHERE v."combinationConfig" = 'RT_TRIPLE'
  AND NOT EXISTS (
    SELECT 1 FROM "VehicleUnit" u WHERE u."vehicleId" = v."id" AND u."role" = 'TRAILER_3'
  );

-- Point existing per-vehicle RWCs at the POWERED unit.
UPDATE "ComplianceDocument" d
SET "vehicleUnitId" = u."id"
FROM "VehicleUnit" u
WHERE d."vehicleId" = u."vehicleId"
  AND u."role" = 'POWERED'
  AND d."docType" = 'RWC'
  AND d."vehicleId" IS NOT NULL
  AND d."vehicleUnitId" IS NULL;

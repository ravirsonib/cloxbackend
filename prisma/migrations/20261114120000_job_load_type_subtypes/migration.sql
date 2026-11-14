-- AlterTable: optional load-type sub-menu codes (e.g. GENERAL:CARTONS)
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "loadTypeSubtypes" TEXT[] DEFAULT ARRAY[]::TEXT[];

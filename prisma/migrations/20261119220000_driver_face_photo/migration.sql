-- Optional driver face / profile photo (ComplianceDocument SELFIE), separate from licence scan.
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "facePhotoDocumentId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Driver_facePhotoDocumentId_key"
  ON "Driver"("facePhotoDocumentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Driver_facePhotoDocumentId_fkey'
  ) THEN
    ALTER TABLE "Driver"
      ADD CONSTRAINT "Driver_facePhotoDocumentId_fkey"
      FOREIGN KEY ("facePhotoDocumentId")
      REFERENCES "ComplianceDocument"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

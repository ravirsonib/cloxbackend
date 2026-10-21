-- M10 Phase D: tax invoice / run sheet on Trip; breakdown PDF on TripException
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "taxInvoiceStorageKey" TEXT;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "runSheetStorageKey" TEXT;

ALTER TABLE "TripException" ADD COLUMN IF NOT EXISTS "breakdownPdfStorageKey" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Lead" ADD COLUMN "confirmationEmailedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_idempotencyKey_key" ON "Lead"("idempotencyKey");

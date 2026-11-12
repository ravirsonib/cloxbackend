-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE "ContentTranslation" (
    "id" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceLocale" TEXT,
    "targetLocale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stub',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentTranslation_targetLocale_createdAt_idx" ON "ContentTranslation"("targetLocale", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentTranslation_sourceHash_targetLocale_key" ON "ContentTranslation"("sourceHash", "targetLocale");

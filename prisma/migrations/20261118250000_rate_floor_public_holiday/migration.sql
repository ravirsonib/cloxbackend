-- CreateTable
CREATE TABLE "PublicHoliday" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "holidayDate" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublicHoliday_holidayDate_idx" ON "PublicHoliday"("holidayDate");

-- CreateIndex
CREATE INDEX "PublicHoliday_state_idx" ON "PublicHoliday"("state");

-- CreateIndex
CREATE UNIQUE INDEX "PublicHoliday_state_holidayDate_key" ON "PublicHoliday"("state", "holidayDate");

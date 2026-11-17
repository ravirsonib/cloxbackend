-- Sender draft-first: remember publish intent while Ops KYB/KYC is pending.
ALTER TABLE "Job" ADD COLUMN "publishRequestedAt" TIMESTAMP(3);

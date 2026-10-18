-- M7 Stripe webhook dedupe

CREATE TABLE IF NOT EXISTS "StripeWebhookEvent" (
  "id" TEXT NOT NULL,
  "stripeEventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB,
  CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StripeWebhookEvent_stripeEventId_key" ON "StripeWebhookEvent"("stripeEventId");

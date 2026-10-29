-- Marketplace repair prompts (mock → live Stripe)
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_SETUP_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYOUT_SETUP_REQUIRED';

/** Detect Stripe ids minted while `STRIPE_MOCK` / no secret key was active. */

export function isMockStripeCustomerId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith('cus_mock_'));
}

export function isMockStripePaymentMethodId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith('pm_mock_'));
}

export function isMockStripeConnectAccountId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith('acct_mock_'));
}

export function companyHasMockSenderPayment(company: {
  stripeCustomerId?: string | null;
  stripeDefaultPaymentMethodId?: string | null;
}): boolean {
  return (
    isMockStripeCustomerId(company.stripeCustomerId) ||
    isMockStripePaymentMethodId(company.stripeDefaultPaymentMethodId)
  );
}

export function companyHasMockCarrierConnect(company: {
  stripeConnectAccountId?: string | null;
}): boolean {
  return isMockStripeConnectAccountId(company.stripeConnectAccountId);
}

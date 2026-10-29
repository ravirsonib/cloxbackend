import {
  companyHasMockCarrierConnect,
  companyHasMockSenderPayment,
  isMockStripeConnectAccountId,
  isMockStripeCustomerId,
  isMockStripePaymentMethodId,
} from './stripe-mock-ids.util';

describe('stripe-mock-ids.util', () => {
  it('detects mock customer / pm / connect ids', () => {
    expect(isMockStripeCustomerId('cus_mock_abc')).toBe(true);
    expect(isMockStripeCustomerId('cus_live123')).toBe(false);
    expect(isMockStripePaymentMethodId('pm_mock_1')).toBe(true);
    expect(isMockStripeConnectAccountId('acct_mock_x')).toBe(true);
    expect(isMockStripeConnectAccountId('acct_1Nxyz')).toBe(false);
  });

  it('company helpers', () => {
    expect(
      companyHasMockSenderPayment({
        stripeCustomerId: 'cus_mock_a',
        stripeDefaultPaymentMethodId: 'pm_card',
      }),
    ).toBe(true);
    expect(
      companyHasMockSenderPayment({
        stripeCustomerId: 'cus_abc',
        stripeDefaultPaymentMethodId: null,
      }),
    ).toBe(false);
    expect(
      companyHasMockCarrierConnect({ stripeConnectAccountId: 'acct_mock_z' }),
    ).toBe(true);
  });
});

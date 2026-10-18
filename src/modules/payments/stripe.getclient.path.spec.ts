import { StripeService } from './stripe.service';

describe('StripeService getClient mock leftover', () => {
  it('getClient throws when mock mode', () => {
    const svc = new StripeService({
      get: (key: string) => {
        if (key === 'STRIPE_MOCK') return true;
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test';
        return undefined;
      },
    } as never);
    expect(() =>
      (svc as unknown as { getClient: () => unknown }).getClient(),
    ).toThrow('Stripe client unavailable in mock mode');
  });
});

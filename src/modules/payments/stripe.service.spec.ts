import { StripeService } from './stripe.service';

function config(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  } as never;
}

describe('StripeService', () => {
  it('is mock when no secret key', () => {
    const svc = new StripeService(config({ STRIPE_SECRET_KEY: undefined, STRIPE_MOCK: false }));
    expect(svc.isMockMode()).toBe(true);
  });

  it('is mock when STRIPE_MOCK forced', () => {
    const svc = new StripeService(config({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_MOCK: true }));
    expect(svc.isMockMode()).toBe(true);
  });

  it('mock createPaymentIntent returns succeeded', async () => {
    const svc = new StripeService(config({ STRIPE_SECRET_KEY: undefined, STRIPE_MOCK: false }));
    const pi = await svc.createPaymentIntent({
      amountCents: 15000,
      customerId: 'cus_mock',
      paymentMethodId: 'pm_mock',
      idempotencyKey: 'accept:job:prop',
      metadata: { jobId: 'j1' },
    });
    expect(pi.mock).toBe(true);
    expect(pi.status).toBe('succeeded');
    expect(pi.id.startsWith('pi_mock_')).toBe(true);
  });

  it('mock setupIntent still works', async () => {
    const svc = new StripeService(config({}));
    const customer = await svc.createCustomer({ email: 'clox.mail@yopmail.com', name: 'A' });
    const setup = await svc.createSetupIntent(customer.id);
    expect(setup.mock).toBe(true);
    expect(setup.clientSecret).toContain('secret');
  });
});

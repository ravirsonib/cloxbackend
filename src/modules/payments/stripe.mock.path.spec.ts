import { StripeService } from './stripe.service';

function config(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  } as never;
}

describe('StripeService mock expansions', () => {
  const mockCfg = config({ STRIPE_SECRET_KEY: undefined, STRIPE_MOCK: false });

  it('mock createConnectAccount + accountLink + retrieve payoutsEnabled', async () => {
    const svc = new StripeService(mockCfg);
    const acct = await svc.createConnectAccount({
      email: 'carrier.clox@yopmail.com',
      businessName: 'Carrier Co',
    });
    expect(acct.mock).toBe(true);
    expect(acct.id.startsWith('acct_mock_')).toBe(true);

    const link = await svc.createAccountLink({
      accountId: acct.id,
      refreshUrl: 'https://app/refresh',
      returnUrl: 'https://app/return',
    });
    expect(link.mock).toBe(true);
    expect(link.url).toContain('connect=mock');

    const retrieved = await svc.retrieveConnectAccount(acct.id);
    expect(retrieved).toMatchObject({
      payoutsEnabled: true,
      chargesEnabled: true,
      mock: true,
    });
  });

  it('mock cancel + refund stub + retrieve PI helpers', async () => {
    const svc = new StripeService(mockCfg);
    await expect(svc.cancelPaymentIntent('pi_mock_abc')).resolves.toBeUndefined();
    const refund = await svc.createRefundStub({
      paymentIntentId: 'pi_mock_abc',
      idempotencyKey: 'refund:test',
    });
    expect(refund.mock).toBe(true);
    expect(refund.id.startsWith('re_mock_')).toBe(true);

    await expect(svc.retrievePaymentIntentClientSecret('pi_mock_x')).resolves.toBe(
      'pi_mock_x_secret_mock',
    );
    await expect(svc.retrievePaymentIntentStatus('pi_mock_x')).resolves.toBe('succeeded');
  });

  it('publishableKey reads config', () => {
    const svc = new StripeService(
      config({ STRIPE_PUBLISHABLE_KEY: 'pk_live_x', STRIPE_SECRET_KEY: undefined }),
    );
    expect(svc.publishableKey()).toBe('pk_live_x');
  });

  it('constructWebhookEvent throws in mock mode', () => {
    const svc = new StripeService(mockCfg);
    expect(() => svc.constructWebhookEvent(Buffer.from('{}'), 'sig')).toThrow(
      /not used in mock mode/,
    );
  });

  it('attachPaymentMethod normalizes non-pm_ ids in mock', async () => {
    const svc = new StripeService(mockCfg);
    const attached = await svc.attachPaymentMethod({
      customerId: 'cus_1',
      paymentMethodId: 'card_xyz',
    });
    expect(attached.mock).toBe(true);
    expect(attached.paymentMethodId.startsWith('pm_mock_')).toBe(true);
  });
});

jest.mock('stripe', () => {
  const instance = {
    customers: {
      create: jest.fn(),
      update: jest.fn(),
    },
    setupIntents: { create: jest.fn() },
    paymentMethods: { attach: jest.fn() },
    accounts: {
      create: jest.fn(),
      retrieve: jest.fn(),
    },
    accountLinks: { create: jest.fn() },
    paymentIntents: {
      create: jest.fn(),
      retrieve: jest.fn(),
      cancel: jest.fn(),
    },
    refunds: { create: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
  };
  const StripeCtor = jest.fn().mockImplementation(() => instance);
  (StripeCtor as unknown as { __instance: typeof instance }).__instance = instance;
  return { __esModule: true, default: StripeCtor };
});

import Stripe from 'stripe';
import { StripeService } from './stripe.service';

function liveConfig(extra: Record<string, unknown> = {}) {
  return {
    get: (key: string) => {
      const values: Record<string, unknown> = {
        STRIPE_SECRET_KEY: 'sk_test_live_path',
        STRIPE_MOCK: false,
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
        ...extra,
      };
      return values[key];
    },
  } as never;
}

function stripeMock() {
  return (Stripe as unknown as { __instance: {
    customers: { create: jest.Mock; update: jest.Mock };
    setupIntents: { create: jest.Mock };
    paymentMethods: { attach: jest.Mock };
    accounts: { create: jest.Mock; retrieve: jest.Mock };
    accountLinks: { create: jest.Mock };
    paymentIntents: { create: jest.Mock; retrieve: jest.Mock; cancel: jest.Mock };
    refunds: { create: jest.Mock };
    webhooks: { constructEvent: jest.Mock };
  } }).__instance;
}

describe('StripeService live SDK paths (mocked Stripe client)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is not mock when secret present and STRIPE_MOCK false', () => {
    const svc = new StripeService(liveConfig());
    expect(svc.isMockMode()).toBe(false);
  });

  it('getClient throws in mock mode', () => {
    const svc = new StripeService(
      liveConfig({ STRIPE_SECRET_KEY: undefined, STRIPE_MOCK: false }),
    );
    expect(() =>
      // force via createCustomer live branch would not run; use constructWebhook
      svc.constructWebhookEvent(Buffer.from('{}'), 'sig'),
    ).toThrow(/mock mode|Webhook construct/);
  });

  it('live createCustomer / setupIntent / attachPaymentMethod', async () => {
    const api = stripeMock();
    api.customers.create.mockResolvedValue({ id: 'cus_live_1' });
    api.setupIntents.create.mockResolvedValue({
      id: 'seti_live_1',
      client_secret: 'seti_live_1_secret',
    });
    api.paymentMethods.attach.mockResolvedValue({});
    api.customers.update.mockResolvedValue({});

    const svc = new StripeService(liveConfig());
    await expect(
      svc.createCustomer({
        email: 'sender@yopmail.com',
        name: 'Sender',
        metadata: { companyId: 'co-1' },
      }),
    ).resolves.toEqual({ id: 'cus_live_1', mock: false });

    await expect(svc.createSetupIntent('cus_live_1')).resolves.toEqual({
      id: 'seti_live_1',
      clientSecret: 'seti_live_1_secret',
      mock: false,
    });

    await expect(
      svc.attachPaymentMethod({
        customerId: 'cus_live_1',
        paymentMethodId: 'pm_live_1',
      }),
    ).resolves.toEqual({ paymentMethodId: 'pm_live_1', mock: false });
    expect(api.paymentMethods.attach).toHaveBeenCalled();
    expect(api.customers.update).toHaveBeenCalled();
  });

  it('live Connect account + link + retrieve', async () => {
    const api = stripeMock();
    api.accounts.create.mockResolvedValue({ id: 'acct_live_1' });
    api.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe/onboard' });
    api.accounts.retrieve.mockResolvedValue({
      id: 'acct_live_1',
      payouts_enabled: true,
      charges_enabled: false,
    });

    const svc = new StripeService(liveConfig());
    await expect(
      svc.createConnectAccount({
        email: 'carrier@yopmail.com',
        businessName: 'Carrier Co',
      }),
    ).resolves.toEqual({ id: 'acct_live_1', mock: false });

    await expect(
      svc.createAccountLink({
        accountId: 'acct_live_1',
        refreshUrl: 'https://app/refresh',
        returnUrl: 'https://app/return',
      }),
    ).resolves.toEqual({ url: 'https://connect.stripe/onboard', mock: false });

    await expect(svc.retrieveConnectAccount('acct_live_1')).resolves.toEqual({
      id: 'acct_live_1',
      payoutsEnabled: true,
      chargesEnabled: false,
      mock: false,
    });
  });

  it('live createPaymentIntent with and without paymentMethodId', async () => {
    const api = stripeMock();
    api.paymentIntents.create
      .mockResolvedValueOnce({
        id: 'pi_1',
        client_secret: 'sec_1',
        status: 'requires_payment_method',
      })
      .mockResolvedValueOnce({
        id: 'pi_2',
        client_secret: 'sec_2',
        status: 'succeeded',
      });

    const svc = new StripeService(liveConfig());
    await expect(
      svc.createPaymentIntent({
        amountCents: 1000,
        customerId: 'cus_1',
        idempotencyKey: 'k1',
        metadata: { jobId: 'j1' },
      }),
    ).resolves.toMatchObject({ id: 'pi_1', mock: false, status: 'requires_payment_method' });

    await expect(
      svc.createPaymentIntent({
        amountCents: 1000,
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        idempotencyKey: 'k2',
        metadata: { jobId: 'j1' },
      }),
    ).resolves.toMatchObject({ id: 'pi_2', mock: false, status: 'succeeded' });

    expect(api.paymentIntents.create.mock.calls[1][0]).toMatchObject({
      payment_method: 'pm_1',
      confirm: true,
      off_session: true,
    });
  });

  it('constructWebhookEvent requires secret and uses Stripe webhooks', () => {
    const api = stripeMock();
    api.webhooks.constructEvent.mockReturnValue({ type: 'payment_intent.succeeded' });
    const svc = new StripeService(liveConfig());
    expect(svc.constructWebhookEvent(Buffer.from('{}'), 'sig_test')).toEqual({
      type: 'payment_intent.succeeded',
    });

    const noSecret = new StripeService(liveConfig({ STRIPE_WEBHOOK_SECRET: undefined }));
    expect(() => noSecret.constructWebhookEvent(Buffer.from('{}'), 'sig')).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it('live retrieve PI helpers + cancel + refund', async () => {
    const api = stripeMock();
    api.paymentIntents.retrieve
      .mockResolvedValueOnce({ client_secret: 'cs_live' })
      .mockResolvedValueOnce({ status: 'processing' });
    api.paymentIntents.cancel.mockResolvedValue({});
    api.refunds.create.mockResolvedValue({ id: 're_live', status: 'succeeded' });

    const svc = new StripeService(liveConfig());
    await expect(svc.retrievePaymentIntentClientSecret('pi_live')).resolves.toBe('cs_live');
    await expect(svc.retrievePaymentIntentStatus('pi_live')).resolves.toBe('processing');
    await expect(svc.cancelPaymentIntent('pi_live')).resolves.toBeUndefined();
    expect(api.paymentIntents.cancel).toHaveBeenCalledWith('pi_live');

    api.paymentIntents.cancel.mockRejectedValueOnce(new Error('already canceled'));
    await expect(svc.cancelPaymentIntent('pi_live')).resolves.toBeUndefined();

    await expect(
      svc.createRefundStub({
        paymentIntentId: 'pi_live',
        amountCents: 500,
        idempotencyKey: 'refund:1',
      }),
    ).resolves.toEqual({ id: 're_live', status: 'succeeded', mock: false });
  });

  it('pi_mock_ ids still short-circuit even with live config', async () => {
    const svc = new StripeService(liveConfig());
    await expect(svc.retrievePaymentIntentClientSecret('pi_mock_x')).resolves.toBe(
      'pi_mock_x_secret_mock',
    );
    await expect(svc.retrievePaymentIntentStatus('pi_mock_x')).resolves.toBe('succeeded');
    await expect(svc.cancelPaymentIntent('pi_mock_x')).resolves.toBeUndefined();
    expect(stripeMock().paymentIntents.cancel).not.toHaveBeenCalled();
  });
});

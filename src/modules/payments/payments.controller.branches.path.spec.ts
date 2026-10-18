import { PaymentsController } from './payments.controller';

describe('PaymentsController webhook body branches', () => {
  it('uses rawBody when present', async () => {
    const handleStripeWebhook = jest.fn().mockResolvedValue({ received: true });
    const c = new PaymentsController(
      { handleStripeWebhook } as never,
      { isMockMode: () => true } as never,
    );
    const raw = Buffer.from('raw-sig');
    await c.webhook({ rawBody: raw } as never, 'sig', { ignored: true });
    expect(handleStripeWebhook).toHaveBeenCalledWith(raw, 'sig');
    expect(c.status()).toMatchObject({ stripeMock: true });
  });

  it('serializes body when rawBody missing', async () => {
    const handleStripeWebhook = jest.fn().mockResolvedValue({ received: true });
    const c = new PaymentsController(
      { handleStripeWebhook } as never,
      { isMockMode: () => false } as never,
    );
    await c.webhook({} as never, undefined, { type: 'payment_intent.succeeded' });
    expect(handleStripeWebhook).toHaveBeenCalledWith(
      Buffer.from(JSON.stringify({ type: 'payment_intent.succeeded' })),
      undefined,
    );
    expect(c.status()).toMatchObject({ stripeMock: false });
  });

  it('serializes empty object when body is nullish', async () => {
    const handleStripeWebhook = jest.fn().mockResolvedValue({ received: true });
    const c = new PaymentsController(
      { handleStripeWebhook } as never,
      { isMockMode: () => true } as never,
    );
    await c.webhook({} as never, 'sig', undefined);
    expect(handleStripeWebhook).toHaveBeenCalledWith(
      Buffer.from(JSON.stringify({})),
      'sig',
    );
  });
});

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { AppEnv } from '../../config/env.validation';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  isMockMode() {
    const forced = this.config.get('STRIPE_MOCK', { infer: true });
    const key = this.config.get('STRIPE_SECRET_KEY', { infer: true });
    return Boolean(forced || !key);
  }

  private getClient(): Stripe {
    if (this.isMockMode()) {
      throw new Error('Stripe client unavailable in mock mode');
    }
    if (!this.client) {
      const key = this.config.get('STRIPE_SECRET_KEY', { infer: true });
      this.client = new Stripe(key!);
    }
    return this.client;
  }

  async createCustomer(params: {
    email: string;
    name: string;
    metadata?: Record<string, string>;
  }) {
    if (this.isMockMode()) {
      const id = `cus_mock_${params.email.replace(/[^a-z0-9]/gi, '').slice(0, 18)}`;
      this.logger.warn(`STRIPE_MOCK: created customer ${id}`);
      return { id, mock: true as const };
    }
    const customer = await this.getClient().customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });
    return { id: customer.id, mock: false as const };
  }

  async createSetupIntent(customerId: string) {
    if (this.isMockMode()) {
      const id = `seti_mock_${Date.now()}`;
      this.logger.warn(`STRIPE_MOCK: setupIntent ${id}`);
      return {
        id,
        clientSecret: `${id}_secret_mock`,
        mock: true as const,
      };
    }
    const intent = await this.getClient().setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });
    return {
      id: intent.id,
      clientSecret: intent.client_secret!,
      mock: false as const,
    };
  }

  async attachPaymentMethod(params: { customerId: string; paymentMethodId: string }) {
    if (this.isMockMode()) {
      const pm = params.paymentMethodId.startsWith('pm_')
        ? params.paymentMethodId
        : `pm_mock_${Date.now()}`;
      this.logger.warn(`STRIPE_MOCK: attach ${pm} to ${params.customerId}`);
      return { paymentMethodId: pm, mock: true as const };
    }
    const stripe = this.getClient();
    await stripe.paymentMethods.attach(params.paymentMethodId, {
      customer: params.customerId,
    });
    await stripe.customers.update(params.customerId, {
      invoice_settings: { default_payment_method: params.paymentMethodId },
    });
    return { paymentMethodId: params.paymentMethodId, mock: false as const };
  }

  /** Stripe Connect Express account (M4). Mock when no secret key. */
  async createConnectAccount(params: {
    email: string;
    businessName: string;
    metadata?: Record<string, string>;
  }) {
    if (this.isMockMode()) {
      const id = `acct_mock_${params.email.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;
      this.logger.warn(`STRIPE_MOCK: Connect account ${id}`);
      return { id, mock: true as const };
    }
    const account = await this.getClient().accounts.create({
      type: 'express',
      country: 'AU',
      email: params.email,
      business_type: 'company',
      company: { name: params.businessName },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: params.metadata,
    });
    return { id: account.id, mock: false as const };
  }

  async createAccountLink(params: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }) {
    if (this.isMockMode()) {
      const url = `${params.returnUrl}${params.returnUrl.includes('?') ? '&' : '?'}connect=mock&account=${params.accountId}`;
      this.logger.warn(`STRIPE_MOCK: AccountLink ${url}`);
      return { url, mock: true as const };
    }
    const link = await this.getClient().accountLinks.create({
      account: params.accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url, mock: false as const };
  }

  async retrieveConnectAccount(accountId: string) {
    if (this.isMockMode()) {
      return {
        id: accountId,
        payoutsEnabled: true,
        chargesEnabled: true,
        mock: true as const,
      };
    }
    const account = await this.getClient().accounts.retrieve(accountId);
    return {
      id: account.id,
      payoutsEnabled: Boolean(account.payouts_enabled),
      chargesEnabled: Boolean(account.charges_enabled),
      mock: false as const,
    };
  }

  publishableKey() {
    return this.config.get('STRIPE_PUBLISHABLE_KEY', { infer: true }) ?? null;
  }

  /**
   * Model A fare charge on platform (separate charges + transfers later for payout).
   * Mock always returns succeeded. Real mode confirms off-session when PM provided.
   */
  async createPaymentIntent(params: {
    amountCents: number;
    currency?: string;
    customerId: string;
    paymentMethodId?: string | null;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }) {
    const currency = params.currency ?? 'aud';
    if (this.isMockMode()) {
      const id = `pi_mock_${params.idempotencyKey.replace(/[^a-z0-9]/gi, '').slice(-20)}_${Date.now()}`;
      this.logger.warn(`STRIPE_MOCK: PaymentIntent ${id} amount=${params.amountCents}`);
      return {
        id,
        clientSecret: `${id}_secret_mock`,
        status: 'succeeded' as const,
        mock: true as const,
      };
    }

    const stripe = this.getClient();
    const createParams: Stripe.PaymentIntentCreateParams = {
      amount: params.amountCents,
      currency,
      customer: params.customerId,
      metadata: params.metadata,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    };
    if (params.paymentMethodId) {
      createParams.payment_method = params.paymentMethodId;
      createParams.confirm = true;
      createParams.off_session = true;
    }

    const intent = await stripe.paymentIntents.create(createParams, {
      idempotencyKey: params.idempotencyKey,
    });

    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status as
        | 'requires_payment_method'
        | 'requires_confirmation'
        | 'requires_action'
        | 'processing'
        | 'requires_capture'
        | 'canceled'
        | 'succeeded',
      mock: false as const,
    };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string) {
    if (this.isMockMode()) {
      throw new Error('Webhook construct not used in mock mode');
    }
    const secret = this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    return this.getClient().webhooks.constructEvent(rawBody, signature, secret);
  }

  /** Retrieve client_secret for SCA recovery on idempotent accept replay. */
  async retrievePaymentIntentClientSecret(paymentIntentId: string): Promise<string | null> {
    if (this.isMockMode() || paymentIntentId.startsWith('pi_mock_')) {
      return `${paymentIntentId}_secret_mock`;
    }
    const intent = await this.getClient().paymentIntents.retrieve(paymentIntentId);
    return intent.client_secret;
  }

  /** Status for stuck-PI recovery (canceled / failed confirms). */
  async retrievePaymentIntentStatus(paymentIntentId: string): Promise<string | null> {
    if (this.isMockMode() || paymentIntentId.startsWith('pi_mock_')) {
      return 'succeeded';
    }
    const intent = await this.getClient().paymentIntents.retrieve(paymentIntentId);
    return intent.status;
  }

  /** Best-effort cancel so waived/failed accepts do not leave live Stripe intents. */
  async cancelPaymentIntent(paymentIntentId: string): Promise<void> {
    if (this.isMockMode() || paymentIntentId.startsWith('pi_mock_')) {
      this.logger.warn(`STRIPE_MOCK: cancel ${paymentIntentId}`);
      return;
    }
    try {
      await this.getClient().paymentIntents.cancel(paymentIntentId);
    } catch (err) {
      this.logger.warn(
        `cancelPaymentIntent ${paymentIntentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** M10/M12 full path — stub for cancel recovery in M7. */
  async createRefundStub(params: {
    paymentIntentId: string;
    amountCents?: number;
    idempotencyKey: string;
  }) {
    if (this.isMockMode()) {
      const id = `re_mock_${Date.now()}`;
      this.logger.warn(`STRIPE_MOCK: refund stub ${id} for ${params.paymentIntentId}`);
      return { id, status: 'succeeded' as const, mock: true as const };
    }
    const refund = await this.getClient().refunds.create(
      {
        payment_intent: params.paymentIntentId,
        amount: params.amountCents,
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return { id: refund.id, status: refund.status ?? 'pending', mock: false as const };
  }
}

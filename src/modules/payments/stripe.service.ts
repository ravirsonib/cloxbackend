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
      // Stripe SDK 23+: `payment_method_types` → `allowed_payment_method_types`
      allowed_payment_method_types: ['card'],
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

  /**
   * Stripe Connect Express-equivalent account via Accounts v2 (M4).
   * Separate charges + transfers need recipient (stripe_transfers);
   * merchant/card_payments kept for Express parity. Mock when no secret key.
   * @see https://docs.stripe.com/connect/accounts-v2/account-creation
   * @see docs/payments/stripe-payment-specification.md §6.2
   */
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
    try {
      const account = await this.getClient().v2.core.accounts.create({
        contact_email: params.email,
        display_name: params.businessName,
        dashboard: 'express',
        identity: {
          country: 'au',
          entity_type: 'company',
          business_details: { registered_name: params.businessName },
        },
        defaults: {
          currency: 'aud',
          responsibilities: {
            // Express dashboard requires platform-liable fees + losses.
            fees_collector: 'application',
            losses_collector: 'application',
          },
        },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { requested: true },
            },
          },
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: { requested: true },
              },
            },
          },
        },
        metadata: params.metadata,
        include: [
          'configuration.merchant',
          'configuration.recipient',
          'identity',
          'defaults',
        ],
      });
      return { id: account.id, mock: false as const };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/signed up for Connect|EnableConnect|enable_connect|dashboard\.stripe\.com\/connect/i.test(message)) {
        this.logger.error(
          'Stripe Connect is not enabled on this platform Stripe account. Enable Connect in the Stripe Dashboard (https://dashboard.stripe.com/connect) for the same mode as STRIPE_SECRET_KEY (test vs live).',
        );
        throw new Error(
          'Stripe Connect is not enabled on the platform account. An admin must enable Connect in the Stripe Dashboard (Connect → Get started), then retry payout setup.',
        );
      }
      if (/Accounts v1|feat_accounts_v1_support|\/v2\/core\/accounts/i.test(message)) {
        this.logger.error(
          `Stripe rejected Connect account creation (Accounts v1 policy / v2 required): ${message}`,
        );
        throw new Error(
          'Stripe Connect account setup failed. The platform must create connected accounts with Accounts v2. Retry after the API is updated, or ask an admin to check Stripe Connect settings.',
        );
      }
      throw error;
    }
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
    // Accounts created via v2 need Account Links v2 (hosted onboarding).
    const link = await this.getClient().v2.core.accountLinks.create({
      account: params.accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          refresh_url: params.refreshUrl,
          return_url: params.returnUrl,
          collection_options: {
            fields: 'eventually_due',
          },
        },
      },
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

  /**
   * Separate charges + transfers (G0-10): move carrier share from platform balance
   * to Express connected account.
   */
  async createTransfer(params: {
    amountCents: number;
    destinationAccountId: string;
    idempotencyKey: string;
    transferGroup?: string;
    metadata?: Record<string, string>;
    currency?: string;
  }) {
    const currency = params.currency ?? 'aud';
    if (this.isMockMode()) {
      const id = `tr_mock_${params.idempotencyKey.replace(/[^a-z0-9]/gi, '').slice(-20)}`;
      this.logger.warn(
        `STRIPE_MOCK: Transfer ${id} amount=${params.amountCents} → ${params.destinationAccountId}`,
      );
      return { id, status: 'paid' as const, mock: true as const };
    }
    const transfer = await this.getClient().transfers.create(
      {
        amount: params.amountCents,
        currency,
        destination: params.destinationAccountId,
        transfer_group: params.transferGroup,
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return {
      id: transfer.id,
      status: (transfer.reversed ? 'reversed' : 'paid') as 'paid' | 'reversed',
      mock: false as const,
    };
  }

  /** Reverse a Connect Transfer (marketplace release / reassignment). */
  async createTransferReversal(params: {
    transferId: string;
    amountCents?: number;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }) {
    if (this.isMockMode() || params.transferId.startsWith('tr_mock_')) {
      const id = `trr_mock_${params.idempotencyKey.replace(/[^a-z0-9]/gi, '').slice(-18)}`;
      this.logger.warn(
        `STRIPE_MOCK: TransferReversal ${id} of ${params.transferId}`,
      );
      return { id, status: 'succeeded' as const, mock: true as const };
    }
    const reversal = await this.getClient().transfers.createReversal(
      params.transferId,
      {
        amount: params.amountCents,
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return {
      id: reversal.id,
      status: 'succeeded' as const,
      mock: false as const,
    };
  }

  /** Full refund path (cancel / ACL). Mock when no secret key. */
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

import {
  CompanyStatus,
  CompanyType,
  SenderAccountType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { SenderService } from './sender.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const INVOICE = {
  invoiceLegalName: 'Sender Co',
  invoiceAddressLine1: '1 St',
  invoiceSuburb: 'Melbourne',
  invoiceState: 'VIC',
  invoicePostcode: '3000',
};

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-s',
    type: CompanyType.SENDER,
    status: CompanyStatus.DRAFT,
    legalName: 'Sender Co',
    tradingName: null,
    abn: '51824753556',
    acn: null,
    senderAccountType: SenderAccountType.BUSINESS,
    paymentReady: false,
    gstRegistered: true,
    stripeCustomerId: null,
    stripeDefaultPaymentMethodId: null,
    ...INVOICE,
    homeRegionId: 'reg-vic',
    homeRegion: { code: 'VIC' },
    complianceCases: [],
    ...overrides,
  };
}

describe('SenderService getOnboarding wizardStep leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: jest.fn().mockReturnValue(true) };
  const config = { get: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new SenderService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
    );
  }

  function prismaFor(co: ReturnType<typeof company>) {
    return {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: null,
          phone: null,
          company: co,
        }),
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['rejected', company({ status: CompanyStatus.REJECTED }), 'rejected'],
    ['suspended', company({ status: CompanyStatus.SUSPENDED }), 'suspended'],
    ['complete ACTIVE', company({ status: CompanyStatus.ACTIVE, paymentReady: true }), 'complete'],
    [
      'payment PENDING_PAYMENT',
      company({ status: CompanyStatus.PENDING_PAYMENT }),
      'payment',
    ],
    [
      'waiting_ops PENDING_REVIEW',
      company({ status: CompanyStatus.PENDING_REVIEW }),
      'waiting_ops',
    ],
    [
      'waiting_ops PENDING_VERIFICATION',
      company({ status: CompanyStatus.PENDING_VERIFICATION }),
      'waiting_ops',
    ],
    [
      'account_type missing',
      company({ senderAccountType: null }),
      'account_type',
    ],
    [
      'invoice incomplete',
      company({
        invoiceLegalName: null,
        invoiceAddressLine1: null,
        invoiceSuburb: null,
        invoiceState: null,
        invoicePostcode: null,
      }),
      'invoice',
    ],
    ['documents ready', company(), 'documents'],
  ] as const)('%s', async (_label, co, step) => {
    const result = await makeService(prismaFor(co)).getOnboarding(senderPrincipal);
    expect(result.step).toBe(step);
  });
});

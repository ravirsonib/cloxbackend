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

describe('SenderService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_1', mock: true }),
    createSetupIntent: jest.fn().mockResolvedValue({
      id: 'seti_1',
      clientSecret: 'cs_1',
      mock: true,
    }),
    isMockMode: jest.fn().mockReturnValue(true),
  };

  function makeService(
    prisma: Record<string, unknown>,
    publishable: string | undefined = undefined,
  ) {
    return new SenderService(
      prisma as never,
      audit as never,
      stripe as never,
      { get: () => publishable } as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('getOnboarding maps homeRegion + latestCase; null homeRegion → null code', async () => {
    const baseCompany = {
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
      invoiceLegalName: 'Sender Co',
      invoiceAddressLine1: '1 St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      complianceDocuments: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'user-sender',
            email: 'sender@yopmail.com',
            name: 'S',
            phone: null,
            company: {
              ...baseCompany,
              homeRegion: { code: 'VIC' },
              complianceCases: [
                {
                  id: 'case-1',
                  status: 'OPEN',
                  caseType: 'SENDER_KYB',
                  decisionNote: null,
                },
              ],
            },
          })
          .mockResolvedValueOnce({
            id: 'user-sender',
            email: 'sender@yopmail.com',
            name: 'S',
            phone: null,
            company: {
              ...baseCompany,
              homeRegion: null,
              complianceCases: [],
            },
          }),
      },
    };
    const withRegion = await makeService(prisma).getOnboarding(senderPrincipal);
    expect(withRegion.company.homeRegionCode).toBe('VIC');
    expect(withRegion.latestCase).toMatchObject({ id: 'case-1' });
    const noRegion = await makeService(prisma).getOnboarding(senderPrincipal);
    expect(noRegion.company.homeRegionCode).toBeNull();
  });

  it('updateProfile keeps provided abn; paymentSetup invoiceLegalName fallback + null pk', async () => {
    const company = {
      id: 'co-s',
      type: CompanyType.SENDER,
      status: CompanyStatus.DRAFT,
      legalName: 'Sender Co',
      tradingName: null,
      abn: null as string | null,
      acn: null,
      senderAccountType: SenderAccountType.BUSINESS,
      paymentReady: false,
      gstRegistered: true,
      stripeCustomerId: null as string | null,
      stripeDefaultPaymentMethodId: null,
      invoiceLegalName: null as string | null,
      invoiceAddressLine1: '1 St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      homeRegionId: 'reg-vic',
      homeRegion: { code: 'VIC' },
      complianceCases: [],
      complianceDocuments: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'S',
          phone: null,
          company,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      company: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          ...company,
          invoiceLegalName: 'Sender Co',
          abn: '51824753556',
        }),
      },
    };
    await makeService(prisma).updateProfile(senderPrincipal, {
      accountType: 'INDIVIDUAL',
      legalName: 'Sender Co',
      invoiceLegalName: 'Sender Co',
      abn: '',
      phone: '+61412345678',
      homeRegionCode: 'VIC',
      invoiceAddressLine1: '1 Collins St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      gstRegistered: false,
    } as never);
    expect(prisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ abn: null }),
      }),
    );

    prisma.user.findUnique.mockResolvedValue({
      id: 'user-sender',
      email: 'sender@yopmail.com',
      name: 'S',
      phone: null,
      company: {
        ...company,
        status: CompanyStatus.PENDING_PAYMENT,
        abn: '51824753556',
        invoiceLegalName: 'Sender Co',
        invoiceAddressLine1: '1 Collins St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
      },
    });
    const setup = await makeService(prisma, undefined).createPaymentSetup(senderPrincipal);
    expect(setup.publishableKey).toBeNull();
  });
});

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CompanyStatus, CompanyType } from '@prisma/client';
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

function senderCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-s',
    type: CompanyType.SENDER,
    status: CompanyStatus.PENDING_PAYMENT,
    legalName: 'Sender Co',
    tradingName: null,
    abn: '51824753556',
    acn: null,
    senderAccountType: 'BUSINESS',
    paymentReady: false,
    gstRegistered: true,
    stripeCustomerId: null as string | null,
    stripeDefaultPaymentMethodId: null,
    invoiceLegalName: 'Sender Co',
    invoiceAddressLine1: '1 St',
    invoiceSuburb: 'Melbourne',
    invoiceState: 'VIC',
    invoicePostcode: '3000',
    homeRegion: { code: 'VIC' },
    complianceCases: [],
    ...overrides,
  };
}

describe('SenderService payment paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createCustomer: jest.fn(),
    createSetupIntent: jest.fn(),
    attachPaymentMethod: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const config = { get: jest.fn().mockReturnValue('pk_test') };

  function makeService(prisma: Record<string, unknown>) {
    return new SenderService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('createPaymentSetup rejects before ops approve', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          company: senderCompany({ status: CompanyStatus.DRAFT }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.createPaymentSetup(senderPrincipal)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('createPaymentSetup creates customer + setup intent', async () => {
    stripe.createCustomer.mockResolvedValue({ id: 'cus_new' });
    stripe.createSetupIntent.mockResolvedValue({
      id: 'seti_1',
      clientSecret: 'seti_secret',
      mock: true,
    });
    const company = senderCompany();
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          company,
        }),
      },
      company: { update: jest.fn() },
    };
    const service = makeService(prisma);
    const result = await service.createPaymentSetup(senderPrincipal);
    expect(stripe.createCustomer).toHaveBeenCalled();
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-s' },
      data: { stripeCustomerId: 'cus_new' },
    });
    expect(result).toMatchObject({
      customerId: 'cus_new',
      setupIntentId: 'seti_1',
      clientSecret: 'seti_secret',
      mock: true,
    });
  });

  it('confirmPayment activates company in mock mode without paymentMethodId', async () => {
    stripe.attachPaymentMethod.mockResolvedValue({
      paymentMethodId: 'pm_mock_default',
      mock: true,
    });
    const company = senderCompany({ stripeCustomerId: 'cus_1' });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'Sender',
          phone: null,
          company,
        }),
      },
      company: {
        update: jest.fn().mockImplementation(async ({ data }) => {
          Object.assign(company, data);
          return company;
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.confirmPayment(senderPrincipal, {});
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-s' },
      data: {
        stripeDefaultPaymentMethodId: 'pm_mock_default',
        paymentReady: true,
        status: CompanyStatus.ACTIVE,
      },
    });
    expect(result.goNoGo.canBook).toBe(true);
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('confirmPayment requires paymentMethodId when Stripe live', async () => {
    stripe.isMockMode.mockReturnValue(false);
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          company: senderCompany({ stripeCustomerId: 'cus_1' }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.confirmPayment(senderPrincipal, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getBookingEligibility canBook when ACTIVE + invoice + paymentReady', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: senderCompany({
            status: CompanyStatus.ACTIVE,
            paymentReady: true,
          }),
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.getBookingEligibility(senderPrincipal);
    expect(result.canBook).toBe(true);
  });

  it('rejects non-sender principal', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.getBookingEligibility({ ...senderPrincipal, role: 'DRIVER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

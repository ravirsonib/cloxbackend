import { CompanyStatus } from '@prisma/client';
import { SenderService } from './sender.service';

describe('SenderService payment repair wizard', () => {
  it('ACTIVE without paymentReady returns payment step', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 's@yopmail.com',
          name: 'S',
          phone: null,
          role: 'SENDER',
          company: {
            id: 'co-1',
            type: 'SENDER',
            status: CompanyStatus.ACTIVE,
            legalName: 'Sender Co',
            tradingName: null,
            abn: '51824753556',
            acn: null,
            senderAccountType: 'BUSINESS',
            invoiceLegalName: 'Sender Co',
            invoiceAddressLine1: '1 St',
            invoiceSuburb: 'Mel',
            invoiceState: 'VIC',
            invoicePostcode: '3000',
            gstRegistered: true,
            paymentReady: false,
            stripeCustomerId: null,
            stripeDefaultPaymentMethodId: null,
            homeRegion: { code: 'VIC' },
            email: 's@yopmail.com',
            complianceCases: [],
          },
        }),
      },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const inbox = { notifyUsers: jest.fn().mockResolvedValue(1) };
    const service = new SenderService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { isMockMode: () => false } as never,
      { get: () => undefined } as never,
      { sendRegistrationConfirmation: jest.fn() } as never,
      { resolveInviteForRegister: jest.fn(), markInviteAccepted: jest.fn() } as never,
      inbox as never,
    );

    const result = await service.getOnboarding({
      id: 'u1',
      email: 's@yopmail.com',
      role: 'SENDER',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });

    expect(result.step).toBe('payment');
    expect(result.paymentRepairRequired).toBe(true);
    expect(result.goNoGo.canBook).toBe(false);
    await Promise.resolve();
    expect(inbox.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAYMENT_SETUP_REQUIRED',
        href: '/sender/onboarding',
      }),
    );
  });

  it('clears mock Stripe ids when live and reopens payment', async () => {
    const companyUpdate = jest.fn().mockResolvedValue({
      id: 'co-1',
      paymentReady: false,
      stripeCustomerId: null,
      stripeDefaultPaymentMethodId: null,
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 's@yopmail.com',
          name: 'S',
          phone: null,
          role: 'SENDER',
          company: {
            id: 'co-1',
            type: 'SENDER',
            status: CompanyStatus.ACTIVE,
            legalName: 'Sender Co',
            tradingName: null,
            abn: '51824753556',
            acn: null,
            senderAccountType: 'BUSINESS',
            invoiceLegalName: 'Sender Co',
            invoiceAddressLine1: '1 St',
            invoiceSuburb: 'Mel',
            invoiceState: 'VIC',
            invoicePostcode: '3000',
            gstRegistered: true,
            paymentReady: true,
            stripeCustomerId: 'cus_mock_old',
            stripeDefaultPaymentMethodId: 'pm_mock_old',
            homeRegion: { code: 'VIC' },
            email: 's@yopmail.com',
            complianceCases: [],
          },
        }),
      },
      company: { update: companyUpdate },
      notification: { findFirst: jest.fn().mockResolvedValue({ id: 'n1' }) },
    };
    const service = new SenderService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { isMockMode: () => false } as never,
      { get: () => undefined } as never,
      { sendRegistrationConfirmation: jest.fn() } as never,
      { resolveInviteForRegister: jest.fn(), markInviteAccepted: jest.fn() } as never,
    );

    const result = await service.getOnboarding({
      id: 'u1',
      email: 's@yopmail.com',
      role: 'SENDER',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });

    expect(companyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentReady: false,
          stripeCustomerId: null,
        }),
      }),
    );
    expect(result.step).toBe('payment');
    expect(result.company.paymentReady).toBe(false);
  });
});

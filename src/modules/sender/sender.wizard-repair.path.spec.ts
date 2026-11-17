import { CompanyStatus } from '@prisma/client';
import { SenderService } from './sender.service';

describe('SenderService payment repair + draft-first go/no-go', () => {
  it('ACTIVE without paymentReady stays complete and canPublishLive', async () => {
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

    // Payment is collectable on /account or at accept — not a wizard step / publish gate.
    expect(result.step).toBe('complete');
    expect(result.goNoGo.canDraft).toBe(true);
    expect(result.goNoGo.canPublishLive).toBe(true);
    expect(result.goNoGo.canBook).toBe(true);
    expect(result.goNoGo.paymentReady).toBe(false);
  });

  it('clears mock Stripe ids when live; publish remains allowed after invoice+Ops', async () => {
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
    expect(result.step).toBe('complete');
    expect(result.company.paymentReady).toBe(false);
    expect(result.goNoGo.canPublishLive).toBe(true);
  });
});

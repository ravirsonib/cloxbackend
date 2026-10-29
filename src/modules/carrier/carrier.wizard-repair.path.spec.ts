import { CompanyStatus } from '@prisma/client';
import { CarrierService } from './carrier.service';

describe('CarrierService payout repair wizard', () => {
  it('BID_ELIGIBLE without connect returns connect + repair flag', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'c@yopmail.com',
          name: 'C',
          phone: null,
          role: 'TRANSPORT_COMPANY',
          company: {
            id: 'co-c',
            type: 'CARRIER',
            status: CompanyStatus.BID_ELIGIBLE,
            legalName: 'Carrier Co',
            tradingName: null,
            abn: '51824753556',
            acn: null,
            phone: null,
            homeRegion: { code: 'VIC' },
            stripeConnectAccountId: null,
            stripeConnectPayoutsEnabled: false,
            capabilities: [],
            serviceRegionCodes: ['VIC'],
            vehicles: [{ id: 'v1', status: 'ACTIVE' }],
            drivers: [{ status: 'ACTIVE', user: { email: 'd@yopmail.com', name: null, phone: null }, id: 'd1', licenceNo: null }],
            complianceDocuments: [],
            complianceCases: [],
          },
        }),
      },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const inbox = { notifyUsers: jest.fn().mockResolvedValue(1) };
    const service = new CarrierService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { isMockMode: () => false } as never,
      { get: () => 'http://localhost:5174' } as never,
      {
        createInviteToken: jest.fn(),
        sendInviteMail: jest.fn(),
        inviteUrl: jest.fn(),
      } as never,
      { sendRegistrationConfirmation: jest.fn() } as never,
      {
        resolveInviteForRegister: jest.fn(),
        markInviteAccepted: jest.fn(),
      } as never,
      inbox as never,
    );

    const result = await service.getOnboarding({
      id: 'u1',
      email: 'c@yopmail.com',
      role: 'TRANSPORT_COMPANY',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });

    expect(result.step).toBe('connect');
    expect(result.payoutRepairRequired).toBe(true);
    expect(result.goNoGo.canBid).toBe(false);
    await Promise.resolve();
    expect(inbox.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAYOUT_SETUP_REQUIRED',
        href: '/carrier/onboarding',
      }),
    );
  });
});

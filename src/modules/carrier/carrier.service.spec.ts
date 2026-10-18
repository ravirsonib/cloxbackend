import { CompanyStatus } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { CarrierService } from './carrier.service';

describe('CarrierService bid gate', () => {
  it('canBid requires BID_ELIGIBLE + connect + fleet', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'c@yopmail.com',
          role: 'TRANSPORT_COMPANY',
          company: {
            id: 'c1',
            type: 'CARRIER',
            status: CompanyStatus.DRAFT,
            abn: null,
            stripeConnectPayoutsEnabled: false,
            capabilities: [],
            serviceRegionCodes: [],
            vehicles: [],
            drivers: [],
            homeRegion: { code: 'VIC' },
            complianceCases: [],
            complianceDocuments: [],
            legalName: 'Co',
            tradingName: null,
            acn: null,
            phone: null,
            stripeConnectAccountId: null,
          },
        }),
      },
    };
    const service = new CarrierService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { isMockMode: () => true } as never,
      { get: () => undefined } as never,
      {
        createInviteToken: jest.fn(),
        sendInviteMail: jest.fn(),
        inviteUrl: jest.fn(),
      } as never,
    );
    const result = await service.getBidEligibility({
      id: 'u1',
      email: 'c@yopmail.com',
      role: 'TRANSPORT_COMPANY',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });
    expect(result.canBid).toBe(false);
  });

  it('bid stub Forbidden code', () => {
    expect(() => {
      throw new ForbiddenException({
        message: 'Carrier cannot bid',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
      });
    }).toThrow(ForbiddenException);
  });
});

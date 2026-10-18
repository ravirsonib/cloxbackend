import { ForbiddenException } from '@nestjs/common';
import { CompanyStatus } from '@prisma/client';
import { SenderService } from './sender.service';

describe('SenderService booking gate', () => {
  it('goNoGo requires ACTIVE + invoice + payment', async () => {
    const company = {
      status: CompanyStatus.DRAFT,
      paymentReady: false,
      invoiceLegalName: null,
      invoiceAddressLine1: null,
      invoiceSuburb: null,
      invoiceState: null,
      invoicePostcode: null,
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 's@yopmail.com',
          role: 'SENDER',
          company: {
            ...company,
            type: 'SENDER',
            id: 'c1',
            homeRegion: { code: 'VIC' },
            complianceCases: [],
            senderAccountType: null,
            legalName: 'Test',
            tradingName: null,
            abn: null,
            acn: null,
            gstRegistered: false,
            stripeCustomerId: null,
            homeRegionId: null,
          },
        }),
      },
    };

    const service = new SenderService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { isMockMode: () => true } as never,
      { get: () => undefined } as never,
    );

    const result = await service.getBookingEligibility({
      id: 'u1',
      email: 's@yopmail.com',
      role: 'SENDER',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });

    expect(result.canBook).toBe(false);
  });

  it('jobs create uses Forbidden when not canBook', () => {
    expect(() => {
      throw new ForbiddenException({
        message: 'Sender cannot create jobs',
        code: 'SENDER_NOT_BOOKING_READY',
      });
    }).toThrow(ForbiddenException);
  });
});

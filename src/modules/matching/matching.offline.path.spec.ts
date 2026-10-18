import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { MatchingService } from './matching.service';

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('MatchingService offline / role leftovers', () => {
  it('listBoard throws when DB offline', async () => {
    const service = new MatchingService(
      { isConnected: () => false } as never,
      { recordPlatform: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await expect(service.listBoard(carrier)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('listBoard forbids non-carrier principal', async () => {
    const service = new MatchingService(
      { isConnected: () => true } as never,
      { recordPlatform: jest.fn() } as never,
      {
        getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }),
      } as never,
      {} as never,
    );
    await expect(service.listBoard(sender)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('submitProposal forbids when not bid-eligible', async () => {
    const service = new MatchingService(
      { isConnected: () => true } as never,
      { recordPlatform: jest.fn() } as never,
      {
        getBidEligibility: jest.fn().mockResolvedValue({
          canBid: false,
          goNoGo: { reasons: ['docs'] },
        }),
      } as never,
      {} as never,
    );
    try {
      await service.submitProposal(carrier, {
        jobId: 'job-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        amountIncGstCents: 50_000,
        etaMinutes: 30,
      });
      fail('expected CARRIER_NOT_BID_ELIGIBLE');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'CARRIER_NOT_BID_ELIGIBLE',
      });
    }
  });
});

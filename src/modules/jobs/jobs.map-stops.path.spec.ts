import { JobStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { JobsService } from './jobs.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('JobsService mapJob stops leftover', () => {
  it('getJobForSender maps Decimal stop coords', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.DRAFT,
          pricingModel: 'PER_KM',
          title: 'J',
          receiverName: 'R',
          receiverEmail: 'r@yopmail.com',
          receiverPhone: null,
          pickupAt: null,
          deadWeightKg: 10,
          lengthCm: 10,
          widthCm: 10,
          heightCm: 10,
          chargeableWeightKg: 10,
          loadTypes: [],
          requiresDg: false,
          requiresReefer: false,
          requiresOversize: false,
          minVehicleClass: 'UTE',
          recommendedVehicleClass: 'UTE',
          siteManeuverability: null,
          siteFacility: null,
          siteDisclaimerAcceptedAt: null,
          hourlyPattern: null,
          routeDistanceKm: 1,
          routeDurationMinutes: 1,
          routeFatigueBreakMinutes: 0,
          billableHours: null,
          estimateExGstCents: 100,
          estimateGstCents: 10,
          estimateIncGstCents: 110,
          publishedAt: null,
          createdAt: new Date(),
          stops: [
            {
              id: 's1',
              sequence: 1,
              stopType: 'PICKUP',
              label: null,
              addressLine: '1 St',
              suburb: 'Mel',
              state: 'VIC',
              postcode: '3000',
              lat: { toNumber: () => -37.8 },
              lng: { toNumber: () => 144.9 },
              receiverName: null,
              receiverEmail: null,
            },
          ],
          proposals: [],
          assignment: null,
          paymentEvents: [],
        }),
      },
    };
    const service = new JobsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    const result = await service.getJobForSender(sender, 'job-1');
    expect(result.stops[0]).toMatchObject({ lat: -37.8, lng: 144.9, suburb: 'Mel' });
  });
});

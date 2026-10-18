import { CompanyType, ProposalStatus } from '@prisma/client';
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

describe('JobsService map/branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { acceptProposal: jest.fn() };
  const senderService = { assertCanBook: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      payments as never,
    );
  }

  it('mapJob handles Decimal coords, null lng, and null vehicle fields', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
          company: { id: 'co-s', type: CompanyType.SENDER },
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Run',
          status: 'BIDDING',
          pricingModel: 'PER_KM',
          priority: false,
          deadWeightKg: 100,
          chargeableWeightKg: 120,
          estimateExGstCents: 1000,
          estimateGstCents: 100,
          estimateIncGstCents: 1100,
          publishedAt: null,
          createdAt: new Date(),
          siteManeuverability: null,
          siteFacility: null,
          stops: [
            {
              id: 's1',
              sequence: 1,
              stopType: 'PICKUP',
              label: null,
              addressLine: '1 St',
              suburb: 'Melbourne',
              state: 'VIC',
              postcode: '3000',
              lat: { toNumber: () => -37.8 },
              lng: null,
              receiverName: null,
              receiverEmail: null,
            },
          ],
          proposals: [
            {
              id: 'p1',
              status: ProposalStatus.SUBMITTED,
              amountIncGstCents: 1100,
              amountExGstCents: 1000,
              amountGstCents: 100,
              etaMinutes: 40,
              vehicle: null,
              createdAt: new Date(),
            },
            {
              id: 'p2',
              status: ProposalStatus.SUBMITTED,
              amountIncGstCents: 1200,
              amountExGstCents: 1091,
              amountGstCents: 109,
              etaMinutes: 50,
              vehicle: { vehicleClass: null, label: null, registration: 'XYZ' },
              createdAt: new Date(),
            },
          ],
          assignment: null,
          paymentEvents: [],
        }),
      },
    };

    const mapped = await makeService(prisma).getJobForSender(sender, 'job-1');
    expect(mapped.stops?.[0]).toMatchObject({ lat: -37.8, lng: null });
    expect(mapped.proposals?.[0]).toMatchObject({
      vehicleClass: null,
      vehicleLabel: null,
    });
    expect(mapped.proposals?.[1]).toMatchObject({
      vehicleLabel: 'XYZ',
    });
  });

  it('resolveJobOrigin with empty stops + null fallback returns nulls', async () => {
    const service = makeService({ isConnected: () => true });
    const result = await (
      service as unknown as {
        resolveJobOrigin: (
          stops: Array<{ stopType: string; state: string | null }>,
          fallback: string | null,
        ) => Promise<{ originRegionId: string | null; originTerritoryId: string | null }>;
      }
    ).resolveJobOrigin([], null);
    expect(result).toEqual({ originRegionId: null, originTerritoryId: null });
  });
});

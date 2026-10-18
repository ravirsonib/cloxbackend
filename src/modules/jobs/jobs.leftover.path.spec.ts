import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CompanyType, JobStatus, ProposalStatus } from '@prisma/client';
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

function mapJobFields(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    status: JobStatus.DRAFT,
    pricingModel: 'PER_KM',
    title: 'Job',
    receiverName: 'Receiver',
    receiverEmail: 'receiver@yopmail.com',
    receiverPhone: null,
    pickupAt: new Date('2026-10-10T10:00:00.000Z'),
    deadWeightKg: 100,
    lengthCm: 100,
    widthCm: 100,
    heightCm: 100,
    chargeableWeightKg: 167,
    loadTypes: ['GENERAL'],
    requiresDg: false,
    requiresReefer: false,
    requiresOversize: false,
    minVehicleClass: 'VAN',
    recommendedVehicleClass: 'VAN',
    siteManeuverability: 'EASY',
    siteFacility: 'DOCK',
    siteDisclaimerAcceptedAt: new Date(),
    hourlyPattern: null,
    routeDistanceKm: 10,
    routeDurationMinutes: 30,
    routeFatigueBreakMinutes: 0,
    billableHours: null,
    estimateExGstCents: 10000,
    estimateGstCents: 1000,
    estimateIncGstCents: 11000,
    publishedAt: null,
    createdAt: new Date('2026-10-01'),
    stops: [],
    ...overrides,
  };
}

describe('JobsService leftover list/get/publish/bidding paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const senderService = {
    getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true, goNoGo: {} }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      {} as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    senderService.getBookingEligibility.mockResolvedValue({ canBook: true, goNoGo: {} });
  });

  it('listSenderJobs rejects non-sender and missing company', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.listSenderJobs({ ...sender, role: 'DRIVER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', company: null }) },
    };
    await expect(makeService(prisma).listSenderJobs(sender)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('listSenderJobs maps sender company jobs', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: { id: 'co-s', type: CompanyType.SENDER },
        }),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([mapJobFields()]),
      },
    };
    const rows = await makeService(prisma).listSenderJobs(sender);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'job-1', status: JobStatus.DRAFT });
  });

  it('getJobForSender returns assignment + payment summary', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          ...mapJobFields({ status: JobStatus.ASSIGNED }),
          proposals: [
            {
              id: 'prop-1',
              status: ProposalStatus.ACCEPTED,
              amountIncGstCents: 11000,
              amountExGstCents: 10000,
              amountGstCents: 1000,
              etaMinutes: 40,
              carrierCompanyId: 'co-c',
              vehicleId: 'v1',
              driverId: 'd1',
              vehicle: { vehicleClass: 'VAN', registration: 'ABC', label: 'Van 1' },
              createdAt: new Date(),
            },
          ],
          assignment: {
            id: 'asg-1',
            status: 'LOCKED',
            lockedAt: new Date(),
          },
          paymentEvents: [
            {
              id: 'pe-1',
              status: 'SUCCEEDED',
              amountIncGstCents: 11000,
              stripePaymentIntentId: 'pi_1',
            },
          ],
        }),
      },
    };
    const result = await makeService(prisma).getJobForSender(sender, 'job-1');
    expect(result.assignment).toMatchObject({
      id: 'asg-1',
      paidAndConfirmed: true,
    });
    expect(result.payment).toMatchObject({ id: 'pe-1', stripePaymentIntentId: 'pi_1' });
    expect(result.proposals?.[0]).toMatchObject({
      id: 'prop-1',
      carrierLabel: expect.stringMatching(/^Carrier /),
    });
  });

  it('getJobForSender 404 when job missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).getJobForSender(sender, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publishJob DRAFT → BIDDING happy path', async () => {
    const draft = mapJobFields({
      status: JobStatus.DRAFT,
      siteDisclaimerAcceptedAt: new Date(),
    });
    const bidding = mapJobFields({
      status: JobStatus.BIDDING,
      publishedAt: new Date(),
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue(draft),
        update: jest
          .fn()
          .mockResolvedValueOnce({ ...draft, status: JobStatus.PUBLISHED })
          .mockResolvedValueOnce(bidding),
      },
    };
    const result = await makeService(prisma).publishJob(sender, 'job-1');
    expect(result.status).toBe(JobStatus.BIDDING);
    expect(prisma.job.update).toHaveBeenCalledTimes(2);
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('publishJob rejects when sender not booking-ready or missing receiver/disclaimer', async () => {
    senderService.getBookingEligibility.mockResolvedValueOnce({
      canBook: false,
      goNoGo: { payment: false },
    });
    await expect(
      makeService({ isConnected: () => true }).publishJob(sender, 'job-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue(
          mapJobFields({
            status: JobStatus.DRAFT,
            receiverEmail: null,
            receiverName: 'R',
            siteDisclaimerAcceptedAt: new Date(),
          }),
        ),
        update: jest.fn(),
      },
    };
    await expect(makeService(prisma).publishJob(sender, 'job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    prisma.job.findFirst.mockResolvedValue(
      mapJobFields({
        status: JobStatus.DRAFT,
        siteDisclaimerAcceptedAt: null,
      }),
    );
    await expect(makeService(prisma).publishJob(sender, 'job-1')).rejects.toThrow(
      /Site disclaimer/,
    );
  });

  it('assertJobOpenForBidding accepts BIDDING/PUBLISHED and rejects others', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.BIDDING,
          stops: [],
          originRegion: null,
          senderCompany: { homeRegion: null },
        }),
      },
    };
    await expect(makeService(prisma).assertJobOpenForBidding('job-1')).resolves.toMatchObject({
      id: 'job-1',
    });

    prisma.job.findUnique.mockResolvedValue({
      id: 'job-1',
      status: JobStatus.DRAFT,
      stops: [],
      originRegion: null,
      senderCompany: null,
    });
    await expect(makeService(prisma).assertJobOpenForBidding('job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    prisma.job.findUnique.mockResolvedValue(null);
    await expect(makeService(prisma).assertJobOpenForBidding('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('acceptProposal delegates to payments', async () => {
    const payments = {
      acceptProposal: jest.fn().mockResolvedValue({ ok: true }),
    };
    const service = new JobsService(
      { isConnected: () => true } as never,
      audit as never,
      senderService as never,
      payments as never,
    );
    await expect(service.acceptProposal(sender, 'job-1', 'prop-1')).resolves.toEqual({
      ok: true,
    });
    expect(payments.acceptProposal).toHaveBeenCalledWith(sender, 'job-1', 'prop-1');
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { JobsService } from './jobs.service';

describe('JobsService assertJobOpenForBidding leftovers', () => {
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
  });

  it('returns job when BIDDING or PUBLISHED', async () => {
    const job = {
      id: 'job-1',
      status: JobStatus.BIDDING,
      stops: [],
      originRegion: { code: 'VIC' },
      senderCompany: { homeRegion: { code: 'VIC' } },
    };
    const prisma = {
      isConnected: () => true,
      job: { findUnique: jest.fn().mockResolvedValue(job) },
    };
    await expect(
      makeService(prisma).assertJobOpenForBidding('job-1'),
    ).resolves.toMatchObject({ id: 'job-1', status: JobStatus.BIDDING });

    prisma.job.findUnique.mockResolvedValue({ ...job, status: JobStatus.PUBLISHED });
    await expect(
      makeService(prisma).assertJobOpenForBidding('job-1'),
    ).resolves.toMatchObject({ status: JobStatus.PUBLISHED });
  });

  it('404 when job missing', async () => {
    const prisma = {
      isConnected: () => true,
      job: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).assertJobOpenForBidding('missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when job not open for bidding', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.DRAFT,
          stops: [],
          originRegion: null,
          senderCompany: null,
        }),
      },
    };
    await expect(
      makeService(prisma).assertJobOpenForBidding('job-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

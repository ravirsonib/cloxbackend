import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { AdminService } from './admin.service';

describe('AdminService jobs', () => {
  const audit = { recordPlatform: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new AdminService(prisma as never, audit as never, {
      sendAccountSuspendedEmail: jest.fn(),
    } as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hardDeleteJob rejects non-eligible status', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.BIDDING,
          title: 'Live',
          senderCompanyId: 'co-s',
          trip: null,
          assignment: null,
        }),
      },
    };
    await expect(makeService(prisma).hardDeleteJob('job-1', 'admin-1')).rejects.toMatchObject({
      response: { code: 'JOB_HARD_DELETE_NOT_ALLOWED' },
    });
  });

  it('hardDeleteJob deletes DRAFT job', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.DRAFT,
          title: 'Draft',
          senderCompanyId: 'co-s',
          trip: null,
          assignment: null,
        }),
        delete: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          surcharge: { deleteMany: jest.fn() },
          tripLocationSample: { deleteMany: jest.fn() },
          tripStopProgress: { deleteMany: jest.fn() },
          tripException: { updateMany: jest.fn(), deleteMany: jest.fn() },
          trip: { delete: jest.fn() },
          assignment: { delete: jest.fn() },
          proposal: { deleteMany: jest.fn() },
          paymentEvent: { deleteMany: jest.fn() },
          settlementLine: { deleteMany: jest.fn() },
          job: { delete: jest.fn() },
        }),
      ),
    };
    const result = await makeService(prisma).hardDeleteJob('job-1', 'admin-1');
    expect(result).toEqual({ id: 'job-1', deleted: true, mode: 'hard' });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.deleted', entityId: 'job-1' }),
    );
  });

  it('softDeleteJob cancels ASSIGNED job', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.ASSIGNED,
          title: 'Assigned',
          trip: { id: 'trip-1', status: 'IN_TRANSIT' },
          assignment: { id: 'asg-1', status: 'LOCKED' },
        }),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          proposal: { updateMany: jest.fn() },
          assignment: { update: jest.fn() },
          trip: { update: jest.fn() },
          job: { update: jest.fn() },
        }),
      ),
    };
    const result = await makeService(prisma).softDeleteJob('job-1', 'admin-1');
    expect(result.mode).toBe('soft');
    expect(result.status).toBe(JobStatus.CANCELLED);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.cancelled' }),
    );
  });

  it('softDeleteJob rejects already cancelled', async () => {
    const prisma = {
      isConnected: () => true,
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.CANCELLED,
          trip: null,
          assignment: null,
        }),
      },
    };
    await expect(makeService(prisma).softDeleteJob('job-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getJob 404 when missing', async () => {
    const prisma = {
      isConnected: () => true,
      job: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(makeService(prisma).getJob('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

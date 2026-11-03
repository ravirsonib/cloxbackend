import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, JobStatus, ProposalStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { JobsService } from './jobs.service';
import { MatchingService } from '../matching/matching.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('JobsService.cancelJob & MatchingService.withdrawProposal paths', () => {
  it('cancelJob: rejects already cancelled job', async () => {
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-sender' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompanyId: 'co-sender',
          status: JobStatus.CANCELLED,
          proposals: [],
          assignment: null,
        }),
      },
    };
    const audit: any = { recordPlatform: jest.fn() };
    const senderService: any = {};
    const payments: any = {};

    const service = new JobsService(prisma, audit, senderService, payments);
    await expect(service.cancelJob(senderPrincipal, 'job-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('cancelJob: rejects if assignment is LOCKED', async () => {
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-sender' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompanyId: 'co-sender',
          status: JobStatus.PUBLISHED,
          assignment: { status: AssignmentStatus.LOCKED },
          proposals: [],
        }),
      },
    };
    const audit: any = { recordPlatform: jest.fn() };
    const senderService: any = {};
    const payments: any = {};

    const service = new JobsService(prisma, audit, senderService, payments);
    await expect(service.cancelJob(senderPrincipal, 'job-1')).rejects.toThrow(
      'Cannot cancel job after assignment is confirmed and locked',
    );
  });

  it('cancelJob: happy path expires open proposals and marks job CANCELLED', async () => {
    const updateJobMock = jest.fn();
    const updateProposalMock = jest.fn();
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-sender' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Melbourne to Sydney',
          senderCompanyId: 'co-sender',
          status: JobStatus.BIDDING,
          assignment: null,
          proposals: [
            {
              id: 'prop-1',
              carrierCompany: {
                users: [{ id: 'u-carrier', email: 'c@yopmail.com' }],
              },
            },
          ],
        }),
      },
      $transaction: jest.fn(async (callback) => {
        return callback({
          job: { update: updateJobMock },
          assignment: { update: jest.fn() },
          proposal: { updateMany: updateProposalMock },
        });
      }),
    };
    const audit: any = { recordPlatform: jest.fn() };
    const senderService: any = {};
    const payments: any = {};
    const inbox: any = { notifyUsers: jest.fn() };

    const service = new JobsService(prisma, audit, senderService, payments, undefined, inbox);
    const result = await service.cancelJob(senderPrincipal, 'job-1');

    expect(result.status).toBe(JobStatus.CANCELLED);
    expect(updateJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: { status: JobStatus.CANCELLED },
      }),
    );
    expect(updateProposalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: 'job-1', status: ProposalStatus.SUBMITTED },
        data: { status: ProposalStatus.EXPIRED },
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job.cancelled',
        entityId: 'job-1',
      }),
    );
    expect(inbox.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['u-carrier'],
      }),
    );
  });

  it('withdrawProposal: rejects if proposal not found', async () => {
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-carrier' }),
      },
      proposal: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new MatchingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(service.withdrawProposal(carrierPrincipal, 'prop-unknown')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('withdrawProposal: rejects if already accepted', async () => {
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-carrier' }),
      },
      proposal: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prop-1',
          carrierCompanyId: 'co-carrier',
          status: ProposalStatus.ACCEPTED,
          job: { assignment: null },
        }),
      },
    };
    const service = new MatchingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(service.withdrawProposal(carrierPrincipal, 'prop-1')).rejects.toThrow(
      'Cannot withdraw proposal with status ACCEPTED',
    );
  });

  it('withdrawProposal: happy path transitions to WITHDRAWN and logs audit', async () => {
    const updateMock = jest.fn().mockResolvedValue({
      id: 'prop-1',
      jobId: 'job-1',
      status: ProposalStatus.WITHDRAWN,
    });
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-carrier' }),
      },
      proposal: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prop-1',
          carrierCompanyId: 'co-carrier',
          status: ProposalStatus.SUBMITTED,
          jobId: 'job-1',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
          job: { assignment: null },
        }),
        update: updateMock,
      },
    };
    const audit: any = { recordPlatform: jest.fn() };
    const service = new MatchingService(
      prisma,
      audit,
      {} as any,
      {} as any,
    );

    const result = await service.withdrawProposal(carrierPrincipal, 'prop-1');
    expect(result.status).toBe(ProposalStatus.WITHDRAWN);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data: { status: ProposalStatus.WITHDRAWN },
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proposal.withdrawn',
        entityId: 'prop-1',
      }),
    );
  });

  it('withdrawProposalByJobId: finds active proposal and withdraws it', async () => {
    const updateMock = jest.fn().mockResolvedValue({
      id: 'prop-1',
      jobId: 'job-1',
      status: ProposalStatus.WITHDRAWN,
    });
    const prisma: any = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-carrier' }),
      },
      proposal: {
        findFirst: jest
          .fn()
          // First call from withdrawProposalByJobId
          .mockResolvedValueOnce({ id: 'prop-1' })
          // Second call from withdrawProposal
          .mockResolvedValueOnce({
            id: 'prop-1',
            carrierCompanyId: 'co-carrier',
            status: ProposalStatus.SUBMITTED,
            jobId: 'job-1',
            vehicleId: 'veh-1',
            driverId: 'drv-1',
            job: { assignment: null },
          }),
        update: updateMock,
      },
    };
    const audit: any = { recordPlatform: jest.fn() };
    const service = new MatchingService(
      prisma,
      audit,
      {} as any,
      {} as any,
    );

    const result = await service.withdrawProposalByJobId(carrierPrincipal, 'job-1');
    expect(result.status).toBe(ProposalStatus.WITHDRAWN);
  });
});

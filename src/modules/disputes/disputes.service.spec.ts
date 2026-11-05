import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DisputesService } from './disputes.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AdminRole,
  AppRole,
  DisputeRuling,
  DisputeStatus,
} from '../../shared/types';

describe('DisputesService', () => {
  const superPrincipal: AuthenticatedPrincipal = {
    id: 'super-admin-1',
    email: 'super@clox.com.au',
    role: AdminRole.SUPER_ADMIN,
    kind: 'admin',
    regionCodes: [],
    territoryCodes: [],
  };

  const statePrincipal: AuthenticatedPrincipal = {
    id: 'state-admin-vic',
    email: 'state.vic@clox.com.au',
    role: AdminRole.STATE_MASTER,
    kind: 'admin',
    regionCodes: ['VIC'],
    territoryCodes: [],
  };

  const localPrincipal: AuthenticatedPrincipal = {
    id: 'local-bde-melb',
    email: 'local.melb@clox.com.au',
    role: AdminRole.LOCAL_BDE,
    kind: 'admin',
    regionCodes: ['VIC'],
    territoryCodes: ['MELB_CBD'],
  };

  const senderPrincipal: AuthenticatedPrincipal = {
    id: 'sender-user-1',
    email: 'sender@acme.com.au',
    role: AppRole.SENDER,
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  it('rejects create if user company is not associated with the job', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: senderPrincipal.id,
          companyId: 'company-other',
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompanyId: 'company-sender-1',
          assignment: { carrierCompanyId: 'company-carrier-1' },
        }),
      },
      dispute: { count: jest.fn().mockResolvedValue(0) },
    };

    const audit = { recordPlatform: jest.fn() };
    const service = new DisputesService(prisma as never, audit as never);

    await expect(
      service.create(senderPrincipal, {
        jobId: 'job-1',
        type: 'WAITING_SURCHARGE',
        reason: 'Unfair waiting charge',
        description: 'Driver arrived earlier than scheduled window',
        evidenceUrls: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows Local BDE to complete triage checklist and transitions status to TRIAGED', async () => {
    const mockDispute = {
      id: 'disp-1',
      disputeNumber: 'D-8801',
      status: DisputeStatus.OPEN_TRIAGE,
      jobId: 'job-1',
      contactedSender: false,
      contactedCarrier: false,
      evidenceComplete: false,
      territory: { code: 'MELB_CBD' },
      region: { code: 'VIC' },
    };

    const prisma = {
      dispute: {
        findUnique: jest.fn().mockResolvedValue(mockDispute),
        update: jest.fn().mockImplementation(({ data }) => ({
          ...mockDispute,
          ...data,
        })),
      },
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new DisputesService(prisma as never, audit as never);

    const result = await service.triage(localPrincipal, 'disp-1', {
      contactedSender: true,
      contactedCarrier: true,
      evidenceComplete: true,
      triageNotes: 'Both parties contacted, evidence verified.',
    });

    expect(result.status).toBe(DisputeStatus.TRIAGED);
    expect(result.contactedSender).toBe(true);
    expect(result.contactedCarrier).toBe(true);
    expect(result.evidenceComplete).toBe(true);
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('allows Local BDE to escalate to STATE, and State Master to escalate to SUPER', async () => {
    const mockDispute = {
      id: 'disp-1',
      disputeNumber: 'D-8801',
      status: DisputeStatus.TRIAGED,
      territory: { code: 'MELB_CBD' },
      region: { code: 'VIC' },
      triageNotes: 'Checked locally',
    };

    const prisma = {
      dispute: {
        findUnique: jest.fn().mockResolvedValue(mockDispute),
        update: jest.fn().mockImplementation(({ data }) => ({
          ...mockDispute,
          ...data,
        })),
      },
      platformSettings: {
        findUnique: jest.fn().mockResolvedValue({ enableStateMasterTier: true }),
      },
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new DisputesService(prisma as never, audit as never);

    // Local escalates to STATE (when State tier enabled)
    const stateEscalated = await service.escalate(localPrincipal, 'disp-1', {
      target: 'STATE',
      notes: 'Requires State Master review',
    });
    expect(stateEscalated.status).toBe(DisputeStatus.ESCALATED_STATE);

    // State Master escalates to SUPER
    const superEscalated = await service.escalate(statePrincipal, 'disp-1', {
      target: 'SUPER',
      notes: 'Cross-border policy conflict',
    });
    expect(superEscalated.status).toBe(DisputeStatus.ESCALATED_SUPER);
  });

  it('routes escalation directly to Super Admin when enableStateMasterTier is false', async () => {
    const mockDispute = {
      id: 'disp-2',
      disputeNumber: 'D-8802',
      status: DisputeStatus.TRIAGED,
      region: { code: 'VIC' },
      territory: { code: 'MELB_CBD' },
      triageNotes: 'Local triage complete',
    };

    const prisma = {
      dispute: {
        findUnique: jest.fn().mockResolvedValue(mockDispute),
        update: jest.fn().mockImplementation(({ data }) => ({
          ...mockDispute,
          ...data,
        })),
      },
      platformSettings: {
        findUnique: jest.fn().mockResolvedValue({ enableStateMasterTier: false }),
      },
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new DisputesService(prisma as never, audit as never);

    // Target 'STATE' automatically routes to ESCALATED_SUPER when State Master tier is disabled
    const escalatedToSuper = await service.escalate(localPrincipal, 'disp-2', {
      target: 'STATE',
      notes: 'Bypassing State directly to Super Admin',
    });
    expect(escalatedToSuper.status).toBe(DisputeStatus.ESCALATED_SUPER);

    // Local BDE can also directly specify 'SUPER'
    const directlySuper = await service.escalate(localPrincipal, 'disp-2', {
      target: 'SUPER',
      notes: 'Direct Super escalation',
    });
    expect(directlySuper.status).toBe(DisputeStatus.ESCALATED_SUPER);
  });

  it('prevents State Master from resolving a dispute escalated to Super Admin', async () => {
    const mockDispute = {
      id: 'disp-1',
      disputeNumber: 'D-8801',
      status: DisputeStatus.ESCALATED_SUPER,
      region: { code: 'VIC' },
    };

    const prisma = {
      dispute: {
        findUnique: jest.fn().mockResolvedValue(mockDispute),
      },
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new DisputesService(prisma as never, audit as never);

    await expect(
      service.resolve(statePrincipal, 'disp-1', {
        ruling: DisputeRuling.FAVOR_SENDER,
        rulingNotes: 'State Master ruling',
        financialAdjustment: 'WAIVE_SURCHARGE',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows Super Admin to resolve dispute and waives surcharge if ruling favors sender', async () => {
    const mockDispute = {
      id: 'disp-1',
      disputeNumber: 'D-8801',
      status: DisputeStatus.ESCALATED_SUPER,
      surchargeId: 'sur-1',
      region: { code: 'VIC' },
    };

    const updateDisputeMock = jest.fn().mockResolvedValue({
      ...mockDispute,
      status: DisputeStatus.RESOLVED,
      ruling: DisputeRuling.FAVOR_SENDER,
    });
    const updateSurchargeMock = jest.fn().mockResolvedValue({ id: 'sur-1', status: 'WAIVED' });

    const prisma = {
      dispute: {
        findUnique: jest.fn().mockResolvedValue(mockDispute),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback({
          dispute: { update: updateDisputeMock },
          surcharge: { update: updateSurchargeMock },
        });
      }),
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new DisputesService(prisma as never, audit as never);

    const result = await service.resolve(superPrincipal, 'disp-1', {
      ruling: DisputeRuling.FAVOR_SENDER,
      rulingNotes: 'GPS logs show driver did not dwell inside the site perimeter for 30m.',
      financialAdjustment: 'WAIVE_SURCHARGE',
    });

    expect(result.status).toBe(DisputeStatus.RESOLVED);
    expect(updateDisputeMock).toHaveBeenCalled();
    expect(updateSurchargeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sur-1' },
        data: expect.objectContaining({ status: 'WAIVED' }),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalled();
  });
});

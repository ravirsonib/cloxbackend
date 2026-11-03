import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { OpsService } from './ops.service';
import { AppRole } from '../../shared/types';

const config = {
  get: (k: string) => (k === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
};

describe('OpsService.provisionAdmin paths', () => {
  const superP = {
    id: 'super-1',
    email: 'super@x.com',
    role: AppRole.SUPER_ADMIN,
    kind: 'admin' as const,
    regionCodes: [] as string[],
    territoryCodes: [] as string[],
  };

  it('requires territoryCode for LOCAL_BDE', async () => {
    const prisma = {
      isConnected: () => true,
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(
      service.provisionAdmin(superP, {
        email: 'local@x.com',
        role: AdminRole.LOCAL_BDE,
        regionCode: 'VIC',
        name: 'Local',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound for unknown region', async () => {
    const prisma = {
      isConnected: () => true,
      region: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(
      service.provisionAdmin(superP, {
        email: 'x@x.com',
        role: AdminRole.STATE_MASTER,
        regionCode: 'ZZZ',
        name: 'X',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates STATE_MASTER with nested STATE scope', async () => {
    const createdAdmin = {
      id: 'adm-1',
      email: 'state@x.com',
      role: AdminRole.STATE_MASTER,
      name: 'State',
      phone: null,
      status: 'INVITED',
      active: false,
      companyId: 'co-1',
      leadId: null,
      scopes: [
        {
          scopeType: 'STATE',
          region: { code: 'VIC' },
          localTerritory: null,
        },
      ],
      company: { id: 'co-1', legalName: 'State' },
    };
    const tx = {
      company: {
        create: jest.fn().mockResolvedValue({ id: 'co-1' }),
      },
      adminUser: {
        create: jest.fn().mockResolvedValue(createdAdmin),
      },
      lead: { update: jest.fn() },
    };
    const prisma = {
      isConnected: () => true,
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new OpsService(
      prisma as never,
      audit as never,
      {
        sendAdminInviteEmail: jest.fn().mockResolvedValue({ skipped: true }),
      } as never,
      config as never,
    );

    const result = await service.provisionAdmin(superP, {
      email: 'state@x.com',
      role: AdminRole.STATE_MASTER,
      regionCode: 'VIC',
      name: 'State',
    });

    expect(tx.adminUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'state@x.com',
          role: AdminRole.STATE_MASTER,
          scopes: {
            create: expect.objectContaining({
              regionId: 'reg-vic',
            }),
          },
        }),
      }),
    );
    expect(result).toMatchObject({
      email: 'state@x.com',
      scopes: [{ regionCode: 'VIC' }],
      invite: expect.objectContaining({ mailSkipped: true }),
    });
  });

  it('throws NotFound for unknown LOCAL_BDE territory', async () => {
    const prisma = {
      isConnected: () => true,
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(
      service.provisionAdmin(superP, {
        email: 'local@x.com',
        role: AdminRole.LOCAL_BDE,
        regionCode: 'VIC',
        territoryCode: 'MISSING',
        name: 'Local',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publishPolicyStub creates policy version', async () => {
    const prisma = {
      isConnected: () => true,
      policyVersion: {
        create: jest.fn().mockResolvedValue({
          id: 'pv-1',
          key: 'pilot.enabled_states',
          version: 123,
        }),
      },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(service.publishPolicyStub(superP)).resolves.toEqual({
      id: 'pv-1',
      key: 'pilot.enabled_states',
      version: 123,
    });
  });

  describe('setRegionEnabled', () => {
    it('updates region enabled status and records audit', async () => {
      const prisma = {
        isConnected: () => true,
        region: {
          findUnique: jest.fn().mockResolvedValue({ id: 'reg-qld', code: 'QLD', name: 'Queensland', enabled: false }),
          update: jest.fn().mockResolvedValue({ id: 'reg-qld', code: 'QLD', name: 'Queensland', enabled: true }),
        },
      };
      const audit = { recordPlatform: jest.fn().mockResolvedValue(undefined) };
      const service = new OpsService(
        prisma as never,
        audit as never,
        { sendAdminProvisionedEmail: jest.fn() } as never,
        config as never,
      );

      const res = await service.setRegionEnabled(superP, 'qld', true);
      expect(res).toEqual({
        id: 'reg-qld',
        code: 'QLD',
        name: 'Queensland',
        enabled: true,
      });
      expect(prisma.region.update).toHaveBeenCalledWith({
        where: { code: 'QLD' },
        data: { enabled: true },
      });
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'geography.region_updated',
          actorAdminId: 'super-1',
          entityId: 'reg-qld',
        }),
      );
    });

    it('throws NotFoundException for unknown region code', async () => {
      const prisma = {
        isConnected: () => true,
        region: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const service = new OpsService(
        prisma as never,
        { record: jest.fn() } as never,
        { sendAdminProvisionedEmail: jest.fn() } as never,
        config as never,
      );

      await expect(service.setRegionEnabled(superP, 'XYZ', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('OpsService.listBdeTeam & team coaching (OPS-STA-TEAM-01 & 02)', () => {
    const stateMasterP = {
      id: 'state-admin-1',
      email: 'vic.master@clox.com.au',
      role: AdminRole.STATE_MASTER,
      kind: 'admin' as const,
      regionCodes: ['VIC'],
      territoryCodes: [] as string[],
    };

    it('returns BDE team members scoped to State Master region with SLA telemetry', async () => {
      const prisma = {
        isConnected: () => true,
        region: {
          findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC', name: 'Victoria' }),
        },
        adminUser: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'bde-1',
              email: 'geelong.bde@clox.com.au',
              name: 'Geelong Operator',
              phone: '0411000111',
              status: 'ACTIVE',
              active: true,
              scopes: [
                {
                  localTerritoryId: 'terr-geelong',
                  localTerritory: { id: 'terr-geelong', code: 'GEELONG', name: 'Greater Geelong' },
                },
              ],
              prospects: [{ id: 'p1', stage: 'LEAD' }, { id: 'p2', stage: 'ONBOARDING' }],
            },
          ]),
        },
        dispute: {
          count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1), // 2 open, 1 overdue
        },
        settlementLine: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 45000 } }),
        },
      };

      const service = new OpsService(
        prisma as never,
        { recordPlatform: jest.fn() } as never,
        { sendAdminProvisionedEmail: jest.fn() } as never,
        config as never,
      );

      const res = await service.listBdeTeam(stateMasterP);
      expect(res.regionCode).toBe('VIC');
      expect(res.regionName).toBe('Victoria');
      expect(res.members).toHaveLength(1);
      expect(res.members[0].territoryCode).toBe('GEELONG');
      expect(res.members[0].slaStatus).toBe('BREACHED'); // Since 1 overdue
      expect(res.members[0].accruedRevenueCents).toBe(45000);
    });

    it('adds coaching note to BDE profile and creates audit record', async () => {
      const bdeRecord = {
        id: 'bde-1',
        email: 'bde@clox.com.au',
        role: AdminRole.LOCAL_BDE,
        status: 'ACTIVE',
        active: true,
        scopes: [
          {
            localTerritoryId: 'terr-1',
            localTerritory: { id: 'terr-1', code: 'MELB_CBD', region: { code: 'VIC' } },
          },
        ],
        profileJson: {},
        prospects: [],
        createdAt: new Date(),
      };

      const audit = { recordPlatform: jest.fn() };
      const prisma = {
        isConnected: () => true,
        adminUser: {
          findUnique: jest.fn().mockResolvedValue(bdeRecord),
          update: jest.fn().mockResolvedValue(bdeRecord),
        },
        dispute: { findMany: jest.fn().mockResolvedValue([]) },
        settlementLine: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 } }) },
      };

      const service = new OpsService(
        prisma as never,
        audit as never,
        { sendAdminProvisionedEmail: jest.fn() } as never,
        config as never,
      );

      await service.addBdeCoachingNote(stateMasterP, 'bde-1', {
        text: 'Follow up on the 2 overdue triage cases today.',
      });

      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bde-1' },
          data: expect.objectContaining({
            profileJson: expect.objectContaining({
              coachingNotes: expect.arrayContaining([
                expect.objectContaining({
                  text: 'Follow up on the 2 overdue triage cases today.',
                  authorId: 'state-admin-1',
                }),
              ]),
            }),
          }),
        }),
      );
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.coaching_note_added',
          actorAdminId: 'state-admin-1',
          entityId: 'bde-1',
        }),
      );
    });
  });
});

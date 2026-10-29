import { AdminRole, AdminUserStatus } from '@prisma/client';
import { RevenueSplitService } from './revenue-split.service';

describe('RevenueSplitService.resolveForJob (per-admin packages)', () => {
  const regionId = '11111111-1111-1111-1111-111111111111';
  const territoryId = '22222222-2222-2222-2222-222222222222';
  const amitId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const priyaId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const stateId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  function buildService(opts: {
    referredBy: string | null;
    packageFor?: {
      adminUserId: string;
      id: string;
      superPercent: number;
      statePercent: number;
      localPercent: number;
    } | null;
    referrer?: { id: string; role: AdminRole; status: AdminUserStatus; active: boolean } | null;
  }) {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          referredByAdminUserId: opts.referredBy,
        }),
      },
      policyVersion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'pol-1',
            payload: {
              carrierPercent: 70,
              superPercent: 15,
              statePercent: 10,
              localPercent: 5,
            },
            publishedAt: new Date('2020-01-01'),
          },
        ]),
      },
      adminRevenueSplitPackage: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { adminUserId: string } }) => {
          if (opts.packageFor && where.adminUserId === opts.packageFor.adminUserId) {
            return Promise.resolve({
              id: opts.packageFor.id,
              adminUserId: opts.packageFor.adminUserId,
              superPercent: opts.packageFor.superPercent,
              statePercent: opts.packageFor.statePercent,
              localPercent: opts.packageFor.localPercent,
              effectiveFrom: new Date('2020-01-01'),
              publishedAt: new Date('2020-01-01'),
            });
          }
          return Promise.resolve(null);
        }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(opts.referrer ?? null),
      },
      adminScope: {
        findFirst: jest.fn().mockResolvedValue({ adminUserId: stateId }),
      },
    };

    return new RevenueSplitService(prisma as never, { recordPlatform: jest.fn() } as never);
  }

  it('uses Amit package and pays Amit as Local; Priya package unused', async () => {
    const service = buildService({
      referredBy: amitId,
      packageFor: {
        adminUserId: amitId,
        id: 'pkg-amit',
        superPercent: 12,
        statePercent: 8,
        localPercent: 10,
      },
      referrer: {
        id: amitId,
        role: AdminRole.LOCAL_BDE,
        status: AdminUserStatus.ACTIVE,
        active: true,
      },
    });

    const resolved = await service.resolveForJob({
      grossIncGstCents: 10_000,
      originRegionId: regionId,
      originTerritoryId: territoryId,
      senderCompanyId: 'sender-1',
    });

    expect(resolved.adminPackageId).toBe('pkg-amit');
    expect(resolved.percents).toEqual({
      carrierPercent: 70,
      superPercent: 12,
      statePercent: 8,
      localPercent: 10,
    });
    const local = resolved.lines.find((l) => l.bucket === 'LOCAL');
    expect(local?.adminUserId).toBe(amitId);
    expect(local?.sharePercent).toBe(10);
    expect(local?.recipientType).toBe('LOCAL_BDE');
  });

  it('uses Priya package independently on same territory', async () => {
    const service = buildService({
      referredBy: priyaId,
      packageFor: {
        adminUserId: priyaId,
        id: 'pkg-priya',
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      },
      referrer: {
        id: priyaId,
        role: AdminRole.LOCAL_BDE,
        status: AdminUserStatus.ACTIVE,
        active: true,
      },
    });

    const resolved = await service.resolveForJob({
      grossIncGstCents: 10_000,
      originRegionId: regionId,
      originTerritoryId: territoryId,
      senderCompanyId: 'sender-2',
    });

    expect(resolved.adminPackageId).toBe('pkg-priya');
    expect(resolved.percents.localPercent).toBe(5);
    const local = resolved.lines.find((l) => l.bucket === 'LOCAL');
    expect(local?.adminUserId).toBe(priyaId);
  });

  it('falls back to national when no referrer package', async () => {
    const service = buildService({
      referredBy: null,
      packageFor: null,
      referrer: null,
    });

    const resolved = await service.resolveForJob({
      grossIncGstCents: 10_000,
      originRegionId: regionId,
      originTerritoryId: territoryId,
      senderCompanyId: 'sender-organic',
    });

    expect(resolved.adminPackageId).toBeNull();
    expect(resolved.percents).toEqual({
      carrierPercent: 70,
      superPercent: 15,
      statePercent: 10,
      localPercent: 5,
    });
  });
});

import { ForbiddenException } from '@nestjs/common';
import {
  TripExceptionKind,
  TripExceptionPhase,
  TripExceptionStatus,
  TripStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ExceptionsService } from './exceptions.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const openRow = {
  id: 'ex-1',
  jobId: 'job-1',
  assignmentId: 'asg-1',
  tripId: 'trip-1',
  companyId: 'co-c',
  reportedByUserId: 'user-drv',
  kind: TripExceptionKind.VEHICLE_BREAKDOWN,
  phase: TripExceptionPhase.MID_TRIP,
  status: TripExceptionStatus.AWAITING_CARRIER,
  reasonCode: null,
  note: 'Engine',
  gpsLat: null,
  gpsLng: null,
  photoDocumentId: null,
  openedAt: new Date(Date.now() - 600_000),
  escalatedAt: null,
  resolvedAt: null,
  resolutionNote: null,
  job: { id: 'job-1', title: 'Load' },
  assignment: { vehicle: null, driver: null },
};

describe('ExceptionsService continue / escalate / watchdog', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    notifyTripExceptionOpened: jest.fn(),
    notifyTripExceptionReassigned: jest.fn(),
    notifyTripExceptionReplacementProposed: jest.fn().mockResolvedValue([]),
    notifyTripExceptionReplacementRejected: jest.fn().mockResolvedValue([]),
    notifyTripExceptionContinued: jest.fn().mockResolvedValue([]),
    notifyTripExceptionEscalated: jest
      .fn()
      .mockResolvedValue({ opsNotified: true }),
    notifyTripExceptionReleased: jest.fn().mockResolvedValue([]),
  };
  const carrier = { reassignAssignment: jest.fn() };
  const config = {
    get: (key: string) => {
      if (key === 'EXCEPTION_ESCALATION_MS') return 300_000;
      if (key === 'NOTIFY_EMAIL') return 'ops@yopmail.com';
      return undefined;
    },
  };

  function makeService(
    prisma: Record<string, unknown>,
    inboxExtras?: Record<string, unknown>,
  ) {
    return new ExceptionsService(
      prisma as never,
      audit as never,
      notifications as never,
      {
        userIdsForCompanies: jest.fn().mockResolvedValue([]),
        notifyUsers: jest.fn().mockResolvedValue(0),
        adminIdsSuperAndStateForRegion: jest.fn().mockResolvedValue(['super-1', 'state-1']),
        notifyAdmins: jest.fn().mockResolvedValue(2),
        ...inboxExtras,
      } as never,
      carrier as never,
      { adjustForMarketplaceRelease: jest.fn() } as never,
      config as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('continueTrip resolves and notifies', async () => {
    const updated = {
      ...openRow,
      status: TripExceptionStatus.RESOLVED_CONTINUED,
      resolvedAt: new Date(),
      resolutionNote: 'Fixed | ETA: 30m',
    };
    const tripUpdate = jest.fn();
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-carrier', companyId: 'co-c' })
          .mockResolvedValueOnce({ email: 'driver@yopmail.com' }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue(openRow),
        update: jest.fn().mockResolvedValue(updated),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'c@yopmail.com',
          users: [{ email: 'c@yopmail.com' }],
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Load',
          receiverEmail: 's@yopmail.com',
          senderCompany: { email: null, users: [] },
        }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          trip: { update: tripUpdate },
          tripException: { update: jest.fn().mockResolvedValue(updated) },
        }),
      ),
    };

    const result = await makeService(prisma).continueTrip(carrierPrincipal, 'ex-1', {
      note: 'Fixed',
      etaNote: '30m',
    });

    expect(result.exception.status).toBe(TripExceptionStatus.RESOLVED_CONTINUED);
    expect(tripUpdate).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: {
        status: TripStatus.EN_ROUTE_PICKUP,
        safetyNotes: '[CONTINUE] Fixed | ETA: 30m',
      },
    });
    expect(notifications.notifyTripExceptionContinued).toHaveBeenCalled();
  });

  it('escalate notifies Ops + sender', async () => {
    const updated = {
      ...openRow,
      status: TripExceptionStatus.ESCALATED,
      escalatedAt: new Date(),
      resolutionNote: 'Need Ops',
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-carrier', companyId: 'co-c' })
          .mockResolvedValueOnce({ email: 'driver@yopmail.com' }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue(openRow),
        update: jest.fn().mockResolvedValue(updated),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'c@yopmail.com',
          users: [{ email: 'c@yopmail.com' }],
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Load',
          originRegionId: 'reg-vic',
          receiverEmail: 's@yopmail.com',
          senderCompany: { email: null, users: [] },
        }),
      },
    };

    const notifyAdmins = jest.fn().mockResolvedValue(2);
    const adminIdsSuperAndStateForRegion = jest
      .fn()
      .mockResolvedValue(['super-1', 'state-1']);
    const result = await makeService(prisma, {
      notifyAdmins,
      adminIdsSuperAndStateForRegion,
    }).escalate(carrierPrincipal, 'ex-1', {
      note: 'Need Ops',
    });

    expect(result.alreadyEscalated).toBe(false);
    expect(result.exception.status).toBe(TripExceptionStatus.ESCALATED);
    expect(notifications.notifyTripExceptionEscalated).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEmail: 'ops@yopmail.com',
        senderEmail: 's@yopmail.com',
        automatic: false,
      }),
    );
    expect(adminIdsSuperAndStateForRegion).toHaveBeenCalledWith('reg-vic');
    expect(notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserIds: ['super-1', 'state-1'],
        type: 'TRIP_EXCEPTION_ESCALATED',
        href: '/ops/exceptions',
        entityType: 'TripException',
        entityId: 'ex-1',
        regionId: 'reg-vic',
      }),
    );
  });

  it('escalate rejects non-carrier', async () => {
    await expect(
      makeService({ isConnected: () => true }).escalate(
        { ...carrierPrincipal, role: 'DRIVER' },
        'ex-1',
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('watchdog auto-relists stale pre-trip AWAITING_CARRIER exceptions', async () => {
    const releaseSpy = jest.spyOn(ExceptionsService.prototype, 'releaseToMarketplace');
    releaseSpy.mockResolvedValue({
      exception: { id: 'ex-stale', status: TripExceptionStatus.RESOLVED_RELISTED } as never,
      marketplaceRelease: {
        status: 'RELISTED',
        reListJob: true,
        marketplacePriority: true,
        discountPercent: 10,
        message: 'ok',
      },
      stripeAdjustment: { status: 'HELD', amountCents: 10000 },
    });

    const service = makeService({
      isConnected: () => true,
      platformSettings: {
        upsert: jest.fn().mockResolvedValue({ marketplaceRelistSlaMs: 300_000 }),
      },
      tripException: {
        findMany: jest.fn().mockResolvedValue([{ id: 'ex-stale' }]),
      },
    });

    const result = await service.runEscalationWatchdog();

    expect(result).toMatchObject({ scanned: 1, relisted: 1, escalated: 0 });
    expect(releaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'admin' }),
      'ex-stale',
      expect.objectContaining({ note: expect.stringContaining('Auto re-listed') }),
      { automatic: true },
    );
    releaseSpy.mockRestore();
  });
});

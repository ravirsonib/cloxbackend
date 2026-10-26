import {
  DriverStatus,
  TripExceptionKind,
  TripExceptionPhase,
  TripExceptionStatus,
  TripStatus,
  VehicleStatus,
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

describe('ExceptionsService rescue candidates + release', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    notifyTripExceptionOpened: jest.fn(),
    notifyTripExceptionReassigned: jest.fn(),
    notifyTripExceptionContinued: jest.fn(),
    notifyTripExceptionEscalated: jest.fn(),
    notifyTripExceptionReleased: jest.fn().mockResolvedValue([]),
  };
  const carrier = { reassignAssignment: jest.fn() };
  const config = {
    get: (key: string) => {
      if (key === 'NOTIFY_EMAIL') return 'ops@yopmail.com';
      if (key === 'EXCEPTION_ESCALATION_MS') return 300_000;
      return undefined;
    },
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ExceptionsService(
      prisma as never,
      audit as never,
      notifications as never,
      carrier as never,
      config as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('ranks a single eligible pair as unambiguous', async () => {
    const openRow = {
      id: 'ex-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      tripId: 'trip-1',
      companyId: 'co-c',
      reportedByUserId: 'user-drv',
      kind: TripExceptionKind.DRIVER_UNAVAILABLE,
      phase: TripExceptionPhase.PRE_TRIP,
      status: TripExceptionStatus.AWAITING_CARRIER,
      reasonCode: null,
      note: 'Sick',
      gpsLat: -37.8,
      gpsLng: 144.9,
      photoDocumentId: null,
      openedAt: new Date(),
      escalatedAt: null,
      resolvedAt: null,
      resolutionNote: null,
      job: { id: 'job-1', title: 'Load' },
      assignment: { vehicle: null, driver: null },
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-c' }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue(openRow),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          vehicleId: 'veh-broken',
          driverId: 'drv-sick',
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          minVehicleClass: 'UTE',
          stops: [{ lat: -37.81, lng: 144.96 }],
        }),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'veh-2',
            registration: 'ABC123',
            vehicleClass: 'UTE',
            status: VehicleStatus.ACTIVE,
          },
        ]),
      },
      driver: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'drv-2',
            licenceClass: 'C',
            licenceExpiry: new Date(Date.now() + 86_400_000),
            nhvrAcknowledgedAt: new Date(),
            status: DriverStatus.ACTIVE,
            user: { email: 'd2@yopmail.com', name: 'Relief' },
          },
        ]),
      },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
      complianceDocument: {
        findFirst: jest.fn().mockResolvedValue({ id: 'doc-ok' }),
      },
    };

    const result = await makeService(prisma).listRescueCandidates(
      carrierPrincipal,
      'ex-1',
    );

    expect(result.unambiguous).toBe(true);
    expect(result.recommended?.vehicleId).toBe('veh-2');
    expect(result.recommended?.driverId).toBe('drv-2');
    expect(result.items).toHaveLength(1);
  });

  it('release re-lists job to marketplace with priority and discount', async () => {
    const openRow = {
      id: 'ex-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      tripId: 'trip-1',
      companyId: 'co-c',
      reportedByUserId: 'user-drv',
      kind: TripExceptionKind.VEHICLE_BREAKDOWN,
      phase: TripExceptionPhase.MID_TRIP,
      status: TripExceptionStatus.ESCALATED,
      reasonCode: null,
      note: 'Engine',
      gpsLat: null,
      gpsLng: null,
      photoDocumentId: null,
      openedAt: new Date(),
      escalatedAt: new Date(),
      resolvedAt: null,
      resolutionNote: null,
      job: { id: 'job-1', title: 'Load', rescueDiscountPercent: null, marketplacePriority: false },
      assignment: { vehicle: null, driver: null },
    };
    const tripUpdate = jest.fn();
    const assignmentUpdate = jest.fn();
    const proposalUpdateMany = jest.fn();
    const jobUpdate = jest.fn();
    const exceptionUpdate = jest.fn().mockResolvedValue({
      ...openRow,
      status: TripExceptionStatus.RESOLVED_RELISTED,
      resolvedAt: new Date(),
      resolutionNote: 'Cannot rescue',
      job: {
        id: 'job-1',
        title: 'Load',
        rescueDiscountPercent: 10,
        marketplacePriority: true,
      },
    });
    const companyUpdate = jest.fn();

    const prisma = {
      isConnected: () => true,
      platformSettings: {
        upsert: jest.fn().mockResolvedValue({
          id: 'default',
          rescueDiscountPercent: 10,
          marketplaceRelistSlaMs: 300_000,
          driverUnavailableScoreDelta: 5,
          carrierMarketplaceReleaseScoreDelta: 10,
        }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-carrier', companyId: 'co-c' })
          .mockResolvedValueOnce({ email: 'driver@yopmail.com' }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue(openRow),
        update: exceptionUpdate,
      },
      company: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ reliabilityScore: 100 })
          .mockResolvedValueOnce({
            email: 'c@yopmail.com',
            users: [{ email: 'c@yopmail.com' }],
          }),
        update: companyUpdate,
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
          assignment: { update: assignmentUpdate },
          proposal: { updateMany: proposalUpdateMany },
          job: { update: jobUpdate },
          tripException: { update: exceptionUpdate },
        }),
      ),
    };

    const result = await makeService(prisma).releaseToMarketplace(
      carrierPrincipal,
      'ex-1',
      { note: 'Cannot rescue' },
    );

    expect(result.exception.status).toBe(TripExceptionStatus.RESOLVED_RELISTED);
    expect(result.marketplaceRelease.reListJob).toBe(true);
    expect(result.marketplaceRelease.discountPercent).toBe(10);
    expect(result.stripeAdjustment?.status).toBe('STUB_NOT_IMPLEMENTED');
    expect(jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({
          status: 'BIDDING',
          marketplacePriority: true,
          rescueDiscountPercent: 10,
          rescuedFromExceptionId: 'ex-1',
        }),
      }),
    );
    expect(tripUpdate).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: { status: TripStatus.CANCELLED, onBreak: false, breakStartedAt: null },
    });
    expect(notifications.notifyTripExceptionReleased).toHaveBeenCalled();
    expect(companyUpdate).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: { reliabilityScore: 90 },
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exception.relisted' }),
    );
  });

  it('watchdog auto-relists pre-trip AWAITING_CARRIER past SLA', async () => {
    const releaseSpy = jest.spyOn(ExceptionsService.prototype, 'releaseToMarketplace');
    releaseSpy.mockResolvedValue({
      exception: { id: 'ex-due', status: TripExceptionStatus.RESOLVED_RELISTED } as never,
      marketplaceRelease: {
        status: 'RELISTED',
        reListJob: true,
        marketplacePriority: true,
        discountPercent: 10,
        message: 'ok',
      },
      stripeAdjustment: { status: 'STUB_NOT_IMPLEMENTED', amountCents: null },
    });

    const prisma = {
      isConnected: () => true,
      platformSettings: {
        upsert: jest.fn().mockResolvedValue({
          marketplaceRelistSlaMs: 300_000,
        }),
      },
      tripException: {
        findMany: jest.fn().mockResolvedValue([{ id: 'ex-due' }]),
      },
    };

    const result = await makeService(prisma).runEscalationWatchdog();
    expect(result).toMatchObject({ scanned: 1, relisted: 1, escalated: 0 });
    expect(releaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'admin', role: 'SUPER_ADMIN' }),
      'ex-due',
      expect.objectContaining({ note: expect.stringContaining('Auto re-listed') }),
      { automatic: true },
    );
    releaseSpy.mockRestore();
  });
});

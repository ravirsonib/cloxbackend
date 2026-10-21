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

  it('release cancels trip/assignment/job and notifies', async () => {
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
      job: { id: 'job-1', title: 'Load' },
      assignment: { vehicle: null, driver: null },
    };
    const tripUpdate = jest.fn();
    const assignmentUpdate = jest.fn();
    const jobUpdate = jest.fn();
    const exceptionUpdate = jest.fn().mockResolvedValue({
      ...openRow,
      status: TripExceptionStatus.RESOLVED_CANCELLED,
      resolvedAt: new Date(),
      resolutionNote: 'Cannot rescue',
    });

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
        update: exceptionUpdate,
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
          assignment: { update: assignmentUpdate },
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

    expect(result.exception.status).toBe(TripExceptionStatus.RESOLVED_CANCELLED);
    expect(result.stripeAdjustment.status).toBe('STUB_NOT_IMPLEMENTED');
    expect(tripUpdate).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: { status: TripStatus.CANCELLED },
    });
    expect(notifications.notifyTripExceptionReleased).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exception.performance_stub' }),
    );
  });
});

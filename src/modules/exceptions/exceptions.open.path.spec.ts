import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AssignmentStatus,
  DriverStatus,
  TripExceptionKind,
  TripExceptionPhase,
  TripExceptionStatus,
  TripStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ExceptionsService } from './exceptions.service';

const driverPrincipal: AuthenticatedPrincipal = {
  id: 'user-drv',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('ExceptionsService.open', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    notifyTripExceptionOpened: jest.fn().mockResolvedValue({ driver: { skipped: true } }),
    notifyTripExceptionReassigned: jest.fn().mockResolvedValue([]),
    notifyTripExceptionReplacementProposed: jest.fn().mockResolvedValue([]),
    notifyTripExceptionReplacementRejected: jest.fn().mockResolvedValue([]),
    notifyTripExceptionContinued: jest.fn().mockResolvedValue([]),
    notifyTripExceptionEscalated: jest.fn().mockResolvedValue({ opsNotified: true }),
    notifyBreakdownReport: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
  };
  const carrier = { reassignAssignment: jest.fn() };

  const config = {
    get: (key: string) => {
      if (key === 'EXCEPTION_ESCALATION_MS') return 300_000;
      if (key === 'NOTIFY_EMAIL') return 'ops@yopmail.com';
      if (key === 'STORAGE_LOCAL_DIR') return '.data/uploads-test';
      return undefined;
    },
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ExceptionsService(
      prisma as never,
      audit as never,
      notifications as never,
      {
        userIdsForCompanies: jest.fn().mockResolvedValue([]),
        notifyUsers: jest.fn().mockResolvedValue(0),
      } as never,
      carrier as never,
      { adjustForMarketplaceRelease: jest.fn() } as never,
      config as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('rejects non-driver', async () => {
    await expect(
      makeService({ isConnected: () => true }).open(
        { ...driverPrincipal, role: 'SENDER' },
        {
          tripId: '11111111-1111-1111-1111-111111111111',
          kind: 'DRIVER_UNAVAILABLE',
          note: 'Sick today',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('opens pre-trip unavailable, force offline, notifies', async () => {
    const created = {
      id: 'ex-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      tripId: 'trip-1',
      companyId: 'co-c',
      reportedByUserId: 'user-drv',
      kind: TripExceptionKind.DRIVER_UNAVAILABLE,
      phase: TripExceptionPhase.PRE_TRIP,
      status: TripExceptionStatus.AWAITING_CARRIER,
      reasonCode: 'PersonalEmergency',
      note: 'Sick today',
      gpsLat: null,
      gpsLng: null,
      photoDocumentId: null,
      openedAt: new Date(),
      escalatedAt: null,
      resolvedAt: null,
      resolutionNote: null,
      job: { id: 'job-1', title: 'Load A' },
      assignment: { vehicle: null, driver: null },
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-drv',
          email: 'driver@yopmail.com',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          assignmentId: 'asg-1',
          status: TripStatus.PENDING_GATES,
          assignment: {
            status: AssignmentStatus.LOCKED,
            carrierCompanyId: 'co-c',
            carrierCompany: {
              id: 'co-c',
              email: 'carrier@yopmail.com',
              legalName: 'Carrier',
              users: [{ email: 'carrier@yopmail.com' }],
            },
          },
          job: {
            id: 'job-1',
            title: 'Load A',
            receiverEmail: 'sender@yopmail.com',
            senderCompany: { email: null, users: [] },
          },
        }),
      },
      tripException: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
        update: jest.fn().mockResolvedValue({
          ...created,
          breakdownPdfStorageKey: 'trips/trip-1/ex-1/breakdown-pdf.pdf',
        }),
      },
      driver: {
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ reliabilityScore: 100 }),
      },
      platformSettings: {
        upsert: jest.fn().mockResolvedValue({ driverUnavailableScoreDelta: 5 }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          trip: { update: jest.fn() },
          driver: { update: jest.fn().mockResolvedValue({}) },
          tripException: { create: jest.fn().mockResolvedValue(created) },
        }),
      ),
    };

    const result = await makeService(prisma).open(driverPrincipal, {
      tripId: '11111111-1111-1111-1111-111111111111',
      kind: 'DRIVER_UNAVAILABLE',
      reasonCode: 'PersonalEmergency',
      note: 'Sick today',
    });

    expect(result.forceOffline).toBe(true);
    expect(result.phase).toBe(TripExceptionPhase.PRE_TRIP);
    expect(notifications.notifyTripExceptionOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        senderEmail: 'sender@yopmail.com',
        carrierEmails: expect.arrayContaining(['carrier@yopmail.com']),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exception.opened' }),
    );
  });

  it('rejects duplicate open exception', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-drv',
          email: 'driver@yopmail.com',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          assignmentId: 'asg-1',
          status: TripStatus.EN_ROUTE_PICKUP,
          assignment: {
            status: AssignmentStatus.LOCKED,
            carrierCompanyId: 'co-c',
            carrierCompany: { id: 'co-c', email: null, legalName: 'C', users: [] },
          },
          job: {
            id: 'job-1',
            title: 'J',
            receiverEmail: null,
            senderCompany: { email: null, users: [] },
          },
        }),
      },
      tripException: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ex-existing' }),
      },
    };

    try {
      await makeService(prisma).open(driverPrincipal, {
        tripId: '11111111-1111-1111-1111-111111111111',
        kind: 'VEHICLE_BREAKDOWN',
        note: 'Tyre blowout',
      });
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'EXCEPTION_ALREADY_OPEN',
      });
    }
  });

  it('rejects VEHICLE_BREAKDOWN without photo', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-drv',
          email: 'driver@yopmail.com',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          assignmentId: 'asg-1',
          status: TripStatus.IN_TRANSIT,
          assignment: {
            status: AssignmentStatus.LOCKED,
            carrierCompanyId: 'co-c',
            carrierCompany: {
              id: 'co-c',
              email: 'c@yopmail.com',
              legalName: 'C',
              users: [{ email: 'c@yopmail.com' }],
            },
          },
          job: {
            id: 'job-1',
            title: 'Load',
            receiverEmail: 's@yopmail.com',
            senderCompany: { email: null, users: [] },
          },
        }),
      },
      tripException: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    try {
      await makeService(prisma).open(driverPrincipal, {
        tripId: '11111111-1111-1111-1111-111111111111',
        kind: 'VEHICLE_BREAKDOWN',
        note: 'Engine overheat',
      });
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'PHOTO_REQUIRED',
      });
    }
  });

  it('mid-trip sets BREAKDOWN without force offline for vehicle issue', async () => {
    const created = {
      id: 'ex-2',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      tripId: 'trip-1',
      companyId: 'co-c',
      reportedByUserId: 'user-drv',
      kind: TripExceptionKind.VEHICLE_BREAKDOWN,
      phase: TripExceptionPhase.MID_TRIP,
      status: TripExceptionStatus.AWAITING_CARRIER,
      reasonCode: null,
      note: 'Engine overheat',
      gpsLat: -37.8,
      gpsLng: 144.9,
      photoDocumentId: '22222222-2222-2222-2222-222222222222',
      openedAt: new Date(),
      escalatedAt: null,
      resolvedAt: null,
      resolutionNote: null,
      job: { id: 'job-1', title: 'Load' },
      assignment: { vehicle: null, driver: null },
    };
    const tripUpdate = jest.fn();
    const driverUpdate = jest.fn();
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-drv',
          email: 'driver@yopmail.com',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          assignmentId: 'asg-1',
          status: TripStatus.IN_TRANSIT,
          assignment: {
            status: AssignmentStatus.LOCKED,
            carrierCompanyId: 'co-c',
            carrierCompany: {
              id: 'co-c',
              email: 'c@yopmail.com',
              legalName: 'C',
              users: [{ email: 'c@yopmail.com' }],
            },
          },
          job: {
            id: 'job-1',
            title: 'Load',
            receiverEmail: 's@yopmail.com',
            senderCompany: { email: null, users: [] },
          },
        }),
      },
      tripException: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({
          ...created,
          breakdownPdfStorageKey: 'trips/trip-1/ex-2/breakdown-pdf.pdf',
        }),
      },
      complianceDocument: {
        findFirst: jest.fn().mockResolvedValue({
          id: '22222222-2222-2222-2222-222222222222',
          status: 'UPLOADED',
        }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          trip: { update: tripUpdate },
          driver: { update: driverUpdate },
          tripException: { create: jest.fn().mockResolvedValue(created) },
        }),
      ),
    };

    const result = await makeService(prisma).open(driverPrincipal, {
      tripId: '11111111-1111-1111-1111-111111111111',
      kind: 'VEHICLE_BREAKDOWN',
      note: 'Engine overheat',
      gpsLat: -37.8,
      gpsLng: 144.9,
      photoDocumentId: '22222222-2222-2222-2222-222222222222',
    });

    expect(result.forceOffline).toBe(false);
    expect(result.tripStatus).toBe(TripStatus.BREAKDOWN);
    expect(tripUpdate).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: { status: TripStatus.BREAKDOWN },
    });
    expect(driverUpdate).not.toHaveBeenCalled();
    expect(notifications.notifyBreakdownReport).toHaveBeenCalled();
    expect(DriverStatus.SUSPENDED).toBeDefined();
  });
});

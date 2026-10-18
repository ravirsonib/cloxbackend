import {
  AssignmentStatus,
  JobStatus,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { TripsService } from './trips.service';

const driver: AuthenticatedPrincipal = {
  id: 'user-driver',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn().mockResolvedValue({ id: 's1' }),
    chargePendingSurchargesForTrip: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'GEOFENCE_RADIUS_METERS') return 200;
      if (key === 'MASS_TOLERANCE_PCT') return 2;
      if (key === 'GEOFENCE_FREE_WAIT_SECONDS') return undefined;
      return undefined;
    }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      config as never,
      payments as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('requireDriver 404 when driver profile missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-driver', driver: null }),
      },
    };
    await expect(makeService(prisma).listDriverTrips(driver)).rejects.toMatchObject({
      message: 'Driver profile not found',
    });
  });

  it('maps trip with null job/siteAccess and number location coords', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.EN_ROUTE_PICKUP,
      safetyPassedAt: new Date(),
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: 50,
      actualMassKg: null,
      massCheckOk: true,
      massCheckedAt: null,
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: new Date(),
      completedAt: null,
      job: null,
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'v1',
        driverId: 'drv-1',
        vehicle: null,
      },
      locations: [
        {
          lat: -37.81,
          lng: 144.96,
          recordedAt: new Date(),
        },
      ],
      stopProgress: undefined,
      surcharges: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: { findFirst: jest.fn().mockResolvedValue(trip) },
    };
    const mapped = await makeService(prisma).getDriverTrip(driver, 'trip-1');
    expect(mapped.job).toBeNull();
    expect(mapped.siteAccess).toBeNull();
    expect(mapped.latestLocation).toMatchObject({ lat: -37.81, lng: 144.96 });
    expect(mapped.stopsProgress).toEqual([]);
  });

  it('safety fail without notes; pass without notes; break off clears startedAt', async () => {
    const baseTrip = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: null as Date | null,
      safetyPassedAt: null as Date | null,
      safetyFailedAt: null as Date | null,
      safetyNotes: null as string | null,
      declaredMassKg: 100,
      actualMassKg: null,
      massCheckOk: false,
      massCheckedAt: null,
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      completedAt: null,
      status: TripStatus.PENDING_GATES,
      job: {
        title: 'J',
        status: JobStatus.ASSIGNED,
        siteManeuverability: null,
        siteFacility: null,
        deadWeightKg: null,
        chargeableWeightKg: null,
        stops: [],
      },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: null,
      },
      locations: [],
      stopProgress: [],
      surcharges: [],
    };

    const prismaFail = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(baseTrip),
        update: jest.fn().mockResolvedValue({
          ...baseTrip,
          safetyFailedAt: new Date(),
          safetyNotes: 'Pre-trip failed',
        }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ id: 'veh-1', status: VehicleStatus.ACTIVE }),
        update: jest.fn(),
      },
    };
    await makeService(prismaFail).safetyCheck(driver, 'trip-1', {
      online: true,
      passed: false,
    });
    expect(prismaFail.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          safetyNotes: expect.stringContaining('Pre-trip failed'),
        }),
      }),
    );

    const prismaPass = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(baseTrip),
        update: jest.fn().mockResolvedValue({
          ...baseTrip,
          safetyPassedAt: new Date(),
          status: TripStatus.EN_ROUTE_PICKUP,
        }),
      },
      vehicle: { findUnique: jest.fn(), update: jest.fn() },
    };
    await makeService(prismaPass).safetyCheck(driver, 'trip-1', {
      online: true,
      passed: true,
    });
    expect(prismaPass.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ safetyNotes: null }),
      }),
    );

    const started = {
      ...baseTrip,
      startedAt: new Date(),
      safetyPassedAt: new Date(),
      status: TripStatus.IN_TRANSIT,
      onBreak: true,
      breakStartedAt: new Date(),
    };
    const prismaBreak = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(started),
        update: jest.fn().mockResolvedValue({ ...started, onBreak: false, breakStartedAt: null }),
      },
    };
    await makeService(prismaBreak).toggleBreak(driver, 'trip-1', { onBreak: false });
    expect(prismaBreak.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { onBreak: false, breakStartedAt: null },
      }),
    );
  });

  it('massCheck falls back through declared/chargeable/dead weights', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: null,
      safetyPassedAt: new Date(),
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: null,
      actualMassKg: null,
      massCheckOk: false,
      massCheckedAt: null,
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      completedAt: null,
      status: TripStatus.EN_ROUTE_PICKUP,
      job: {
        title: 'J',
        status: JobStatus.ASSIGNED,
        siteManeuverability: null,
        siteFacility: null,
        deadWeightKg: null,
        chargeableWeightKg: null,
        stops: [],
      },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: null,
      },
      locations: [],
      stopProgress: [],
      surcharges: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(trip),
        update: jest.fn().mockResolvedValue({ ...trip, massCheckOk: true, actualMassKg: 80 }),
      },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await makeService(prisma).massCheck(driver, 'trip-1', {
      actualMassKg: 0,
      online: true,
    });
    expect(prisma.trip.update).toHaveBeenCalled();
  });

  it('mapStopProgress null lng + mapTrip undefined stops + Decimal geofence center', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.IN_TRANSIT,
      safetyPassedAt: new Date(),
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: 10,
      actualMassKg: 10,
      massCheckOk: true,
      massCheckedAt: new Date(),
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: new Date(),
      completedAt: null,
      job: {
        title: 'J',
        status: JobStatus.ASSIGNED,
        siteManeuverability: null,
        siteFacility: null,
        deadWeightKg: 10,
        chargeableWeightKg: 10,
        stops: undefined,
      },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: null,
      },
      locations: [],
      stopProgress: [
        {
          id: 'sp-1',
          jobStopId: 'js-1',
          currentlyInside: false,
          insideCount: 0,
          enteredAt: null,
          exitedAt: null,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
          arrivalRecorded: false,
          jobStop: {
            sequence: 1,
            stopType: 'PICKUP',
            suburb: 'Mel',
            lat: -37.8,
            lng: null,
          },
        },
        {
          id: 'sp-2',
          jobStopId: 'js-2',
          currentlyInside: false,
          insideCount: 0,
          enteredAt: null,
          exitedAt: null,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
          arrivalRecorded: false,
          jobStop: {
            sequence: 2,
            stopType: 'DROPOFF',
            suburb: 'Gee',
            lat: null,
            lng: 144.3,
          },
        },
      ],
      surcharges: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: { findFirst: jest.fn().mockResolvedValue(trip) },
    };
    const mapped = await makeService(prisma).getDriverTrip(driver, 'trip-1');
    expect(mapped.job?.stops).toEqual([]);
    expect(mapped.stopsProgress[0]?.stop).toMatchObject({ lat: -37.8, lng: null });
    expect(mapped.stopsProgress[1]?.stop).toMatchObject({ lat: null, lng: 144.3 });
  });

  it('postLocation uses recordedAt + Decimal stop coords in geofence', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: new Date(),
      onBreak: false,
      status: TripStatus.IN_TRANSIT,
      assignment: { status: AssignmentStatus.LOCKED, driverId: 'drv-1' },
      job: {
        stops: [
          {
            id: 'js-1',
            sequence: 1,
            stopType: 'PICKUP',
            lat: { toString: () => '-37.81' },
            lng: { toString: () => '144.96' },
          },
        ],
      },
      stopProgress: [],
    };
    // Number() on decimal-like objects
    Object.assign(trip.job.stops[0].lat, { valueOf: () => -37.81 });
    Object.assign(trip.job.stops[0].lng, { valueOf: () => 144.96 });

    const decimalStop = {
      id: 'js-1',
      sequence: 1,
      stopType: 'PICKUP',
      lat: { toString: () => '-37.81', valueOf: () => -37.81 },
      lng: { toString: () => '144.96', valueOf: () => 144.96 },
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(trip),
        findUnique: jest.fn().mockResolvedValue({
          ...trip,
          job: {
            stops: [decimalStop],
          },
          stopProgress: [],
        }),
      },
      tripLocationSample: {
        create: jest.fn().mockResolvedValue({ id: 'loc-1' }),
      },
      tripStopProgress: {
        create: jest.fn().mockResolvedValue({
          id: 'sp-1',
          tripId: 'trip-1',
          jobStopId: 'js-1',
          insideCount: 0,
          currentlyInside: false,
          arrivalRecorded: false,
          enteredAt: null,
          exitedAt: null,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
        }),
        update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'sp-1',
          tripId: 'trip-1',
          jobStopId: 'js-1',
          insideCount: 0,
          currentlyInside: false,
          arrivalRecorded: false,
          enteredAt: null,
          exitedAt: null,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
          ...data,
        })),
      },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await makeService(prisma).postLocation(driver, 'trip-1', {
      lat: -37.81,
      lng: 144.96,
      recordedAt: '2026-10-07T12:00:00.000Z',
    });
    expect(prisma.tripLocationSample.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recordedAt: new Date('2026-10-07T12:00:00.000Z'),
        }),
      }),
    );
  });

  it('sender track maps null stop coords', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          status: TripStatus.IN_TRANSIT,
          onBreak: false,
          startedAt: new Date(),
          job: {
            title: 'Haul',
            stops: [
              {
                sequence: 1,
                stopType: 'PICKUP',
                suburb: 'Melbourne',
                lat: null,
                lng: null,
              },
            ],
          },
          locations: [],
          assignment: null,
          stopProgress: [],
          surcharges: [],
        }),
      },
    };
    const track = await makeService(prisma).getSenderTracking(sender, 'job-1');
    expect(track.job?.stops[0]).toMatchObject({ lat: null, lng: null });
  });
});

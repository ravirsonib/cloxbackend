import { AssignmentStatus, JobStatus, TripStatus } from '@prisma/client';
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

describe('TripsService map/branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn(),
    chargePendingSurchargesForTrip: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'GEOFENCE_RADIUS_METERS') return 200;
      if (key === 'MASS_TOLERANCE_PCT') return 5;
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

  it('maps Decimal stop coords, null stopProgress jobStop, and empty locations', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.EN_ROUTE_PICKUP,
      safetyPassedAt: new Date(),
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: null,
      actualMassKg: null,
      massCheckOk: true,
      massCheckedAt: new Date(),
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: new Date(),
      completedAt: null,
      job: {
        title: 'Haul',
        status: JobStatus.IN_TRANSIT,
        siteManeuverability: 'tight',
        siteFacility: null,
        deadWeightKg: null,
        chargeableWeightKg: null,
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            suburb: 'Melbourne',
            state: 'VIC',
            lat: null,
            lng: null,
          },
          {
            sequence: 2,
            stopType: 'DROPOFF',
            suburb: 'Geelong',
            state: 'VIC',
            lat: { toNumber: () => -38.1 },
            lng: 144.3,
          },
        ],
      },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: {
          label: 'Rig',
          registration: 'ABC123',
          vehicleClass: 'RIGID_1_2T',
        },
      },
      locations: [
        {
          lat: { toNumber: () => -37.81 },
          lng: { toNumber: () => 144.96 },
          recordedAt: new Date('2026-10-07T00:00:00.000Z'),
        },
      ],
      stopProgress: [
        {
          id: 'sp-1',
          jobStopId: 'js-1',
          insideCount: 0,
          currentlyInside: false,
          enteredAt: null,
          exitedAt: null,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
          arrivalRecorded: false,
          jobStop: null,
        },
        {
          id: 'sp-2',
          jobStopId: 'js-2',
          insideCount: 1,
          currentlyInside: true,
          enteredAt: new Date(),
          exitedAt: null,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
          arrivalRecorded: true,
          jobStop: {
            sequence: 2,
            stopType: 'DROPOFF',
            suburb: 'Geelong',
            lat: -38.1,
            lng: { toNumber: () => 144.3 },
          },
        },
      ],
      surcharges: undefined,
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
    expect(mapped.job?.stops).toEqual([
      expect.objectContaining({ lat: null, lng: null }),
      expect.objectContaining({ lat: -38.1, lng: 144.3 }),
    ]);
    expect(mapped.stopsProgress?.[0].stop).toBeNull();
    expect(mapped.stopsProgress?.[1].stop).toMatchObject({
      lat: -38.1,
      lng: 144.3,
    });
    expect(mapped.latestLocation).toMatchObject({ lat: -37.81, lng: 144.96 });
    expect(mapped.surcharges).toEqual([]);
    expect(mapped.siteAccess).toMatchObject({ maneuverability: 'tight' });
  });

  it('ensureTripForAssignment with both weights null still creates trip', async () => {
    const prisma = {
      isConnected: () => true,
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asg-1',
          jobId: 'job-1',
          status: AssignmentStatus.LOCKED,
          trip: null,
          job: { deadWeightKg: null, chargeableWeightKg: null },
        }),
      },
      trip: {
        create: jest.fn().mockResolvedValue({
          id: 'trip-new',
          status: TripStatus.PENDING_GATES,
          declaredMassKg: null,
        }),
      },
    };
    const trip = await makeService(prisma).ensureTripForAssignment('asg-1');
    expect(trip).toMatchObject({ id: 'trip-new', declaredMassKg: null });
    expect(prisma.trip.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ declaredMassKg: null }),
      }),
    );
  });
});

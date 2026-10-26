import { AssignmentStatus, JobStatus, TripStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { TripsService } from './trips.service';

const driverPrincipal: AuthenticatedPrincipal = {
  id: 'user-driver',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService Phase E auto ETA approaching', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn(), chargeSurcharge: jest.fn() };
  const notifications = {
    notifyTripApproaching: jest.fn().mockResolvedValue({ sentTo: ['s@yopmail.com'], results: [] }),
    notifyTripAtDropoff: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
    notifyPodFinalized: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
    notifyTripCompletionDocuments: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      {
        get: (key: string) => {
          if (key === 'APPROACHING_ETA_MIN_MINUTES') return 15;
          if (key === 'APPROACHING_ETA_MAX_MINUTES') return 30;
          if (key === 'APPROACHING_ETA_SPEED_KMH') return 40;
          if (key === 'GEOFENCE_RADIUS_METERS') return 200;
          return undefined;
        },
      } as never,
      payments as never,
      notifications as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('sends ETA_AUTO when haversine ETA is inside 15–30 min and not yet notified', async () => {
    const stopId = 'stop-drop';
    // ~16.7 km at 40 km/h ≈ 25 minutes
    const dropLat = -37.8136;
    const dropLng = 144.9631;
    const driverLat = -37.6636;
    const driverLng = 144.9631;

    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.IN_TRANSIT,
      safetyPassedAt: new Date(),
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: 1000,
      actualMassKg: 1000,
      massCheckOk: true,
      massCheckedAt: new Date(),
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: new Date(),
      completedAt: null,
      job: {
        title: 'Hourly',
        status: JobStatus.IN_TRANSIT,
        siteManeuverability: null,
        siteFacility: null,
        deadWeightKg: 1000,
        chargeableWeightKg: 1000,
        stops: [
          {
            id: stopId,
            sequence: 0,
            stopType: 'DROPOFF',
            suburb: 'Melbourne',
            state: 'VIC',
            lat: dropLat,
            lng: dropLng,
          },
        ],
      },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: { label: 'T', registration: 'ABC', vehicleClass: 'MR' },
      },
      locations: [],
      stopProgress: [],
      surcharges: [],
    };

    const progressRow = {
      id: 'prog-1',
      tripId: 'trip-1',
      jobStopId: stopId,
      approachingNotifiedAt: null,
      enteredAt: null,
      exitedAt: null,
      podStatus: 'PENDING',
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
            ...trip.job,
            stops: trip.job.stops,
            senderCompany: {
              email: 's@yopmail.com',
              users: [{ email: 's@yopmail.com' }],
            },
          },
          assignment: {
            carrierCompany: { email: null, users: [] },
          },
          stopProgress: [],
        }),
      },
      tripLocationSample: {
        create: jest.fn().mockResolvedValue({
          id: 'loc-1',
          recordedAt: new Date(),
        }),
      },
      tripStopProgress: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(progressRow),
        update: jest.fn().mockResolvedValue({
          ...progressRow,
          approachingNotifiedAt: new Date(),
          approachingSource: 'ETA_AUTO',
        }),
      },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await makeService(prisma).postLocation(driverPrincipal, 'trip-1', {
      lat: driverLat,
      lng: driverLng,
    });
    // Auto-notify is fire-and-forget on the location path — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(notifications.notifyTripApproaching).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ETA_AUTO',
        etaLabel: expect.stringMatching(/^~\d+ min$/),
      }),
    );
    expect(prisma.tripStopProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approachingSource: 'ETA_AUTO' }),
      }),
    );
  });

  it('does not double-notify when approachingAlready sent by driver', async () => {
    const stopId = 'stop-drop';
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.IN_TRANSIT,
      safetyPassedAt: new Date(),
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: 1000,
      actualMassKg: 1000,
      massCheckOk: true,
      massCheckedAt: new Date(),
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: new Date(),
      completedAt: null,
      job: {
        title: 'Hourly',
        status: JobStatus.IN_TRANSIT,
        siteManeuverability: null,
        siteFacility: null,
        deadWeightKg: 1000,
        chargeableWeightKg: 1000,
        stops: [
          {
            id: stopId,
            sequence: 0,
            stopType: 'DROPOFF',
            suburb: 'Melbourne',
            state: 'VIC',
            lat: -37.8136,
            lng: 144.9631,
          },
        ],
      },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: { label: 'T', registration: 'ABC', vehicleClass: 'MR' },
      },
      locations: [],
      stopProgress: [
        {
          id: 'prog-1',
          jobStopId: stopId,
          approachingNotifiedAt: new Date(),
          approachingSource: 'DRIVER',
          enteredAt: null,
          exitedAt: null,
          insideCount: 0,
          currentlyInside: false,
          waitStartedAt: null,
          freeWaitEndsAt: null,
          waitOverageMinutes: 0,
          arrivalRecorded: false,
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
      trip: {
        findFirst: jest.fn().mockResolvedValue(trip),
        findUnique: jest.fn().mockResolvedValue(trip),
      },
      tripLocationSample: {
        create: jest.fn().mockResolvedValue({
          id: 'loc-1',
          recordedAt: new Date(),
        }),
      },
      tripStopProgress: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          ...trip.stopProgress[0],
          ...data,
        })),
      },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await makeService(prisma).postLocation(driverPrincipal, 'trip-1', {
      lat: -37.6636,
      lng: 144.9631,
    });

    expect(notifications.notifyTripApproaching).not.toHaveBeenCalled();
  });
});

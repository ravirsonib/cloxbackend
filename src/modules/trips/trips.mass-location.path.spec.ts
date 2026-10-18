import { BadRequestException } from '@nestjs/common';
import {
  AssignmentStatus,
  JobStatus,
  TripStatus,
} from '@prisma/client';
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

function tripForMass(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    jobId: 'job-1',
    status: TripStatus.EN_ROUTE_PICKUP,
    safetyPassedAt: new Date('2026-01-01T00:00:00Z'),
    safetyFailedAt: null as Date | null,
    safetyNotes: null as string | null,
    declaredMassKg: 1000,
    actualMassKg: null,
    massCheckOk: false,
    massCheckedAt: null,
    massOverDeclared: false,
    onBreak: false,
    breakStartedAt: null,
    startedAt: null as Date | null,
    completedAt: null,
    job: {
      title: 'Job',
      status: JobStatus.ASSIGNED,
      siteManeuverability: null,
      siteFacility: null,
      deadWeightKg: 1000,
      chargeableWeightKg: 1000,
      stops: [],
    },
    assignment: {
      status: AssignmentStatus.LOCKED,
      vehicleId: 'veh-1',
      driverId: 'drv-1',
      vehicle: {
        label: 'Truck',
        registration: 'ABC123',
        vehicleClass: 'HR',
      },
    },
    locations: [],
    stopProgress: [],
    surcharges: [],
    ...overrides,
  };
}

describe('TripsService massCheck + postLocation leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn(), chargeSurcharge: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      payments as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('massCheck gates', () => {
    it('rejects offline', async () => {
      const service = makeService({ isConnected: () => true });
      const offline = { online: false, actualMassKg: 1000 } as unknown as {
        online: true;
        actualMassKg: number;
      };
      try {
        await service.massCheck(driverPrincipal, 'trip-1', offline);
        fail('expected');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'OFFLINE_REJECTED',
        });
      }
    });

    it('rejects when safety not passed', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: {
          findFirst: jest.fn().mockResolvedValue(
            tripForMass({ safetyPassedAt: null }),
          ),
        },
      };
      try {
        await makeService(prisma).massCheck(driverPrincipal, 'trip-1', {
          online: true,
          actualMassKg: 1000,
        });
        fail('expected');
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'SAFETY_REQUIRED',
        });
      }
    });

    it('rejects when trip already started', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: {
          findFirst: jest.fn().mockResolvedValue(
            tripForMass({
              startedAt: new Date('2026-01-01T12:00:00Z'),
              status: TripStatus.IN_TRANSIT,
            }),
          ),
        },
      };
      await expect(
        makeService(prisma).massCheck(driverPrincipal, 'trip-1', {
          online: true,
          actualMassKg: 1000,
        }),
      ).rejects.toMatchObject({ message: 'Trip already started' });
    });
  });

  describe('postLocation', () => {
    it('stores sample and evaluates geofence after start', async () => {
      const started = tripForMass({
        startedAt: new Date('2026-01-01T12:00:00Z'),
        status: TripStatus.IN_TRANSIT,
        massCheckOk: true,
      });
      const recordedAt = new Date('2026-01-01T12:05:00Z');
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: {
          findFirst: jest.fn().mockResolvedValue(started),
          findUnique: jest.fn().mockResolvedValue({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: started.startedAt,
            status: TripStatus.IN_TRANSIT,
            job: {
              stops: [
                {
                  id: 'stop-1',
                  lat: -37.81,
                  lng: 144.96,
                  stopType: 'PICKUP',
                  sequence: 0,
                },
              ],
            },
            stopProgress: [],
          }),
        },
        tripLocationSample: {
          create: jest.fn().mockResolvedValue({
            id: 'loc-1',
            recordedAt,
          }),
        },
        tripStopProgress: {
          create: jest.fn().mockResolvedValue({
            id: 'prog-1',
            tripId: 'trip-1',
            jobStopId: 'stop-1',
            arrivalRecorded: false,
            enteredAt: null,
            exitedAt: null,
            currentlyInside: false,
            insideCount: 0,
            waitOverageMinutes: 0,
            freeWaitEndsAt: null,
          }),
          update: jest.fn().mockImplementation(async ({ data }) => ({
            id: 'prog-1',
            tripId: 'trip-1',
            jobStopId: 'stop-1',
            arrivalRecorded: false,
            enteredAt: null,
            exitedAt: null,
            currentlyInside: false,
            insideCount: 0,
            waitOverageMinutes: 0,
            freeWaitEndsAt: null,
            ...data,
          })),
        },
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      const result = await makeService(prisma).postLocation(driverPrincipal, 'trip-1', {
        lat: -37.81,
        lng: 144.96,
      });

      expect(prisma.tripLocationSample.create).toHaveBeenCalled();
      expect(prisma.tripStopProgress.create).toHaveBeenCalled();
      expect(result).toMatchObject({
        id: 'loc-1',
        recordedAt,
        onBreak: false,
        visibleToSender: true,
      });
      expect(result.geofence).toMatchObject({
        activeStopId: 'stop-1',
        inside: true,
      });
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ onBreak: false }),
        }),
      );
    });

    it('marks sample not visible to sender while onBreak', async () => {
      const onBreakTrip = tripForMass({
        startedAt: new Date('2026-01-01T12:00:00Z'),
        status: TripStatus.IN_TRANSIT,
        onBreak: true,
        massCheckOk: true,
      });
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: {
          findFirst: jest.fn().mockResolvedValue(onBreakTrip),
          findUnique: jest.fn().mockResolvedValue({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: onBreakTrip.startedAt,
            status: TripStatus.IN_TRANSIT,
            job: { stops: [] },
            stopProgress: [],
          }),
        },
        tripLocationSample: {
          create: jest.fn().mockResolvedValue({
            id: 'loc-2',
            recordedAt: new Date(),
          }),
        },
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      const result = await makeService(prisma).postLocation(driverPrincipal, 'trip-1', {
        lat: -37.8,
        lng: 144.9,
      });
      expect(result).toMatchObject({
        onBreak: true,
        visibleToSender: false,
      });
    });
  });
});

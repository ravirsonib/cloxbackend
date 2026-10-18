import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  JobStatus,
  TripStatus,
  VehicleStatus,
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

function readyTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    jobId: 'job-1',
    status: TripStatus.AT_PICKUP,
    safetyPassedAt: new Date('2026-01-01T00:00:00Z'),
    safetyFailedAt: null as Date | null,
    safetyNotes: null as string | null,
    declaredMassKg: 1000,
    actualMassKg: 1000,
    massCheckOk: true,
    massCheckedAt: new Date('2026-01-01T00:01:00Z'),
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

describe('TripsService startByJobId leftover paths', () => {
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

  it('forbids sender role', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.startByJobId(
        { ...driverPrincipal, role: 'SENDER', id: 'user-sender' },
        'job-1',
        { online: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('starts trip by jobId for assigned driver', async () => {
    const trip = readyTrip();
    const started = readyTrip({
      status: TripStatus.IN_TRANSIT,
      startedAt: new Date('2026-01-01T00:10:00Z'),
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
        // 1) startByJobId lookup by jobId  2) startTrip → loadTripForDriver
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: 'trip-1' })
          .mockResolvedValue(trip),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ status: VehicleStatus.ACTIVE }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          trip: { update: jest.fn().mockResolvedValue(started) },
          job: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const result = await makeService(prisma).startByJobId(driverPrincipal, 'job-1', {
      online: true,
    });
    expect(result.status).toBe(TripStatus.IN_TRANSIT);
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('404 when driver has no trip for job', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).startByJobId(driverPrincipal, 'job-missing', { online: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

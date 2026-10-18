import { BadRequestException } from '@nestjs/common';
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

function tripReadyForSafety(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    jobId: 'job-1',
    status: TripStatus.PENDING_GATES,
    safetyPassedAt: null as Date | null,
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

describe('TripsService safetyCheck fail→suspend leftover', () => {
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

  it('fail on ACTIVE vehicle suspends fleet and tags [SAFETY_SUSPEND]', async () => {
    const trip = tripReadyForSafety();
    const updated = tripReadyForSafety({
      safetyFailedAt: new Date('2026-01-01T00:05:00Z'),
      safetyNotes: 'Brake light\n[SAFETY_SUSPEND]',
      status: TripStatus.PENDING_GATES,
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
        findFirst: jest.fn().mockResolvedValue(trip),
        update: jest.fn().mockResolvedValue(updated),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ status: VehicleStatus.ACTIVE }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const result = await makeService(prisma).safetyCheck(driverPrincipal, 'trip-1', {
      online: true,
      passed: false,
      notes: 'Brake light',
    });

    expect(prisma.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'veh-1' },
      data: { status: VehicleStatus.SUSPENDED },
    });
    expect(prisma.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          safetyNotes: 'Brake light\n[SAFETY_SUSPEND]',
          safetyPassedAt: null,
        }),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ vehicleLocked: true }),
      }),
    );
    expect(result.safetyNotes).toContain('[SAFETY_SUSPEND]');
  });

  it('rejects safetyCheck after trip already started', async () => {
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
          tripReadyForSafety({
            startedAt: new Date('2026-01-01T12:00:00Z'),
            status: TripStatus.IN_TRANSIT,
          }),
        ),
      },
    };
    await expect(
      makeService(prisma).safetyCheck(driverPrincipal, 'trip-1', {
        online: true,
        passed: true,
      }),
    ).rejects.toMatchObject({ message: 'Trip already started' });
  });

  it('rejects offline safetyCheck', async () => {
    const service = makeService({ isConnected: () => true });
    const offlineInput = { online: false, passed: true } as unknown as {
      online: true;
      passed: boolean;
    };
    await expect(
      service.safetyCheck(driverPrincipal, 'trip-1', offlineInput),
    ).rejects.toBeInstanceOf(BadRequestException);
    try {
      await service.safetyCheck(driverPrincipal, 'trip-1', offlineInput);
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'OFFLINE_REJECTED',
      });
    }
  });
});

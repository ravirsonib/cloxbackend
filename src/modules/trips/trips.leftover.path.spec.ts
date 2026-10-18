import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  JobStatus,
  SurchargeKind,
  SurchargeStatus,
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

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService leftover gate/map paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn(), chargePendingSurchargesForTrip: jest.fn() };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'GEOFENCE_RADIUS_METERS') return 0;
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

  beforeEach(() => jest.clearAllMocks());

  it('ensureDatabase throws when offline', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(service.listDriverTrips(driverPrincipal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('requireDriver forbids non-driver', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.getDriverTrip(senderPrincipal, 'trip-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('getDriverTrip maps trip with job stops for driver', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.PENDING_GATES,
      safetyPassedAt: null,
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: 100,
      actualMassKg: null,
      massCheckOk: false,
      massCheckedAt: null,
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: null,
      completedAt: null,
      job: {
        title: 'Haul',
        status: JobStatus.ASSIGNED,
        siteManeuverability: null,
        siteFacility: null,
        deadWeightKg: null,
        chargeableWeightKg: 120,
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            suburb: 'Melbourne',
            state: 'VIC',
            lat:  -37.8,
            lng: { toNumber: () => 144.9 },
          },
        ],
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
      },
    };
    const service = makeService(prisma);
    const mapped = await service.getDriverTrip(driverPrincipal, 'trip-1');
    expect(mapped.id).toBe('trip-1');
    expect(mapped.job?.stops?.[0]).toMatchObject({
      sequence: 1,
      suburb: 'Melbourne',
      lat: -37.8,
      lng: 144.9,
    });
  });

  it('safetyCheck rejects when assignment not LOCKED', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          startedAt: null,
          assignment: { status: AssignmentStatus.PENDING, vehicleId: null },
        }),
      },
    };
    const service = makeService(prisma);
    try {
      await service.safetyCheck(driverPrincipal, 'trip-1', {
        online: true,
        passed: true,
      });
      fail('expected TRIP_NOT_PAID');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'TRIP_NOT_PAID',
      });
    }
  });

  it('startTrip rejects SAFETY/MASS pending and returns when already started', async () => {
    const base = {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.PENDING_GATES,
      safetyPassedAt: null as Date | null,
      safetyFailedAt: null as Date | null,
      safetyNotes: null,
      declaredMassKg: 100,
      actualMassKg: 100,
      massCheckOk: false,
      massCheckedAt: null,
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: null as Date | null,
      completedAt: null,
      job: { title: 'J', status: JobStatus.ASSIGNED, siteManeuverability: null, siteFacility: null, deadWeightKg: null, chargeableWeightKg: null, stops: [] },
      assignment: {
        status: AssignmentStatus.LOCKED,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        vehicle: { label: 'T', registration: 'ABC', vehicleClass: 'SEMI' },
      },
      locations: [],
      stopProgress: [],
      surcharges: [] as Array<{
        id: string;
        kind: SurchargeKind;
        status: SurchargeStatus;
        amountExGstCents: number;
        amountGstCents: number;
        amountIncGstCents: number;
        stopProgressId: string | null;
        idempotencyKey: string;
        paidAt: Date | null;
        waivedAt: Date | null;
        createdAt: Date;
      }>,
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
        findFirst: jest.fn().mockResolvedValue({ ...base }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ status: VehicleStatus.ACTIVE }),
      },
    };
    const service = makeService(prisma);

    try {
      await service.startTrip(driverPrincipal, 'trip-1', { online: true });
      fail('expected SAFETY_REQUIRED');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'SAFETY_REQUIRED',
      });
    }

    prisma.trip.findFirst.mockResolvedValue({
      ...base,
      safetyPassedAt: new Date(),
      surcharges: [
        {
          id: 'sc-1',
          kind: SurchargeKind.MASS,
          status: SurchargeStatus.PENDING_PAYMENT,
          amountExGstCents: 100,
          amountGstCents: 10,
          amountIncGstCents: 110,
          stopProgressId: null,
          idempotencyKey: 'k',
          paidAt: null,
          waivedAt: null,
          createdAt: new Date(),
        },
      ],
    });
    try {
      await service.startTrip(driverPrincipal, 'trip-1', { online: true });
      fail('expected MASS_SURCHARGE_PENDING');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'MASS_SURCHARGE_PENDING',
      });
    }

    prisma.trip.findFirst.mockResolvedValue({
      ...base,
      safetyPassedAt: new Date(),
      massCheckOk: false,
      massOverDeclared: false,
      surcharges: [],
    });
    try {
      await service.startTrip(driverPrincipal, 'trip-1', { online: true });
      fail('expected MASS_REQUIRED');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'MASS_REQUIRED',
      });
    }

    const started = {
      ...base,
      safetyPassedAt: new Date(),
      massCheckOk: true,
      massOverDeclared: false,
      startedAt: new Date('2026-10-01T00:00:00.000Z'),
      status: TripStatus.IN_TRANSIT,
      surcharges: [],
    };
    prisma.trip.findFirst.mockResolvedValue(started);
    const again = await service.startTrip(driverPrincipal, 'trip-1', { online: true });
    expect(again.startedAt).toEqual(started.startedAt);
  });

  it('ensureTripForAssignment falls back to chargeableWeightKg', async () => {
    const created = { id: 'trip-new', status: TripStatus.PENDING_GATES };
    const prisma = {
      isConnected: () => true,
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asg-1',
          jobId: 'job-1',
          status: AssignmentStatus.LOCKED,
          trip: null,
          job: { deadWeightKg: null, chargeableWeightKg: 450 },
        }),
      },
      trip: { create: jest.fn().mockResolvedValue(created) },
    };
    const service = makeService(prisma);
    await service.ensureTripForAssignment('asg-1');
    expect(prisma.trip.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ declaredMassKg: 450 }),
    });
  });

  it('getDriverTrip 404 when trip missing', async () => {
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
    const service = makeService(prisma);
    await expect(service.getDriverTrip(driverPrincipal, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

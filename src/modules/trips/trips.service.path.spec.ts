import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
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

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function baseTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    jobId: 'job-1',
    status: TripStatus.PENDING_GATES,
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

describe('TripsService deep paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const config = { get: jest.fn() };
  const payments = { createSurcharge: jest.fn(), chargeSurcharge: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    // Constructor order: prisma, audit, config, payments (forwardRef)
    return new TripsService(
      prisma as never,
      audit as never,
      config as never,
      payments as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('startTrip', () => {
    it('throws OFFLINE_REJECTED when online is false', async () => {
      const prisma = { isConnected: () => true };
      const service = makeService(prisma);
      // Runtime path rejects !online; schema types online as literal true.
      const offlineInput = { online: false } as unknown as { online: true };

      await expect(
        service.startTrip(driverPrincipal, 'trip-1', offlineInput),
      ).rejects.toBeInstanceOf(BadRequestException);

      try {
        await service.startTrip(driverPrincipal, 'trip-1', offlineInput);
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          message: 'Offline start trip rejected — online-only',
          code: 'OFFLINE_REJECTED',
        });
      }
    });

    it('throws TRIP_NOT_PAID when assignment is not LOCKED', async () => {
      const trip = baseTrip({
        assignment: {
          status: AssignmentStatus.PENDING,
          vehicleId: 'veh-1',
          driverId: 'drv-1',
          vehicle: null,
        },
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
        },
      };
      const service = makeService(prisma);

      await expect(
        service.startTrip(driverPrincipal, 'trip-1', { online: true }),
      ).rejects.toMatchObject({
        response: { code: 'TRIP_NOT_PAID', message: 'Payment required' },
      });
      await expect(
        service.startTrip(driverPrincipal, 'trip-1', { online: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws VEHICLE_NOT_ACTIVE when vehicle status is not ACTIVE', async () => {
      const trip = baseTrip();
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
        vehicle: {
          findUnique: jest.fn().mockResolvedValue({ status: VehicleStatus.SUSPENDED }),
        },
      };
      const service = makeService(prisma);

      await expect(
        service.startTrip(driverPrincipal, 'trip-1', { online: true }),
      ).rejects.toMatchObject({
        response: {
          code: 'VEHICLE_NOT_ACTIVE',
          message: 'Vehicle is not ACTIVE — cannot start trip',
        },
      });
      expect(prisma.vehicle.findUnique).toHaveBeenCalledWith({
        where: { id: 'veh-1' },
        select: { status: true },
      });
    });
  });

  describe('safetyCheck', () => {
    it('pass with [SAFETY_SUSPEND] notes and prior safetyFailedAt calls vehicle.update ACTIVE', async () => {
      const failedAt = new Date('2026-01-01T00:00:00Z');
      const trip = baseTrip({
        safetyPassedAt: null,
        safetyFailedAt: failedAt,
        safetyNotes: 'Pre-trip failed\n[SAFETY_SUSPEND]',
        startedAt: null,
      });
      const updated = baseTrip({
        safetyPassedAt: new Date('2026-01-01T01:00:00Z'),
        safetyFailedAt: null,
        safetyNotes: 'ok',
        status: TripStatus.EN_ROUTE_PICKUP,
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
          update: jest.fn().mockResolvedValue({}),
        },
      };
      const service = makeService(prisma);

      await service.safetyCheck(driverPrincipal, 'trip-1', {
        online: true,
        passed: true,
        notes: 'ok',
      });

      expect(prisma.vehicle.update).toHaveBeenCalledWith({
        where: { id: 'veh-1' },
        data: { status: VehicleStatus.ACTIVE },
      });
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { vehicleUnsuspended: true },
        }),
      );
    });

    it('fail when vehicle already SUSPENDED does not call vehicle.update', async () => {
      const trip = baseTrip({
        safetyPassedAt: null,
        safetyFailedAt: null,
        safetyNotes: null,
        startedAt: null,
      });
      const updated = baseTrip({
        safetyFailedAt: new Date(),
        safetyPassedAt: null,
        safetyNotes: 'broken brake',
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
          findUnique: jest.fn().mockResolvedValue({ status: VehicleStatus.SUSPENDED }),
          update: jest.fn(),
        },
      };
      const service = makeService(prisma);

      await service.safetyCheck(driverPrincipal, 'trip-1', {
        online: true,
        passed: false,
        notes: 'broken brake',
      });

      expect(prisma.vehicle.findUnique).toHaveBeenCalledWith({
        where: { id: 'veh-1' },
        select: { status: true },
      });
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
      expect(prisma.trip.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            safetyNotes: 'broken brake',
          }),
        }),
      );
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ vehicleLocked: false }),
        }),
      );
    });
  });

  describe('getSenderTracking', () => {
    it('when onBreak returns visible:true with empty locations and etaPaused', async () => {
      const startedAt = new Date('2026-01-02T10:00:00Z');
      const recordedAt = new Date('2026-01-02T10:05:00Z');
      const trip = {
        id: 'trip-1',
        jobId: 'job-1',
        status: TripStatus.IN_TRANSIT,
        startedAt,
        onBreak: true,
        job: {
          title: 'Freight run',
          stops: [
            {
              sequence: 1,
              stopType: 'PICKUP',
              suburb: 'Sydney',
              lat: -33.86,
              lng: 151.2,
            },
          ],
        },
        locations: [{ lat: -33.87, lng: 151.21, recordedAt }],
        assignment: { vehicle: null },
        stopProgress: [],
        surcharges: [],
      };
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-1',
          }),
        },
        trip: {
          findFirst: jest.fn().mockResolvedValue(trip),
        },
      };
      const service = makeService(prisma);

      const result = await service.getSenderTracking(senderPrincipal, 'job-1');

      expect(result).toEqual({
        visible: true,
        onBreak: true,
        etaPaused: true,
        tripStatus: TripStatus.IN_TRANSIT,
        startedAt,
        job: {
          id: 'job-1',
          title: 'Freight run',
          stops: [
            {
              sequence: 1,
              stopType: 'PICKUP',
              suburb: 'Sydney',
              lat: -33.86,
              lng: 151.2,
            },
          ],
        },
        locations: [],
        latest: null,
        stopsProgress: [],
        surcharges: [],
      });
    });
  });
});

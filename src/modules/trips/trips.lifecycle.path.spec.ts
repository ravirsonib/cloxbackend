import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
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
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

const driverPrincipal: AuthenticatedPrincipal = {
  id: 'user-driver',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function baseTrip(overrides: Record<string, unknown> = {}) {
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

describe('TripsService lifecycle paths', () => {
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

  describe('ensureTripForAssignment', () => {
    it('returns null when assignment not LOCKED', async () => {
      const prisma = {
        isConnected: () => true,
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            status: AssignmentStatus.PENDING,
            trip: null,
            job: {},
          }),
        },
      };
      const service = makeService(prisma);
      await expect(service.ensureTripForAssignment('asg-1')).resolves.toBeNull();
    });

    it('returns existing trip when present', async () => {
      const trip = { id: 'trip-1' };
      const prisma = {
        isConnected: () => true,
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            status: AssignmentStatus.LOCKED,
            trip,
            job: { deadWeightKg: 500 },
          }),
        },
        trip: { create: jest.fn() },
      };
      const service = makeService(prisma);
      await expect(service.ensureTripForAssignment('asg-1')).resolves.toBe(trip);
      expect(prisma.trip.create).not.toHaveBeenCalled();
    });

    it('creates PENDING_GATES trip when locked and missing', async () => {
      const created = { id: 'trip-new', status: TripStatus.PENDING_GATES };
      const prisma = {
        isConnected: () => true,
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            jobId: 'job-1',
            status: AssignmentStatus.LOCKED,
            trip: null,
            job: { deadWeightKg: 800, chargeableWeightKg: 900 },
          }),
        },
        trip: { create: jest.fn().mockResolvedValue(created) },
      };
      const service = makeService(prisma);
      await expect(service.ensureTripForAssignment('asg-1')).resolves.toEqual(created);
      expect(prisma.trip.create).toHaveBeenCalledWith({
        data: {
          jobId: 'job-1',
          assignmentId: 'asg-1',
          status: TripStatus.PENDING_GATES,
          declaredMassKg: 800,
        },
      });
      expect(audit.recordPlatform).toHaveBeenCalled();
    });
  });

  describe('massCheck', () => {
    it('passes under tolerance and sets massCheckOk', async () => {
      const trip = baseTrip({
        massCheckOk: false,
        massCheckedAt: null,
        actualMassKg: null,
      });
      const updated = baseTrip({ massCheckOk: true, actualMassKg: 1010 });
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
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const service = makeService(prisma);
      const result = await service.massCheck(driverPrincipal, 'trip-1', {
        online: true,
        actualMassKg: 1010,
      });
      expect(result.massCheckOk).toBe(true);
      expect(payments.createSurcharge).not.toHaveBeenCalled();
    });

    it('throws MASS_DISCREPANCY and creates surcharge when over tolerance', async () => {
      const trip = baseTrip({
        massCheckOk: false,
        massCheckedAt: null,
        declaredMassKg: 1000,
      });
      payments.createSurcharge.mockResolvedValue({
        id: 's-mass',
        kind: SurchargeKind.MASS,
        status: SurchargeStatus.PENDING_PAYMENT,
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
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(trip)
            .mockResolvedValueOnce({
              ...trip,
              massOverDeclared: true,
              massCheckOk: false,
              surcharges: [
                {
                  kind: SurchargeKind.MASS,
                  status: SurchargeStatus.PENDING_PAYMENT,
                },
              ],
            }),
          update: jest.fn().mockResolvedValue({}),
        },
        policyVersion: {
          findFirst: jest.fn().mockResolvedValue({
            payload: { ...DEFAULT_GEOFENCE_POLICY, massTolerancePct: 2 },
          }),
        },
      };
      const service = makeService(prisma);
      try {
        await service.massCheck(driverPrincipal, 'trip-1', {
          online: true,
          actualMassKg: 1200,
        });
        fail('expected MASS_DISCREPANCY');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: 'MASS_DISCREPANCY',
        });
      }
      expect(payments.createSurcharge).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: SurchargeKind.MASS,
          idempotencyKey: 'mass:trip-1',
          chargeNow: false,
        }),
      );
    });
  });

  describe('startTrip happy path', () => {
    it('starts trip and marks job IN_TRANSIT', async () => {
      const trip = baseTrip();
      const started = baseTrip({
        startedAt: new Date('2026-01-01T12:00:00Z'),
        status: TripStatus.IN_TRANSIT,
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
      const service = makeService(prisma);
      const result = await service.startTrip(driverPrincipal, 'trip-1', {
        online: true,
      });
      expect(result.status).toBe(TripStatus.IN_TRANSIT);
      expect(result.gates.canStart).toBe(false);
      expect(audit.recordPlatform).toHaveBeenCalled();
    });
  });

  describe('toggleBreak / postLocation / startByJobId', () => {
    it('toggleBreak rejects before start', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: { findFirst: jest.fn().mockResolvedValue(baseTrip({ startedAt: null })) },
      };
      const service = makeService(prisma);
      await expect(
        service.toggleBreak(driverPrincipal, 'trip-1', { onBreak: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('toggleBreak sets onBreak when started', async () => {
      const trip = baseTrip({ startedAt: new Date() });
      const updated = { ...trip, onBreak: true, breakStartedAt: new Date() };
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
      };
      const service = makeService(prisma);
      const result = await service.toggleBreak(driverPrincipal, 'trip-1', {
        onBreak: true,
      });
      expect(result.onBreak).toBe(true);
    });

    it('postLocation rejects when trip not started', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: { findFirst: jest.fn().mockResolvedValue(baseTrip({ startedAt: null })) },
      };
      const service = makeService(prisma);
      try {
        await service.postLocation(driverPrincipal, 'trip-1', {
          lat: -37.8,
          lng: 144.9,
        });
        fail('expected');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: 'TRIP_NOT_STARTED',
        });
      }
    });

    it('startByJobId forbids carrier', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.startByJobId(
          {
            ...driverPrincipal,
            role: 'TRANSPORT_COMPANY',
            id: 'user-carrier',
          },
          'job-1',
          { online: true },
        ),
      ).rejects.toMatchObject({
        message: 'Carrier cannot start trip — driver must start',
      });
    });

    it('startByJobId throws when trip missing for driver', async () => {
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
      await expect(
        service.startByJobId(driverPrincipal, 'job-1', { online: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listDriverTrips', () => {
    it('maps trips for driver', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-driver',
            driver: { id: 'drv-1' },
          }),
        },
        trip: {
          findMany: jest.fn().mockResolvedValue([baseTrip()]),
        },
      };
      const service = makeService(prisma);
      const rows = await service.listDriverTrips(driverPrincipal);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('trip-1');
      expect(rows[0].gates.canStart).toBe(true);
    });
  });
});

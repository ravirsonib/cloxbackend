import { ForbiddenException } from '@nestjs/common';
import { TripStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService geofence + tracking paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn(), chargeSurcharge: jest.fn() };

  function makeService(
    prisma: Record<string, unknown>,
    configGet: (key: string) => unknown = () => undefined,
  ) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: configGet } as never,
      payments as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('evaluateGeofence', () => {
    it('returns null when trip missing', async () => {
      const prisma = {
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
        trip: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const service = makeService(prisma);
      await expect(
        service.evaluateGeofence('missing', { lat: -37.8, lng: 144.9 }),
      ).resolves.toBeNull();
    });

    it('completes when no active stop coords and returns tripCompleted', async () => {
      const prisma = {
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
        trip: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              id: 'trip-1',
              jobId: 'job-1',
              startedAt: null,
              status: TripStatus.IN_TRANSIT,
              job: { stops: [{ id: 's1', lat: null, lng: null, stopType: 'PICKUP', sequence: 0 }] },
              stopProgress: [],
            })
            .mockResolvedValueOnce({
              id: 'trip-1',
              jobId: 'job-1',
              startedAt: null,
              status: TripStatus.IN_TRANSIT,
              assignmentId: null,
              job: { stops: [] },
              stopProgress: [],
              assignment: null,
              surcharges: [],
            }),
        },
      };
      const service = makeService(prisma);
      const result = await service.evaluateGeofence('trip-1', {
        lat: -37.8,
        lng: 144.9,
      });
      expect(result).toMatchObject({
        activeStopId: null,
        inside: false,
        entered: false,
        tripCompleted: true,
      });
    });

    it('increments insideCount and enters after antiBounceSamples', async () => {
      const progress = {
        id: 'prog-1',
        jobStopId: 'stop-1',
        insideCount: 1,
        currentlyInside: true,
        enteredAt: null as Date | null,
        exitedAt: null,
        freeWaitEndsAt: null as Date | null,
        waitOverageMinutes: 0,
        arrivalRecorded: false,
      };
      const updated = {
        ...progress,
        insideCount: 2,
        enteredAt: new Date('2026-01-01T12:00:00Z'),
        waitStartedAt: new Date('2026-01-01T12:00:00Z'),
        freeWaitEndsAt: new Date('2026-01-01T12:30:00Z'),
        arrivalRecorded: true,
      };
      const prisma = {
        policyVersion: {
          findFirst: jest.fn().mockResolvedValue({
            payload: { ...DEFAULT_GEOFENCE_POLICY, antiBounceSamples: 2 },
          }),
        },
        trip: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: new Date('2026-01-01T10:00:00Z'),
            status: TripStatus.IN_TRANSIT,
            job: {
              stops: [
                {
                  id: 'stop-1',
                  lat: -37.8136,
                  lng: 144.9631,
                  stopType: 'PICKUP',
                  sequence: 0,
                },
              ],
            },
            stopProgress: [progress],
          }),
          update: jest.fn(),
        },
        tripStopProgress: {
          update: jest.fn().mockResolvedValue(updated),
        },
      };
      const service = makeService(prisma, (key) =>
        key === 'GEOFENCE_RADIUS_METERS' ? 500 : undefined,
      );

      const result = await service.evaluateGeofence(
        'trip-1',
        { lat: -37.8136, lng: 144.9631 },
        'user-driver',
      );

      expect(result).toMatchObject({
        activeStopId: 'stop-1',
        inside: true,
        entered: true,
        stopType: 'PICKUP',
      });
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'trip.geofence_enter',
          entityId: 'trip-1',
        }),
      );
    });

    it('creates progress row when missing then samples outside without exit', async () => {
      const created = {
        id: 'prog-new',
        jobStopId: 'stop-1',
        insideCount: 0,
        currentlyInside: false,
        enteredAt: null,
        exitedAt: null,
        freeWaitEndsAt: null,
        waitOverageMinutes: 0,
        arrivalRecorded: false,
      };
      const afterOutside = {
        ...created,
        insideCount: 1,
        currentlyInside: false,
      };
      const prisma = {
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
        trip: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: new Date(),
            status: TripStatus.IN_TRANSIT,
            job: {
              stops: [
                {
                  id: 'stop-1',
                  lat: -37.8136,
                  lng: 144.9631,
                  stopType: 'DROPOFF',
                  sequence: 0,
                },
              ],
            },
            stopProgress: [],
          }),
        },
        tripStopProgress: {
          create: jest.fn().mockResolvedValue(created),
          update: jest.fn().mockResolvedValue(afterOutside),
        },
      };
      const service = makeService(prisma);

      // Far outside Melbourne CBD
      const result = await service.evaluateGeofence('trip-1', {
        lat: -33.8688,
        lng: 151.2093,
      });

      expect(prisma.tripStopProgress.create).toHaveBeenCalled();
      expect(result).toMatchObject({
        activeStopId: 'stop-1',
        inside: false,
        entered: false,
      });
      expect(audit.recordPlatform).not.toHaveBeenCalled();
    });
  });

  describe('getSenderTracking', () => {
    it('rejects non-sender', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.getSenderTracking(
          { ...senderPrincipal, role: 'DRIVER' },
          'job-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns TRACKING_NOT_LIVE before start', async () => {
      const prisma = {
        isConnected: () => true,
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }) },
        trip: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: null,
            status: TripStatus.PENDING_GATES,
            onBreak: false,
            job: { title: 'J', stops: [] },
            locations: [],
            assignment: null,
            stopProgress: [],
            surcharges: [],
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.getSenderTracking(senderPrincipal, 'job-1');
      expect(result).toMatchObject({
        visible: false,
        code: 'TRACKING_NOT_LIVE',
        tripStatus: TripStatus.PENDING_GATES,
      });
    });

    it('hides locations while onBreak but keeps visible true', async () => {
      const prisma = {
        isConnected: () => true,
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }) },
        trip: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: new Date('2026-01-01T10:00:00Z'),
            status: TripStatus.IN_TRANSIT,
            onBreak: true,
            job: {
              title: 'J',
              stops: [
                {
                  sequence: 0,
                  stopType: 'PICKUP',
                  suburb: 'Melbourne',
                  lat: -37.8,
                  lng: 144.9,
                },
              ],
            },
            locations: [
              { lat: -37.8, lng: 144.9, recordedAt: new Date('2026-01-01T10:05:00Z') },
            ],
            assignment: { vehicle: { label: 'T1' } },
            stopProgress: [],
            surcharges: [],
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.getSenderTracking(senderPrincipal, 'job-1');
      expect(result).toMatchObject({
        visible: true,
        onBreak: true,
        etaPaused: true,
        locations: [],
        latest: null,
      });
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { AssignmentStatus, JobStatus, TripStatus } from '@prisma/client';
import type { Socket } from 'socket.io';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { JobsService } from '../jobs/jobs.service';
import { TripsService } from '../trips/trips.service';
import { GeolocationController } from './geolocation.controller';
import { decodePolyline6, encodePolyline6, mergePolylines6 } from './polyline6.util';
import { RealtimeGateway } from './realtime.gateway';
import { ValhallaClientService } from './valhalla-client.service';

describe('Valhalla + Live Tracking Harsh Stress & Chaos Suite', () => {
  // ─── 1. Polyline6 Stress & Fuzzing ──────────────────────────────────────────

  describe('polyline6 stress & adversarial inputs', () => {
    it('encodes, merges, and decodes a 10,000-point 50-leg highway route in < 150ms', () => {
      const legs: string[] = [];
      let lat = -37.8136;
      let lng = 144.9631;
      for (let leg = 0; leg < 50; leg += 1) {
        const pts: Array<[number, number]> = [];
        for (let i = 0; i < 200; i += 1) {
          pts.push([lat, lng]);
          lat += 0.0005;
          lng += 0.0004;
        }
        legs.push(encodePolyline6(pts));
      }

      const t0 = Date.now();
      const merged = mergePolylines6(legs);
      const decoded = decodePolyline6(merged);
      const elapsedMs = Date.now() - t0;

      expect(decoded.length).toBeGreaterThan(9900);
      expect(elapsedMs).toBeLessThan(150);
    });

    it('handles empty, truncated, and garbage polyline strings without crashing or hanging', () => {
      expect(decodePolyline6('')).toEqual([]);
      expect(mergePolylines6([])).toEqual('');
      expect(mergePolylines6(['', ''])).toEqual('');
      expect(() => decodePolyline6('~~~truncated_invalid_bytes_!!!')).not.toThrow();
      expect(() => decodePolyline6('?')).not.toThrow();
    });
  });

  // ─── 2. GeolocationController Adversarial Inputs ────────────────────────────

  describe('GeolocationController coordinate validation & chaos', () => {
    const valhalla = {
      isEnabled: true,
      ping: jest.fn().mockResolvedValue({ ok: true, version: '3.4.0' }),
      getRoute: jest.fn().mockResolvedValue(null),
      snapToRoad: jest.fn().mockResolvedValue(null),
    };
    const ctrl = new GeolocationController(valhalla as never);

    const badCoords: Array<[number, number, string]> = [
      [0, 0, 'Null Island (0, 0)'],
      [91, 144.96, 'lat > 90'],
      [-91, 144.96, 'lat < -90'],
      [-37.81, 181, 'lng > 180'],
      [-37.81, -181, 'lng < -180'],
      [Number.NaN, 144.96, 'NaN lat'],
      [-37.81, Number.POSITIVE_INFINITY, 'Infinity lng'],
    ];

    it.each(badCoords)('rejects %s on /route and /snap with 400 BadRequest', async (lat, lng) => {
      await expect(ctrl.getRoute(lat, lng, -37.82, 144.99)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(ctrl.getRoute(-37.81, 144.96, lat, lng)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(ctrl.snap(lat, lng)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── 3. ValhallaClientService Chaos (500, Timeout, Malformed JSON) ──────────

  describe('ValhallaClientService chaos resilience', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function makeClient() {
      return new ValhallaClientService({
        get: (key: string) => {
          if (key === 'VALHALLA_BASE_URL') return 'http://127.0.0.1:8002';
          if (key === 'VALHALLA_TIMEOUT_MS') return 100;
          if (key === 'VALHALLA_COSTING') return 'truck';
          return undefined;
        },
      } as never);
    }

    it('returns null (never throws) on HTTP 500, network failure, and malformed JSON', async () => {
      const client = makeClient();

      // HTTP 500
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Error',
      }) as never;
      await expect(
        client.getRoute([
          { lat: -37.81, lng: 144.96 },
          { lat: -37.82, lng: 144.99 },
        ]),
      ).resolves.toBeNull();
      await expect(client.snapToRoad(-37.81, 144.96)).resolves.toBeNull();

      // Network ECONNREFUSED
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
      await expect(
        client.getRoute([
          { lat: -37.81, lng: 144.96 },
          { lat: -37.82, lng: 144.99 },
        ]),
      ).resolves.toBeNull();

      // Malformed / missing summary JSON
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ trip: { legs: [{ shape: 'abc' }], summary: {} } }),
      }) as never;
      const badSummaryRoute = await client.getRoute([
        { lat: -37.81, lng: 144.96 },
        { lat: -37.82, lng: 144.99 },
      ]);
      // Should never return NaN distanceKm or durationMin
      if (badSummaryRoute !== null) {
        expect(Number.isFinite(badSummaryRoute.distanceKm)).toBe(true);
        expect(Number.isFinite(badSummaryRoute.durationMin)).toBe(true);
      }
    });
  });

  // ─── 4. WebSocket Multi-Tenant ACL Stress (50 Fake Users + Attackers) ───────

  describe('RealtimeGateway 50-user multi-tenant ACL stress', () => {
    it('allows only legitimate principals and blocks 100% of cross-tenant spoof attempts', async () => {
      const prisma = {
        isConnected: () => true,
        trip: {
          findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
            const idx = Number(where.id.replace('trip-', ''));
            if (!Number.isFinite(idx) || idx < 0 || idx >= 10) return null;
            return {
              id: where.id,
              job: { senderCompanyId: `sender-co-${idx}` },
              assignment: { carrierCompanyId: `carrier-co-${idx}`, driverId: `drv-${idx}` },
            };
          }),
        },
        job: {
          findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
            const idx = Number(where.id.replace('job-', ''));
            if (!Number.isFinite(idx) || idx < 0 || idx >= 10) return null;
            return {
              id: where.id,
              senderCompanyId: `sender-co-${idx}`,
              assignment: { carrierCompanyId: `carrier-co-${idx}`, driverId: `drv-${idx}` },
            };
          }),
        },
        user: {
          findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
            const [rolePrefix, idxStr] = where.id.split('-user-');
            const idx = Number(idxStr);
            if (rolePrefix === 'sender') {
              return { companyId: `sender-co-${idx}`, driver: null };
            }
            if (rolePrefix === 'carrier') {
              return { companyId: `carrier-co-${idx}`, driver: null };
            }
            if (rolePrefix === 'driver') {
              return { companyId: `carrier-co-${idx}`, driver: { id: `drv-${idx}` } };
            }
            return null;
          }),
        },
      };

      const gw = new RealtimeGateway({} as never, {} as never, prisma as never);

      const tasks: Array<Promise<void>> = [];
      let allowedCount = 0;
      let rejectedCount = 0;

      // 10 tenants × 5 actors each = 50 concurrent fake users
      for (let i = 0; i < 10; i += 1) {
        const makeSock = (id: string, role: string) =>
          ({
            id: `sock-${id}`,
            join: jest.fn().mockResolvedValue(undefined),
            leave: jest.fn().mockResolvedValue(undefined),
            principal: { id, role },
          }) as unknown as Socket;

        // 1. Legitimate sender
        tasks.push(
          gw.onSubscribeTrip(makeSock(`sender-user-${i}`, 'SENDER'), { tripId: `trip-${i}` }).then(() => {
            allowedCount += 1;
          }),
        );
        // 2. Legitimate carrier fleet
        tasks.push(
          gw
            .onSubscribeFleet(makeSock(`carrier-user-${i}`, 'TRANSPORT_COMPANY'), {
              companyId: `carrier-co-${i}`,
            })
            .then(() => {
              allowedCount += 1;
            }),
        );
        // 3. Legitimate driver
        tasks.push(
          gw.onSubscribeTrip(makeSock(`driver-user-${i}`, 'DRIVER'), { tripId: `trip-${i}` }).then(() => {
            allowedCount += 1;
          }),
        );
        // 4. Attacker sender from another company trying to snoop trip-i
        const other = (i + 1) % 10;
        tasks.push(
          gw
            .onSubscribeTrip(makeSock(`sender-user-${other}`, 'SENDER'), { tripId: `trip-${i}` })
            .then(() => {
              throw new Error('SECURITY BREACH: cross-tenant sender allowed!');
            })
            .catch((err) => {
              expect(err).toBeInstanceOf(WsException);
              rejectedCount += 1;
            }),
        );
        // 5. Attacker carrier trying to snoop another carrier's fleet
        tasks.push(
          gw
            .onSubscribeFleet(makeSock(`carrier-user-${other}`, 'TRANSPORT_COMPANY'), {
              companyId: `carrier-co-${i}`,
            })
            .then(() => {
              throw new Error('SECURITY BREACH: cross-tenant fleet allowed!');
            })
            .catch((err) => {
              expect(err).toBeInstanceOf(WsException);
              rejectedCount += 1;
            }),
        );
      }

      await Promise.all(tasks);
      expect(allowedCount).toBe(30);
      expect(rejectedCount).toBe(20);
    });
  });

  // ─── 5. High-Load GPS Burst (200 Concurrent Pings) + Slow Valhalla ──────────

  describe('TripsService 200-ping concurrent GPS burst & cache bound stress', () => {
    it('handles 200 concurrent driver GPS pings without blocking on slow Valhalla', async () => {
      const driverPrincipal: AuthenticatedPrincipal = {
        id: 'user-driver',
        email: 'driver@yopmail.com',
        role: 'DRIVER',
        kind: 'user',
        regionCodes: [],
        territoryCodes: [],
      };

      const startedTrip = {
        id: 'trip-burst',
        jobId: 'job-burst',
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
          title: 'Burst Job',
          status: JobStatus.IN_TRANSIT,
          stops: [
            {
              id: 'stop-drop',
              sequence: 0,
              stopType: 'DROPOFF',
              suburb: 'Melbourne',
              lat: -37.8136,
              lng: 144.9631,
            },
          ],
        },
        assignment: {
          status: AssignmentStatus.LOCKED,
          vehicleId: 'veh-1',
          driverId: 'drv-1',
          carrierCompanyId: 'carrier-1',
          vehicle: { label: 'T1', registration: 'VIC123', vehicleClass: 'HR' },
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
          findFirst: jest.fn().mockResolvedValue(startedTrip),
          findUnique: jest.fn().mockResolvedValue(startedTrip),
        },
        tripLocationSample: {
          create: jest.fn().mockResolvedValue({ id: 'loc', recordedAt: new Date() }),
        },
        tripStopProgress: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: 'prog-1',
            tripId: 'trip-burst',
            jobStopId: 'stop-drop',
            enteredAt: null,
            exitedAt: null,
            currentlyInside: false,
            insideCount: 0,
            waitOverageMinutes: 0,
            freeWaitEndsAt: null,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      // Simulate a slow Valhalla (250ms delay per call)
      const slowValhalla = {
        isEnabled: true,
        snapToRoad: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ lat: -37.8, lng: 144.95 }), 250),
            ),
        ),
        etaMinutes: jest.fn().mockResolvedValue(45),
        getRoute: jest.fn().mockResolvedValue({
          encodedPolyline: encodePolyline6([
            [-37.8, 144.95],
            [-37.8136, 144.9631],
          ]),
          distanceKm: 5.2,
          durationMin: 12,
        }),
      };

      const realtimeGateway = {
        emitVehicleLocation: jest.fn(),
        emitEtaUpdate: jest.fn(),
        emitApproaching: jest.fn(),
        emitTripBreak: jest.fn(),
      };

      const service = new TripsService(
        prisma as never,
        { recordPlatform: jest.fn() } as never,
        { get: () => undefined } as never,
        { createSurcharge: jest.fn(), chargeSurcharge: jest.fn() } as never,
        {
          notifyTripApproaching: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
          notifyTripAtDropoff: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
          notifyPodFinalized: jest.fn().mockResolvedValue({ sentTo: [], results: [] }),
        } as never,
        undefined,
        undefined,
        realtimeGateway as never,
        slowValhalla as never,
      );

      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          service.postLocation(driverPrincipal, 'trip-burst', {
            lat: -37.75 + i * 0.0001,
            lng: 144.9 + i * 0.0001,
          }),
        ),
      );
      const elapsedMs = Date.now() - t0;

      expect(results).toHaveLength(200);
      // Because snapToRoad is non-blocking, 200 pings must finish well under the 250ms Valhalla delay!
      expect(elapsedMs).toBeLessThan(220);
    });

    it('caps Valhalla route cache at 200 entries across 350 unique routes and serves repeat polls from cache', async () => {
      const senderPrincipal: AuthenticatedPrincipal = {
        id: 'user-sender',
        email: 'sender@yopmail.com',
        role: 'SENDER',
        kind: 'user',
        regionCodes: [],
        territoryCodes: [],
      };

      const valhalla = {
        isEnabled: true,
        getRoute: jest.fn().mockResolvedValue({
          encodedPolyline: 'poly_cached',
          distanceKm: 12.3,
          durationMin: 18,
        }),
      };

      let currentLat = -37.8;
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'comp-1' }),
        },
        trip: {
          findFirst: jest.fn().mockImplementation(async () => ({
            id: 'trip-1',
            jobId: 'job-1',
            status: TripStatus.IN_TRANSIT,
            startedAt: new Date(),
            onBreak: false,
            job: {
              id: 'job-1',
              title: 'Cache Test',
              stops: [
                { id: 's1', sequence: 0, stopType: 'DROPOFF', suburb: 'CBD', lat: -37.9, lng: 145.0 },
              ],
            },
            locations: [{ lat: currentLat, lng: 144.95, recordedAt: new Date() }],
            assignment: { vehicle: null },
            stopProgress: [],
            surcharges: [],
          })),
        },
      };

      const service = new TripsService(
        prisma as never,
        { recordPlatform: jest.fn() } as never,
        { get: () => undefined } as never,
        { createSurcharge: jest.fn(), chargeSurcharge: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        valhalla as never,
      );

      // 20 identical polls → only 1 Valhalla call
      for (let i = 0; i < 20; i += 1) {
        const res = await service.getSenderTracking(senderPrincipal, 'job-1');
        expect(res.visible).toBe(true);
      }
      expect(valhalla.getRoute).toHaveBeenCalledTimes(1);

      // 350 distinct routes → cache stays bounded at <= 200
      for (let i = 1; i <= 350; i += 1) {
        currentLat = -37.8 + i * 0.01;
        await service.getSenderTracking(senderPrincipal, 'job-1');
      }
      const cache = (service as unknown as { valhallaRouteCache: Map<string, unknown> })
        .valhallaRouteCache;
      expect(cache.size).toBeLessThanOrEqual(200);
    });
  });

  // ─── 6. JobsService previewRoute Chaos (NaN / Zero / 25-Stop Fallback) ──────

  describe('JobsService previewRoute chaos fallback', () => {
    it('falls back cleanly to mock when Valhalla returns NaN or zero distance', async () => {
      const badValhalla = {
        isEnabled: true,
        getRoute: jest.fn().mockResolvedValue({
          encodedPolyline: 'bad',
          distanceKm: Number.NaN,
          durationMin: Number.NaN,
        }),
      };

      const service = new JobsService(
        { isConnected: () => true } as never,
        { recordPlatform: jest.fn() } as never,
        { getBookingEligibility: jest.fn() } as never,
        { acceptProposal: jest.fn() } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        badValhalla as never,
      );

      const route = await service.previewRoute({
        pricingModel: 'PER_KM',
        stops: [
          {
            sequence: 0,
            stopType: 'PICKUP',
            addressLine: '1 Collins St',
            suburb: 'Melbourne',
            state: 'VIC',
            postcode: '3000',
            lat: -37.8136,
            lng: 144.9631,
          },
          {
            sequence: 1,
            stopType: 'DROPOFF',
            addressLine: '100 Airport Dr',
            suburb: 'Tullamarine',
            state: 'VIC',
            postcode: '3045',
            lat: -37.669,
            lng: 144.841,
          },
        ],
      });

      expect(route.mock).toBe(true);
      expect(Number.isFinite(route.distanceKm)).toBe(true);
      expect(route.distanceKm).toBeGreaterThan(0);
      expect(Number.isFinite(route.estimateIncGstCents)).toBe(true);
    });
  });
});

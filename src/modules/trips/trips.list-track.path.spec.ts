import { ForbiddenException, NotFoundException } from '@nestjs/common';
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

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService list/track leftover paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn() };
  const config = { get: () => 300 };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      config as never,
      payments as never,
    );
  }

  function listedTrip() {
    return {
      id: 'trip-1',
      jobId: 'job-1',
      status: TripStatus.PENDING_GATES,
      safetyPassedAt: null,
      safetyFailedAt: null,
      safetyNotes: null,
      declaredMassKg: 1000,
      actualMassKg: null,
      massCheckOk: false,
      massCheckedAt: null,
      massOverDeclared: false,
      onBreak: false,
      breakStartedAt: null,
      startedAt: null,
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
        vehicle: { label: 'V1', registration: 'ABC', vehicleClass: 'VAN' },
      },
      locations: [],
      stopProgress: [],
      surcharges: [],
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('listDriverTrips maps driver trips', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findMany: jest.fn().mockResolvedValue([listedTrip()]),
      },
    };
    const rows = await makeService(prisma).listDriverTrips(driver);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'trip-1', jobId: 'job-1' });
  });

  it('getSenderTracking rejects non-sender and missing company', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.getSenderTracking(driver, 'job-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: null }) },
    };
    await expect(
      makeService(prisma).getSenderTracking(sender, 'job-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getSenderTracking returns not-live when trip not started', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          status: TripStatus.PENDING_GATES,
          startedAt: null,
          onBreak: false,
          job: { title: 'Job', stops: [] },
          locations: [],
          assignment: { vehicle: null },
          stopProgress: [],
          surcharges: [],
        }),
      },
    };
    await expect(
      makeService(prisma).getSenderTracking(sender, 'job-1'),
    ).resolves.toMatchObject({
      visible: false,
      code: 'TRACKING_NOT_LIVE',
      jobId: 'job-1',
    });
  });
});

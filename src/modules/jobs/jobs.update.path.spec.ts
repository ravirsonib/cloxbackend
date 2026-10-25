import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AssignmentStatus,
  CompanyType,
  JobStatus,
  TripStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { JobCreateInput, JobReceiverUpdateInput } from '../../shared/types';
import { JobsService } from './jobs.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function createInput(): JobCreateInput {
  return {
    pricingModel: 'PER_KM',
    pickupAt: '2026-10-10T10:00:00.000Z',
    receiverName: 'Receiver Co',
    receiverEmail: 'receiver@yopmail.com',
    deadWeightKg: 200,
    lengthCm: 120,
    widthCm: 80,
    heightCm: 80,
    distanceKm: 12,
    loadTypes: ['GENERAL'],
    siteManeuverability: 'EASY',
    siteFacility: 'DOCK',
    siteDisclaimerAccepted: true,
    stops: [
      {
        sequence: 0,
        stopType: 'PICKUP',
        label: 'Pickup',
        addressLine: '1 Pickup St',
        suburb: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
        lat: -37.8136,
        lng: 144.9631,
      },
      {
        sequence: 1,
        stopType: 'DROPOFF',
        label: 'Drop',
        addressLine: '2 Drop St',
        suburb: 'Richmond',
        state: 'VIC',
        postcode: '3121',
        lat: -37.8197,
        lng: 144.998,
        receiverName: 'Receiver Co',
        receiverEmail: 'receiver@yopmail.com',
      },
    ],
  };
}

describe('JobsService updateJob', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { acceptProposal: jest.fn() };

  function makeService(prisma: Record<string, unknown>, canBook = true) {
    const senderService = {
      getBookingEligibility: jest.fn().mockResolvedValue({
        canBook,
        goNoGo: { canBook },
      }),
    };
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      payments as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when sender cannot book', async () => {
    const service = makeService({ isConnected: () => true }, false);
    await expect(
      service.updateJob(senderPrincipal, 'job-1', createInput()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects jobs that are past AT_DROPOFF', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          },
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.ASSIGNED,
          senderCompanyId: 'co-s',
          title: 'Old',
          assignment: { status: AssignmentStatus.LOCKED },
          trip: { status: TripStatus.AT_DROPOFF },
          stops: [],
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.updateJob(senderPrincipal, 'job-1', createInput()),
    ).rejects.toMatchObject({
      response: { code: 'JOB_NOT_EDITABLE' },
    });
  });

  it('allows FULL update while BIDDING', async () => {
    const updated = {
      id: 'job-1',
      title: 'PER_KM QA job',
      status: JobStatus.BIDDING,
      pricingModel: 'PER_KM',
      senderCompanyId: 'co-s',
      deadWeightKg: 200,
      lengthCm: 120,
      widthCm: 80,
      heightCm: 80,
      chargeableWeightKg: 250,
      minVehicleClass: 'UTE',
      recommendedVehicleClass: 'UTE',
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      loadTypes: ['GENERAL'],
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 12,
      routeDurationMinutes: 30,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 5000,
      estimateGstCents: 500,
      estimateIncGstCents: 5500,
      publishedAt: new Date(),
      createdAt: new Date(),
      pickupAt: new Date(),
      receiverName: 'Receiver Co',
      receiverEmail: 'receiver@yopmail.com',
      receiverPhone: null,
      stops: [],
      proposals: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([{ id: 'terr-mel', code: 'MEL' }]),
      },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.BIDDING,
          senderCompanyId: 'co-s',
          title: 'Old',
          assignment: null,
          trip: null,
          stops: [],
        }),
        update: jest.fn().mockResolvedValue(updated),
      },
    };
    const service = makeService(prisma);
    const result = await service.updateJob(senderPrincipal, 'job-1', createInput());
    expect(result.id).toBe('job-1');
    expect(result.editability.mode).toBe('FULL');
  });

  it('receiver update works while IN_TRANSIT after lock', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: { id: 'co-s', type: CompanyType.SENDER },
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.ASSIGNED,
          senderCompanyId: 'co-s',
          title: 'Live',
          assignment: { status: AssignmentStatus.LOCKED },
          trip: { status: TripStatus.IN_TRANSIT },
          stops: [{ id: 'stop-drop', stopType: 'DROPOFF' }],
        }),
        update: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.ASSIGNED,
          pricingModel: 'PER_KM',
          title: 'Live',
          receiverName: 'New Receiver',
          receiverEmail: 'new@yopmail.com',
          receiverPhone: null,
          pickupAt: null,
          deadWeightKg: 100,
          lengthCm: 10,
          widthCm: 10,
          heightCm: 10,
          chargeableWeightKg: 100,
          loadTypes: [],
          requiresDg: false,
          requiresReefer: false,
          requiresOversize: false,
          minVehicleClass: 'UTE',
          recommendedVehicleClass: 'UTE',
          siteManeuverability: null,
          siteFacility: null,
          siteDisclaimerAcceptedAt: null,
          hourlyPattern: null,
          routeDistanceKm: 10,
          routeDurationMinutes: 20,
          routeFatigueBreakMinutes: 0,
          billableHours: null,
          estimateExGstCents: 1000,
          estimateGstCents: 100,
          estimateIncGstCents: 1100,
          publishedAt: null,
          createdAt: new Date(),
          stops: [],
        }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          jobStop: { update: jest.fn() },
          job: {
            update: jest.fn().mockResolvedValue({
              id: 'job-1',
              status: JobStatus.ASSIGNED,
              pricingModel: 'PER_KM',
              title: 'Live',
              receiverName: 'New Receiver',
              receiverEmail: 'new@yopmail.com',
              receiverPhone: null,
              pickupAt: null,
              deadWeightKg: 100,
              lengthCm: 10,
              widthCm: 10,
              heightCm: 10,
              chargeableWeightKg: 100,
              loadTypes: [],
              requiresDg: false,
              requiresReefer: false,
              requiresOversize: false,
              minVehicleClass: 'UTE',
              recommendedVehicleClass: 'UTE',
              siteManeuverability: null,
              siteFacility: null,
              siteDisclaimerAcceptedAt: null,
              hourlyPattern: null,
              routeDistanceKm: 10,
              routeDurationMinutes: 20,
              routeFatigueBreakMinutes: 0,
              billableHours: null,
              estimateExGstCents: 1000,
              estimateGstCents: 100,
              estimateIncGstCents: 1100,
              publishedAt: null,
              createdAt: new Date(),
              stops: [],
            }),
          },
        }),
      ),
    };
    const input: JobReceiverUpdateInput = {
      receiverName: 'New Receiver',
      receiverEmail: 'new@yopmail.com',
      stops: [{ id: 'stop-drop', receiverName: 'Drop', receiverEmail: 'drop@yopmail.com' }],
    };
    const result = await makeService(prisma).updateJobReceiver(
      senderPrincipal,
      'job-1',
      input,
    );
    expect(result.receiverName).toBe('New Receiver');
    expect(result.editability.mode).toBe('RECEIVER');
  });

  it('updates DRAFT job fields and replaces stops', async () => {
    const updated = {
      id: 'job-1',
      title: 'PER_KM QA job',
      status: JobStatus.DRAFT,
      pricingModel: 'PER_KM',
      senderCompanyId: 'co-s',
      deadWeightKg: 200,
      lengthCm: 120,
      widthCm: 80,
      heightCm: 80,
      chargeableWeightKg: 250,
      minVehicleClass: 'UTE',
      recommendedVehicleClass: 'UTE',
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      loadTypes: ['GENERAL'],
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 12,
      routeDurationMinutes: 30,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 5000,
      estimateGstCents: 500,
      estimateIncGstCents: 5500,
      publishedAt: null,
      createdAt: new Date(),
      pickupAt: new Date(),
      receiverName: 'Receiver Co',
      receiverEmail: 'receiver@yopmail.com',
      receiverPhone: null,
      stops: [],
      proposals: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([{ id: 'terr-mel', code: 'MEL' }]),
      },
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.DRAFT,
          senderCompanyId: 'co-s',
          title: 'Old draft',
          assignment: null,
          trip: null,
          stops: [],
        }),
        update: jest.fn().mockResolvedValue(updated),
      },
    };
    const service = makeService(prisma);
    const result = await service.updateJob(senderPrincipal, 'job-1', createInput());
    expect(result.id).toBe('job-1');
    expect(prisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          routeDistanceKm: 12,
        }),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job.updated',
        entityId: 'job-1',
      }),
    );
  });
});


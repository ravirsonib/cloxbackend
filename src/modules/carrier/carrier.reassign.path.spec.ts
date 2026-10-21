import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  CompanyStatus,
  DriverStatus,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { CarrierService } from './carrier.service';

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('CarrierService.reassignAssignment', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: jest.fn().mockReturnValue(true),
    createConnectAccount: jest.fn(),
    createAccountLink: jest.fn(),
    retrieveConnectAccount: jest.fn(),
  };
  const config = { get: () => undefined };
  const drivers = {
    createInviteToken: jest.fn(),
    sendInviteMail: jest.fn(),
    inviteUrl: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new CarrierService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
      drivers as never,
      { sendRegistrationConfirmation: jest.fn().mockResolvedValue({ skipped: true }) } as never,
      { resolveInviteForRegister: jest.fn().mockResolvedValue({ referredByAdminUserId: null, inviteId: null, prospectId: null, homeRegionId: null }), markInviteAccepted: jest.fn() } as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const lockedAssignment = {
    id: 'asg-1',
    status: AssignmentStatus.LOCKED,
    vehicleId: 'veh-old',
    driverId: 'drv-old',
    job: { id: 'job-1', minVehicleClass: 'RIGID_1_2T', title: 'Job' },
    trip: { id: 'trip-1', status: TripStatus.EN_ROUTE_PICKUP },
    vehicle: { id: 'veh-old', registration: 'OLD' },
    driver: { id: 'drv-old', user: { email: 'old@yopmail.com', name: 'Old' } },
  };

  it('404 when assignment missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: {
            id: 'co-c',
            type: 'CARRIER',
            status: CompanyStatus.BID_ELIGIBLE,
          },
        }),
      },
      assignment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).reassignAssignment(carrier, 'asg-1', {
        vehicleId: '11111111-1111-1111-1111-111111111111',
        driverId: '22222222-2222-2222-2222-222222222222',
        reason: 'Breakdown',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects undersized vehicle class', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: {
            id: 'co-c',
            type: 'CARRIER',
            status: CompanyStatus.BID_ELIGIBLE,
          },
        }),
      },
      assignment: { findFirst: jest.fn().mockResolvedValue(lockedAssignment) },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-new',
          companyId: 'co-c',
          status: VehicleStatus.ACTIVE,
          vehicleClass: 'UTE',
        }),
      },
    };
    try {
      await makeService(prisma).reassignAssignment(carrier, 'asg-1', {
        vehicleId: '11111111-1111-1111-1111-111111111111',
        driverId: '22222222-2222-2222-2222-222222222222',
        reason: 'Breakdown',
      });
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }
  });

  it('reassigns and resets safety when driver changes', async () => {
    const tripUpdate = jest.fn().mockResolvedValue({});
    const assignmentUpdate = jest.fn().mockResolvedValue({
      id: 'asg-1',
      status: AssignmentStatus.LOCKED,
      vehicleId: 'veh-new',
      driverId: 'drv-new',
      vehicle: {
        id: 'veh-new',
        registration: 'NEW',
        vehicleClass: 'RIGID_1_2T',
        status: VehicleStatus.ACTIVE,
      },
      driver: {
        id: 'drv-new',
        status: DriverStatus.ACTIVE,
        user: { email: 'new@yopmail.com', name: 'New' },
      },
      trip: { id: 'trip-1', status: TripStatus.EN_ROUTE_PICKUP },
      job: {
        id: 'job-1',
        title: 'Job',
        status: 'ASSIGNED',
        minVehicleClass: 'RIGID_1_2T',
      },
    });

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: {
            id: 'co-c',
            type: 'CARRIER',
            status: CompanyStatus.BID_ELIGIBLE,
          },
        }),
      },
      assignment: {
        findFirst: jest.fn().mockResolvedValue(lockedAssignment),
        update: assignmentUpdate,
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-new',
          companyId: 'co-c',
          status: VehicleStatus.ACTIVE,
          vehicleClass: 'RIGID_1_2T',
        }),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-new',
          companyId: 'co-c',
          status: DriverStatus.ACTIVE,
          licenceClass: 'MR',
          licenceExpiry: new Date('2099-01-01'),
          nhvrAcknowledgedAt: new Date('2026-01-01'),
        }),
      },
      trip: { update: tripUpdate },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          assignment: { update: assignmentUpdate },
          trip: { update: tripUpdate },
        }),
      ),
    };

    const result = await makeService(prisma).reassignAssignment(carrier, 'asg-1', {
      vehicleId: '11111111-1111-1111-1111-111111111111',
      driverId: '22222222-2222-2222-2222-222222222222',
      reason: 'Breakdown on highway',
    });

    expect(result.safetyReset).toBe(true);
    expect(result.trip?.status).toBe(TripStatus.PENDING_GATES);
    expect(tripUpdate).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: expect.objectContaining({
        status: TripStatus.PENDING_GATES,
        safetyPassedAt: null,
        safetyFailedAt: null,
        startedAt: null,
      }),
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'assignment.reassigned',
        metadata: expect.objectContaining({
          driverChanged: true,
          safetyReset: true,
          reason: 'Breakdown on highway',
        }),
      }),
    );
  });

  it('rejects completed trip', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: {
            id: 'co-c',
            type: 'CARRIER',
            status: CompanyStatus.BID_ELIGIBLE,
          },
        }),
      },
      assignment: {
        findFirst: jest.fn().mockResolvedValue({
          ...lockedAssignment,
          trip: { id: 'trip-1', status: TripStatus.COMPLETED },
        }),
      },
    };
    await expect(
      makeService(prisma).reassignAssignment(carrier, 'asg-1', {
        vehicleId: '11111111-1111-1111-1111-111111111111',
        driverId: '22222222-2222-2222-2222-222222222222',
        reason: 'Too late',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

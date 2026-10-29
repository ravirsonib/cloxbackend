import {
  DriverStatus,
  TripExceptionKind,
  TripExceptionPhase,
  TripExceptionStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ExceptionsService } from './exceptions.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
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

describe('ExceptionsService propose / approve / reject replacement', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    notifyTripExceptionOpened: jest.fn(),
    notifyTripExceptionReassigned: jest.fn().mockResolvedValue([]),
    notifyTripExceptionReplacementProposed: jest.fn().mockResolvedValue([]),
    notifyTripExceptionReplacementRejected: jest.fn().mockResolvedValue([]),
    notifyTripExceptionContinued: jest.fn(),
    notifyTripExceptionEscalated: jest.fn(),
    notifyTripExceptionReleased: jest.fn(),
  };
  const carrier = {
    reassignAssignment: jest.fn().mockResolvedValue({
      safetyReset: true,
      assignmentId: 'asg-1',
    }),
  };
  const payments = {
    adjustForMarketplaceRelease: jest.fn(),
    refundStub: jest.fn().mockResolvedValue({
      success: true,
      refundId: 're_1',
      mock: true,
    }),
  };
  const config = {
    get: (key: string) => (key === 'NOTIFY_EMAIL' ? 'ops@yopmail.com' : undefined),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ExceptionsService(
      prisma as never,
      audit as never,
      notifications as never,
      {
        userIdsForCompanies: jest.fn().mockResolvedValue([]),
        notifyUsers: jest.fn().mockResolvedValue(0),
      } as never,
      carrier as never,
      payments as never,
      config as never,
    );
  }

  const openRow = {
    id: 'ex-1',
    jobId: 'job-1',
    assignmentId: 'asg-1',
    tripId: 'trip-1',
    companyId: 'co-c',
    reportedByUserId: 'user-drv',
    kind: TripExceptionKind.VEHICLE_BREAKDOWN,
    phase: TripExceptionPhase.MID_TRIP,
    status: TripExceptionStatus.AWAITING_CARRIER,
    reasonCode: null,
    note: 'Engine',
    gpsLat: null,
    gpsLng: null,
    photoDocumentId: null,
    proposedVehicleId: null,
    proposedDriverId: null,
    proposedAt: null,
    proposedByUserId: null,
    openedAt: new Date(),
    escalatedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    job: { id: 'job-1', title: 'Load', rescueDiscountPercent: null, marketplacePriority: false },
    assignment: {
      vehicle: null,
      driver: null,
      carrierCompany: {
        email: 'carrier@yopmail.com',
        users: [{ email: 'carrier@yopmail.com' }],
      },
    },
    proposedVehicle: null,
    proposedDriver: null,
  };

  beforeEach(() => jest.clearAllMocks());

  it('reassign proposes without swapping crew', async () => {
    const update = jest.fn().mockResolvedValue({
      ...openRow,
      status: TripExceptionStatus.AWAITING_SENDER_APPROVAL,
      proposedVehicleId: 'veh-2',
      proposedDriverId: 'drv-2',
      proposedAt: new Date(),
      proposedByUserId: 'user-carrier',
      proposedVehicle: {
        id: 'veh-2',
        registration: 'XYZ',
        label: null,
        vehicleClass: 'UTE',
      },
      proposedDriver: {
        id: 'drv-2',
        user: { email: 'd2@yopmail.com', name: 'Relief' },
      },
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-c' }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue({
          ...openRow,
          job: {
            id: 'job-1',
            title: 'Load',
            receiverEmail: 'sender@yopmail.com',
            senderCompany: { email: null, users: [{ email: 'sender@yopmail.com' }] },
          },
        }),
        update,
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-2',
          registration: 'XYZ',
          label: null,
          vehicleClass: 'UTE',
          status: VehicleStatus.ACTIVE,
        }),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-2',
          status: DriverStatus.ACTIVE,
          user: { email: 'd2@yopmail.com', name: 'Relief' },
        }),
      },
    };

    const result = await makeService(prisma).reassign(carrierPrincipal, 'ex-1', {
      vehicleId: 'veh-2',
      driverId: 'drv-2',
      note: 'Relief crew',
    });

    expect(result.exception.status).toBe(TripExceptionStatus.AWAITING_SENDER_APPROVAL);
    expect(result.proposal.status).toBe('AWAITING_SENDER_APPROVAL');
    expect(carrier.reassignAssignment).not.toHaveBeenCalled();
    expect(notifications.notifyTripExceptionReplacementProposed).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: TripExceptionStatus.AWAITING_SENDER_APPROVAL,
          proposedVehicleId: 'veh-2',
          proposedDriverId: 'drv-2',
        }),
      }),
    );
  });

  it('approveReplacement applies reassignAssignment', async () => {
    const pending = {
      ...openRow,
      status: TripExceptionStatus.AWAITING_SENDER_APPROVAL,
      proposedVehicleId: 'veh-2',
      proposedDriverId: 'drv-2',
      proposedByUserId: 'user-carrier',
      proposedAt: new Date(),
      proposedVehicle: {
        id: 'veh-2',
        registration: 'XYZ',
        label: null,
        vehicleClass: 'UTE',
      },
      proposedDriver: {
        id: 'drv-2',
        user: { email: 'd2@yopmail.com', name: 'Relief' },
      },
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-sender', companyId: 'co-s' })
          .mockResolvedValueOnce({
            id: 'user-carrier',
            email: 'carrier@yopmail.com',
            companyId: 'co-c',
          }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Load',
          senderCompanyId: 'co-s',
          receiverEmail: 'sender@yopmail.com',
          senderCompany: { email: null, users: [{ email: 'sender@yopmail.com' }] },
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'carrier@yopmail.com',
          users: [{ email: 'carrier@yopmail.com' }],
        }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue(pending),
        update: jest
          .fn()
          .mockResolvedValueOnce({ ...pending, status: TripExceptionStatus.REASSIGN_IN_PROGRESS })
          .mockResolvedValueOnce({
            ...pending,
            status: TripExceptionStatus.RESOLVED_REASSIGNED,
            resolvedAt: new Date(),
          }),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          driver: { user: { email: 'old@yopmail.com' } },
        }),
      },
      trip: { update: jest.fn() },
    };

    const result = await makeService(prisma).approveReplacement(senderPrincipal, 'ex-1', {});
    expect(result.exception.status).toBe(TripExceptionStatus.RESOLVED_REASSIGNED);
    expect(carrier.reassignAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-carrier', role: 'TRANSPORT_COMPANY' }),
      'asg-1',
      expect.objectContaining({ vehicleId: 'veh-2', driverId: 'drv-2' }),
    );
    expect(notifications.notifyTripExceptionReassigned).toHaveBeenCalled();
  });

  it('rejectReplacement cancels job and refunds', async () => {
    const pending = {
      ...openRow,
      status: TripExceptionStatus.AWAITING_SENDER_APPROVAL,
      proposedVehicleId: 'veh-2',
      proposedDriverId: 'drv-2',
      proposedByUserId: 'user-carrier',
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'user-sender', companyId: 'co-s' })
          .mockResolvedValue({ email: 'driver@yopmail.com' }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Load',
          senderCompanyId: 'co-s',
          receiverEmail: 'sender@yopmail.com',
          senderCompany: { email: null, users: [] },
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'carrier@yopmail.com',
          users: [{ email: 'carrier@yopmail.com' }],
        }),
      },
      tripException: {
        findUnique: jest.fn().mockResolvedValue(pending),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          trip: { update: jest.fn() },
          assignment: { update: jest.fn() },
          job: { update: jest.fn() },
          tripException: {
            update: jest.fn().mockResolvedValue({
              ...pending,
              status: TripExceptionStatus.RESOLVED_CANCELLED,
              resolvedAt: new Date(),
              proposedVehicleId: null,
              proposedDriverId: null,
            }),
          },
        }),
      ),
    };

    const result = await makeService(prisma).rejectReplacement(senderPrincipal, 'ex-1', {
      note: 'Too late',
    });
    expect(result.exception.status).toBe(TripExceptionStatus.RESOLVED_CANCELLED);
    expect(result.cancelled).toBe(true);
    expect(payments.refundStub).toHaveBeenCalledWith(senderPrincipal, 'job-1');
    expect(notifications.notifyTripExceptionReplacementRejected).toHaveBeenCalled();
  });
});

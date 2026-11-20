import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DailySheetStatus, EwdActivityType, TripStatus } from '@prisma/client';
import { NhvrCalculatorService } from './nhvr-calculator.service';
import { NhvrService } from './nhvr.service';

describe('NhvrService driver EWD paths', () => {
  const calculator = new NhvrCalculatorService();
  const roadside = {
    createRoadsideSession: jest.fn().mockResolvedValue({
      id: 'pin-1',
      accessPin: '1234',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new NhvrService(prisma as never, calculator, roadside as never);
  }

  const driverRow = {
    id: 'drv-1',
    userId: 'user-1',
    baseTimezone: 'Australia/Sydney',
    fatigueScheme: 'STANDARD',
    user: { id: 'user-1', name: 'Driver One' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getStatus 404 when driver missing', async () => {
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(makeService(prisma).getStatus('user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getStatus ensures WORK when active EN_ROUTE trip and no open record', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'rec-1',
      activity: EwdActivityType.WORK,
      startTime: new Date(),
      endTime: null,
    });
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(driverRow) },
      ewdWorkRestRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create,
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          status: TripStatus.EN_ROUTE_PICKUP,
          odometerStartKm: 100,
          assignment: { vehicle: { registration: 'ABC123' } },
        }),
      },
    };
    const status = await makeService(prisma).getStatus('user-1');
    expect(create).toHaveBeenCalled();
    expect(status.currentActivity).toBe(EwdActivityType.WORK);
  });

  it('switchActivity closes prior, opens new, recomputes sheet', async () => {
    const open = {
      id: 'rec-open',
      activity: EwdActivityType.WORK,
      startTime: new Date(Date.now() - 20 * 60 * 1000),
      endTime: null,
    };
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(driverRow) },
      ewdWorkRestRecord: {
        findFirst: jest.fn().mockResolvedValue(open),
        findMany: jest.fn().mockResolvedValue([open]),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({
          id: 'rec-rest',
          activity: EwdActivityType.REST,
          startTime: new Date(),
        }),
      },
      ewdBreachRecord: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      ewdDailySheet: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const res = await makeService(prisma).switchActivity('user-1', {
      activity: EwdActivityType.REST,
    });
    expect(prisma.ewdWorkRestRecord.update).toHaveBeenCalled();
    expect(prisma.ewdWorkRestRecord.create).toHaveBeenCalled();
    expect(prisma.ewdDailySheet.upsert).toHaveBeenCalled();
    expect(res.record.activity).toBe(EwdActivityType.REST);
  });

  it('createManualRecord rejects end before start', async () => {
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(driverRow) },
    };
    await expect(
      makeService(prisma).createManualRecord('user-1', {
        activity: EwdActivityType.WORK,
        startTime: '2026-11-19T10:00:00.000Z',
        endTime: '2026-11-19T09:00:00.000Z',
        editReason: 'Forgot to log',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('syncFromTripBreak no-ops when already REST', async () => {
    const current = {
      id: 'rec-1',
      activity: EwdActivityType.REST,
      startTime: new Date(),
      endTime: null,
    };
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(driverRow) },
      ewdWorkRestRecord: {
        findFirst: jest.fn().mockResolvedValue(current),
      },
    };
    const res = await makeService(prisma).syncFromTripBreak('user-1', true);
    expect(res.skipped).toBe(true);
    expect(res.record.id).toBe('rec-1');
  });

  it('signDailySheet upserts SUBMITTED with declaration', async () => {
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(driverRow) },
      ewdWorkRestRecord: { findMany: jest.fn().mockResolvedValue([]) },
      ewdDailySheet: {
        upsert: jest
          .fn()
          .mockResolvedValueOnce({}) // recompute
          .mockResolvedValueOnce({
            id: 'sheet-1',
            status: DailySheetStatus.SUBMITTED,
            driverSignature: 'Driver One',
          }),
      },
    };
    const sheet = await makeService(prisma).signDailySheet('user-1', {
      date: '2026-11-19',
      signature: 'Driver One',
    });
    expect(sheet.status).toBe(DailySheetStatus.SUBMITTED);
    expect(prisma.ewdDailySheet.upsert).toHaveBeenCalled();
  });

  it('generateRoadsidePin delegates to roadside service', async () => {
    const prisma = {
      driver: { findUnique: jest.fn().mockResolvedValue(driverRow) },
    };
    const pin = await makeService(prisma).generateRoadsidePin('user-1');
    expect(roadside.createRoadsideSession).toHaveBeenCalledWith('drv-1');
    expect(pin.accessPin).toBe('1234');
  });
});

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, DriverAvailabilityType, DriverScheduleStatus, TripStatus, UserStatus } from '@prisma/client';
import { DriverScheduleService } from './driver-schedule.service';

describe('DriverScheduleService', () => {
  let service: DriverScheduleService;
  let mockPrisma: any;
  let mockAudit: any;

  const driverPrincipal = {
    id: 'user-drv-1',
    email: 'driver@example.com',
    kind: 'user' as const,
    role: 'DRIVER' as const,
    regionCodes: ['VIC'],
    territoryCodes: [] as string[],
  };

  const carrierPrincipal = {
    id: 'user-car-1',
    email: 'carrier@example.com',
    kind: 'user' as const,
    role: 'TRANSPORT_COMPANY' as const,
    regionCodes: ['VIC'],
    territoryCodes: [] as string[],
  };

  beforeEach(() => {
    mockAudit = {
      recordPlatform: jest.fn().mockResolvedValue(undefined),
    };
    mockPrisma = {
      isConnected: jest.fn().mockReturnValue(true),
      user: {
        findUnique: jest.fn(),
      },
      driver: {
        findFirst: jest.fn(),
      },
      assignment: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      driverScheduleEntry: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new DriverScheduleService(mockPrisma, mockAudit);
  });

  describe('requestTimeOff (Driver self-service)', () => {
    it('throws BadRequestException if startAt is after endAt', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: driverPrincipal.id,
        status: UserStatus.ACTIVE,
        driver: { id: 'drv-1', companyId: 'comp-1' },
      });

      await expect(
        service.requestTimeOff(driverPrincipal, {
          startAt: '2026-11-15T12:00:00.000Z',
          endAt: '2026-11-10T12:00:00.000Z',
          type: 'ANNUAL_LEAVE',
          isAllDay: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException with ACTIVE_ASSIGNMENT_COLLISION if driver has an overlapping locked job', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: driverPrincipal.id,
        status: UserStatus.ACTIVE,
        driver: { id: 'drv-1', companyId: 'comp-1' },
      });

      mockPrisma.assignment.findMany.mockResolvedValue([
        {
          id: 'asg-1',
          jobId: 'job-1042',
          job: {
            id: 'job-1042',
            title: 'Melbourne to Geelong',
            pickupAt: new Date('2026-11-12T08:00:00.000Z'),
            routeDurationMinutes: 180,
            routeFatigueBreakMinutes: 0,
          },
        },
      ]);

      await expect(
        service.requestTimeOff(driverPrincipal, {
          startAt: '2026-11-12T00:00:00.000Z',
          endAt: '2026-11-12T23:59:59.000Z',
          type: 'PERSONAL',
          isAllDay: true,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates a PENDING schedule entry and records audit when validation passes', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: driverPrincipal.id,
        status: UserStatus.ACTIVE,
        driver: { id: 'drv-1', companyId: 'comp-1' },
      });
      mockPrisma.assignment.findMany.mockResolvedValue([]);

      mockPrisma.driverScheduleEntry.create.mockResolvedValue({
        id: 'sched-1',
        driverId: 'drv-1',
        companyId: 'comp-1',
        type: DriverAvailabilityType.ANNUAL_LEAVE,
        status: DriverScheduleStatus.PENDING,
        startAt: new Date('2026-11-20T00:00:00.000Z'),
        endAt: new Date('2026-11-25T23:59:59.000Z'),
        isAllDay: true,
      });

      const result = await service.requestTimeOff(driverPrincipal, {
        startAt: '2026-11-20T00:00:00.000Z',
        endAt: '2026-11-25T23:59:59.000Z',
        type: 'ANNUAL_LEAVE',
        isAllDay: true,
        reason: 'Holiday',
      });

      expect(result.id).toBe('sched-1');
      expect(result.status).toBe(DriverScheduleStatus.PENDING);
      expect(mockAudit.recordPlatform).toHaveBeenCalled();
    });
  });

  describe('cancelTimeOff', () => {
    it('sets status to CANCELLED and audits', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: driverPrincipal.id,
        status: UserStatus.ACTIVE,
        driver: { id: 'drv-1', companyId: 'comp-1' },
      });

      mockPrisma.driverScheduleEntry.findFirst.mockResolvedValue({
        id: 'sched-1',
        driverId: 'drv-1',
        status: DriverScheduleStatus.PENDING,
      });

      mockPrisma.driverScheduleEntry.update.mockResolvedValue({
        id: 'sched-1',
        status: DriverScheduleStatus.CANCELLED,
      });

      const result = await service.cancelTimeOff(driverPrincipal, 'sched-1');
      expect(result.status).toBe(DriverScheduleStatus.CANCELLED);
      expect(mockAudit.recordPlatform).toHaveBeenCalled();
    });
  });

  describe('Carrier fleet management', () => {
    it('creates an auto-APPROVED schedule entry for a fleet driver', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: carrierPrincipal.id,
        companyId: 'comp-1',
        company: { id: 'comp-1' },
      });

      mockPrisma.driver.findFirst.mockResolvedValue({
        id: 'drv-1',
        companyId: 'comp-1',
      });

      mockPrisma.driverScheduleEntry.create.mockResolvedValue({
        id: 'sched-2',
        driverId: 'drv-1',
        companyId: 'comp-1',
        type: DriverAvailabilityType.ROSTERED_OFF,
        status: DriverScheduleStatus.APPROVED,
        startAt: new Date('2026-11-15T00:00:00.000Z'),
        endAt: new Date('2026-11-15T23:59:59.000Z'),
      });

      const result = await service.createDriverScheduleByCarrier(carrierPrincipal, {
        driverId: 'drv-1',
        startAt: '2026-11-15T00:00:00.000Z',
        endAt: '2026-11-15T23:59:59.000Z',
        type: 'ROSTERED_OFF',
        isAllDay: true,
        reason: 'RDO',
      });

      expect(result.status).toBe(DriverScheduleStatus.APPROVED);
      expect(mockAudit.recordPlatform).toHaveBeenCalled();
    });

    it('requires rejectionReason when carrier rejects time-off request', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: carrierPrincipal.id,
        companyId: 'comp-1',
        company: { id: 'comp-1' },
      });

      mockPrisma.driverScheduleEntry.findFirst.mockResolvedValue({
        id: 'sched-3',
        companyId: 'comp-1',
        status: DriverScheduleStatus.PENDING,
      });

      await expect(
        service.reviewDriverSchedule(carrierPrincipal, 'sched-3', {
          status: 'REJECTED',
          rejectionReason: '',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('approves a pending request and updates audit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: carrierPrincipal.id,
        companyId: 'comp-1',
        company: { id: 'comp-1' },
      });

      mockPrisma.driverScheduleEntry.findFirst.mockResolvedValue({
        id: 'sched-3',
        companyId: 'comp-1',
        status: DriverScheduleStatus.PENDING,
      });

      mockPrisma.driverScheduleEntry.update.mockResolvedValue({
        id: 'sched-3',
        status: DriverScheduleStatus.APPROVED,
        reviewedAt: new Date(),
      });

      const result = await service.reviewDriverSchedule(carrierPrincipal, 'sched-3', {
        status: 'APPROVED',
      });

      expect(result.status).toBe(DriverScheduleStatus.APPROVED);
      expect(mockAudit.recordPlatform).toHaveBeenCalled();
    });
  });
});

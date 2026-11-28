import { BadRequestException, ConflictException } from '@nestjs/common';
import { AssignmentStatus, DriverAvailabilityType, DriverScheduleStatus, TripStatus } from '@prisma/client';
import {
  calculateJobExecutionWindow,
  checkDriverAvailabilityForWindow,
  assertDriverAvailabilityForWindow,
  assertCrewNotBusyElsewhere,
  LONG_HAUL_REST_BUFFER_MINUTES,
  intervalsOverlap,
  DEFAULT_JOB_DURATION_MINUTES,
  DEFAULT_TURNAROUND_BUFFER_MINUTES,
  FATIGUE_BREAK_MINUTES,
} from './driver-schedule.util';

describe('Driver Schedule & Availability Collision Engine', () => {
  describe('calculateJobExecutionWindow', () => {
    it('uses default duration (120m) and buffer (60m) when job values are null', () => {
      const now = new Date('2026-11-10T08:00:00.000Z');
      const window = calculateJobExecutionWindow(
        { pickupAt: now, routeDurationMinutes: null, routeFatigueBreakMinutes: null },
      );

      expect(window.windowStart.toISOString()).toBe('2026-11-10T08:00:00.000Z');
      // 120m + 0m fatigue + 60m buffer = 180m (3 hours)
      expect(window.windowEnd.toISOString()).toBe('2026-11-10T11:00:00.000Z');
      expect(window.durationMinutes).toBe(DEFAULT_JOB_DURATION_MINUTES);
      expect(window.fatigueBreakMinutes).toBe(0);
      expect(window.bufferMinutes).toBe(DEFAULT_TURNAROUND_BUFFER_MINUTES);
    });

    it('adds 15-min mandatory NHVR rest break when route duration exceeds 5.25 hours (315 mins)', () => {
      const now = new Date('2026-11-10T06:00:00.000Z');
      const window = calculateJobExecutionWindow({
        pickupAt: now,
        routeDurationMinutes: 360, // 6 hours
        routeFatigueBreakMinutes: null,
      });

      // 360m duration + 15m fatigue + 60m buffer = 435 mins = 7 hours 15 mins
      expect(window.fatigueBreakMinutes).toBe(FATIGUE_BREAK_MINUTES);
      expect(window.windowEnd.toISOString()).toBe('2026-11-10T13:15:00.000Z');
    });

    it('respects explicitly provided routeFatigueBreakMinutes', () => {
      const now = new Date('2026-11-10T06:00:00.000Z');
      const window = calculateJobExecutionWindow({
        pickupAt: now,
        routeDurationMinutes: 180,
        routeFatigueBreakMinutes: 30,
      });

      // 180 + 30 + 60 = 270 mins = 4 hours 30 mins
      expect(window.fatigueBreakMinutes).toBe(30);
      expect(window.windowEnd.toISOString()).toBe('2026-11-10T10:30:00.000Z');
    });
  });

  describe('intervalsOverlap', () => {
    const aStart = new Date('2026-11-10T10:00:00.000Z');
    const aEnd = new Date('2026-11-10T14:00:00.000Z');

    it('returns false when interval B is completely before interval A', () => {
      const bStart = new Date('2026-11-10T06:00:00.000Z');
      const bEnd = new Date('2026-11-10T09:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(false);
    });

    it('returns false when interval B touches the boundary end-to-start (10:00:00)', () => {
      const bStart = new Date('2026-11-10T08:00:00.000Z');
      const bEnd = new Date('2026-11-10T10:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(false);
    });

    it('returns true when interval B partially overlaps the start of A', () => {
      const bStart = new Date('2026-11-10T08:00:00.000Z');
      const bEnd = new Date('2026-11-10T11:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(true);
    });

    it('returns true when interval B is fully inside interval A', () => {
      const bStart = new Date('2026-11-10T11:00:00.000Z');
      const bEnd = new Date('2026-11-10T13:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(true);
    });

    it('returns true when interval B spans completely over interval A', () => {
      const bStart = new Date('2026-11-10T08:00:00.000Z');
      const bEnd = new Date('2026-11-10T16:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(true);
    });

    it('returns true when interval B partially overlaps the end of A', () => {
      const bStart = new Date('2026-11-10T13:00:00.000Z');
      const bEnd = new Date('2026-11-10T16:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(true);
    });

    it('returns false when interval B touches start-to-end at 14:00:00', () => {
      const bStart = new Date('2026-11-10T14:00:00.000Z');
      const bEnd = new Date('2026-11-10T16:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(false);
    });

    it('returns false when interval B is completely after interval A', () => {
      const bStart = new Date('2026-11-10T15:00:00.000Z');
      const bEnd = new Date('2026-11-10T18:00:00.000Z');
      expect(intervalsOverlap(aStart, aEnd, bStart, bEnd)).toBe(false);
    });
  });

  describe('checkDriverAvailabilityForWindow', () => {
    const windowStart = new Date('2026-11-12T08:00:00.000Z');
    const windowEnd = new Date('2026-11-12T13:00:00.000Z');

    it('returns isAvailable: true when driver has no scheduled leave and no committed assignments', async () => {
      const mockPrisma = {
        driverScheduleEntry: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        assignment: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      } as any;

      const result = await checkDriverAvailabilityForWindow(mockPrisma, {
        driverId: 'drv-1',
        windowStart,
        windowEnd,
      });

      expect(result.isAvailable).toBe(true);
    });

    it('returns isAvailable: false with DRIVER_UNAVAILABLE_SCHEDULED if driver has an approved leave', async () => {
      const mockPrisma = {
        driverScheduleEntry: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sched-1',
            type: DriverAvailabilityType.ANNUAL_LEAVE,
            startAt: new Date('2026-11-10T00:00:00.000Z'),
            endAt: new Date('2026-11-15T23:59:59.000Z'),
            reason: 'Vacation',
          }),
        },
        assignment: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      } as any;

      const result = await checkDriverAvailabilityForWindow(mockPrisma, {
        driverId: 'drv-1',
        windowStart,
        windowEnd,
      });

      expect(result.isAvailable).toBe(false);
      expect(result.code).toBe('DRIVER_UNAVAILABLE_SCHEDULED');
      expect(result.conflictingScheduleEntryId).toBe('sched-1');
      expect(result.message).toContain('annual leave');
      expect(mockPrisma.driverScheduleEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: { not: DriverAvailabilityType.OVERTIME_AVAILABLE },
          }),
        }),
      );
    });

    it('excludes OVERTIME_AVAILABLE from leave collision filter (extra capacity)', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const mockPrisma = {
        driverScheduleEntry: { findFirst },
        assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      } as any;

      const result = await checkDriverAvailabilityForWindow(mockPrisma, {
        driverId: 'drv-1',
        windowStart,
        windowEnd,
      });

      expect(result.isAvailable).toBe(true);
      expect(findFirst.mock.calls[0][0].where.type).toEqual({
        not: DriverAvailabilityType.OVERTIME_AVAILABLE,
      });
    });

    it('returns isAvailable: false with DRIVER_BUSY_ASSIGNMENT_COLLISION if driver is committed to another overlapping job', async () => {
      const mockPrisma = {
        driverScheduleEntry: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        assignment: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'asg-1',
            jobId: 'job-999',
            job: {
              id: 'job-999',
              pickupAt: new Date('2026-11-12T10:00:00.000Z'),
              routeDurationMinutes: 180,
              routeFatigueBreakMinutes: 0,
            },
          }),
        },
      } as any;

      const result = await checkDriverAvailabilityForWindow(mockPrisma, {
        driverId: 'drv-1',
        windowStart,
        windowEnd,
      });

      expect(result.isAvailable).toBe(false);
      expect(result.code).toBe('DRIVER_BUSY_ASSIGNMENT_COLLISION');
      expect(result.conflictingJobId).toBe('job-999');
    });
  });

  describe('assertDriverAvailabilityForWindow', () => {
    const windowStart = new Date('2026-11-12T08:00:00.000Z');
    const windowEnd = new Date('2026-11-12T13:00:00.000Z');

    it('resolves cleanly without throwing when driver is available', async () => {
      const mockPrisma = {
        driverScheduleEntry: { findFirst: jest.fn().mockResolvedValue(null) },
        assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      } as any;

      await expect(
        assertDriverAvailabilityForWindow(mockPrisma, {
          driverId: 'drv-1',
          windowStart,
          windowEnd,
        }),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequestException when driver has scheduled leave', async () => {
      const mockPrisma = {
        driverScheduleEntry: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sched-1',
            type: DriverAvailabilityType.MEDICAL_LEAVE,
            startAt: new Date('2026-11-12T00:00:00.000Z'),
            endAt: new Date('2026-11-12T23:59:59.000Z'),
          }),
        },
        assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      } as any;

      await expect(
        assertDriverAvailabilityForWindow(mockPrisma, {
          driverId: 'drv-1',
          windowStart,
          windowEnd,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when driver is already locked on an overlapping job', async () => {
      const mockPrisma = {
        driverScheduleEntry: { findFirst: jest.fn().mockResolvedValue(null) },
        assignment: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'asg-1',
            jobId: 'job-999',
            job: {
              id: 'job-999',
              pickupAt: new Date('2026-11-12T09:00:00.000Z'),
              routeDurationMinutes: 120,
            },
          }),
        },
      } as any;

      await expect(
        assertDriverAvailabilityForWindow(mockPrisma, {
          driverId: 'drv-1',
          windowStart,
          windowEnd,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('window-based future scheduling & corner cases', () => {
    it('applies 7-hour NHVR rest buffer for long-haul jobs (> 7h driving)', () => {
      const win = calculateJobExecutionWindow({
        pickupAt: new Date('2026-11-01T06:00:00.000Z'),
        routeDurationMinutes: 480, // 8 hours driving
      });
      expect(win.bufferMinutes).toBe(LONG_HAUL_REST_BUFFER_MINUTES);
      expect(win.fatigueBreakMinutes).toBe(15);
    });

    it('allows driver/vehicle busy today to bid on a non-overlapping job 15 days later', async () => {
      const todayJob = {
        id: 'asg-today',
        jobId: 'job-today',
        status: 'LOCKED',
        job: {
          pickupAt: new Date('2026-11-01T08:00:00.000Z'),
          routeDurationMinutes: 120,
          routeFatigueBreakMinutes: 0,
        },
      };
      const mockPrisma = {
        assignment: { findMany: jest.fn().mockResolvedValue([todayJob]) },
        proposal: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;

      const day15Start = new Date('2026-11-16T08:00:00.000Z');
      const day15End = new Date('2026-11-16T11:00:00.000Z');

      await expect(
        assertCrewNotBusyElsewhere(mockPrisma, {
          vehicleId: 'veh-1',
          driverId: 'drv-1',
          excludeJobId: 'job-day15',
          windowStart: day15Start,
          windowEnd: day15End,
        }),
      ).resolves.toBeUndefined();
    });

    it('detects collision on the 2nd assignment when driver has multiple future jobs', async () => {
      const mockPrisma = {
        driverScheduleEntry: { findFirst: jest.fn().mockResolvedValue(null) },
        assignment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'asg-day2',
              jobId: 'job-day2',
              job: {
                id: 'job-day2',
                pickupAt: new Date('2026-11-02T08:00:00.000Z'),
                routeDurationMinutes: 120,
              },
            },
            {
              id: 'asg-day15',
              jobId: 'job-day15',
              job: {
                id: 'job-day15',
                pickupAt: new Date('2026-11-16T09:00:00.000Z'),
                routeDurationMinutes: 120,
              },
            },
          ]),
        },
      } as any;

      const res = await checkDriverAvailabilityForWindow(mockPrisma, {
        driverId: 'drv-1',
        windowStart: new Date('2026-11-16T08:00:00.000Z'),
        windowEnd: new Date('2026-11-16T11:00:00.000Z'),
      });
      expect(res.isAvailable).toBe(false);
      expect(res.code).toBe('DRIVER_BUSY_ASSIGNMENT_COLLISION');
      expect(res.conflictingJobId).toBe('job-day15');
    });

    it('surfaces non-blocking pendingLeaveWarning when driver has a PENDING leave request', async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce(null) // APPROVED check
        .mockResolvedValueOnce({
          id: 'leave-pending-1',
          type: 'ANNUAL_LEAVE',
          startAt: new Date('2026-11-16T00:00:00.000Z'),
          endAt: new Date('2026-11-17T00:00:00.000Z'),
        });
      const mockPrisma = {
        driverScheduleEntry: { findFirst },
        assignment: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;

      const res = await checkDriverAvailabilityForWindow(mockPrisma, {
        driverId: 'drv-1',
        windowStart: new Date('2026-11-16T08:00:00.000Z'),
        windowEnd: new Date('2026-11-16T11:00:00.000Z'),
      });
      expect(res.isAvailable).toBe(true);
      expect(res.pendingLeaveWarning?.scheduleEntryId).toBe('leave-pending-1');
    });
  });
});

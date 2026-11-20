import { EwdActivityType, EwdBreachSeverity } from '@prisma/client';
import { ActivityInterval, NhvrCalculatorService } from './nhvr-calculator.service';

describe('NhvrCalculatorService', () => {
  let service: NhvrCalculatorService;

  beforeEach(() => {
    service = new NhvrCalculatorService();
  });

  describe('roundMinutes', () => {
    it('rounds work up to next 15-min boundary', () => {
      expect(service.roundMinutes(1, EwdActivityType.WORK)).toBe(15);
      expect(service.roundMinutes(15, EwdActivityType.WORK)).toBe(15);
      expect(service.roundMinutes(16, EwdActivityType.WORK)).toBe(30);
    });

    it('rounds rest down to previous 15-min boundary', () => {
      expect(service.roundMinutes(14, EwdActivityType.REST)).toBe(0);
      expect(service.roundMinutes(15, EwdActivityType.REST)).toBe(15);
      expect(service.roundMinutes(29, EwdActivityType.REST)).toBe(15);
    });
  });

  describe('evaluateBreaches', () => {
    it('detects short-term breach when work exceeds 5.5 hours without 15m rest', () => {
      const intervals: ActivityInterval[] = [
        {
          activity: EwdActivityType.WORK,
          startTime: new Date('2026-11-15T00:00:00Z'),
          endTime: new Date('2026-11-15T06:00:00Z'),
          durationMinutes: 360, // 6 hours
        },
      ];
      const breaches = service.evaluateBreaches(intervals);
      expect(breaches.length).toBeGreaterThanOrEqual(1);
      expect(breaches[0].ruleName).toContain('5.5h Work Limit');
      expect(breaches[0].severity).toBe(EwdBreachSeverity.MINOR);
    });

    it('clears work counter when continuous rest >= 15 min occurs', () => {
      const intervals: ActivityInterval[] = [
        {
          activity: EwdActivityType.WORK,
          startTime: new Date('2026-11-15T00:00:00Z'),
          endTime: new Date('2026-11-15T05:00:00Z'),
          durationMinutes: 300,
        },
        {
          activity: EwdActivityType.REST,
          startTime: new Date('2026-11-15T05:00:00Z'),
          endTime: new Date('2026-11-15T05:20:00Z'),
          durationMinutes: 20,
        },
        {
          activity: EwdActivityType.WORK,
          startTime: new Date('2026-11-15T05:20:00Z'),
          endTime: new Date('2026-11-15T06:20:00Z'),
          durationMinutes: 60,
        },
      ];
      const workSinceBreak = service.findMinutesSinceLastRestBreak(intervals);
      expect(workSinceBreak).toBe(60);
      const breaches = service.evaluateBreaches(intervals);
      expect(breaches.filter((b) => b.ruleName.includes('5.5h')).length).toBe(0);
    });

    it('detects 12h max work in 24h', () => {
      const intervals: ActivityInterval[] = [
        {
          activity: EwdActivityType.WORK,
          startTime: new Date('2026-11-15T00:00:00Z'),
          endTime: new Date('2026-11-15T13:00:00Z'),
          durationMinutes: 780,
        },
      ];
      const breaches = service.evaluateBreaches(intervals);
      expect(breaches.some((b) => b.ruleName.includes('12h Max Work'))).toBe(true);
    });

    it('detects missing 7h continuous rest when work >= 8h', () => {
      const intervals: ActivityInterval[] = [
        {
          activity: EwdActivityType.WORK,
          startTime: new Date('2026-11-15T00:00:00Z'),
          endTime: new Date('2026-11-15T09:00:00Z'),
          durationMinutes: 540,
        },
        {
          activity: EwdActivityType.REST,
          startTime: new Date('2026-11-15T09:00:00Z'),
          endTime: new Date('2026-11-15T12:00:00Z'),
          durationMinutes: 180,
        },
      ];
      const breaches = service.evaluateBreaches(intervals);
      expect(breaches.some((b) => b.ruleName.includes('7h Continuous Rest'))).toBe(true);
    });
  });
});


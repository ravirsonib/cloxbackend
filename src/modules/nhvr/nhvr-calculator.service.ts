import { Injectable } from '@nestjs/common';
import { EwdActivityType, EwdBreachSeverity } from '@prisma/client';
import { EwdBreachItem, FatigueStatusResult } from './nhvr.types';

export interface ActivityInterval {
  activity: EwdActivityType;
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
}

@Injectable()
export class NhvrCalculatorService {
  roundMinutes(minutes: number, activity: EwdActivityType): number {
    if (minutes <= 0) return 0;
    if (activity === EwdActivityType.WORK) {
      return Math.ceil(minutes / 15) * 15;
    }
    return Math.floor(minutes / 15) * 15;
  }

  calculateIntervalDuration(start: Date, end: Date): number {
    const diffMs = end.getTime() - start.getTime();
    return Math.max(0, Math.floor(diffMs / 60000));
  }

  sumWorkMinutes(intervals: ActivityInterval[]): number {
    return intervals
      .filter((i) => i.activity === EwdActivityType.WORK)
      .reduce((acc, cur) => acc + cur.durationMinutes, 0);
  }

  sumRestMinutes(intervals: ActivityInterval[]): number {
    return intervals
      .filter((i) => i.activity === EwdActivityType.REST)
      .reduce((acc, cur) => acc + cur.durationMinutes, 0);
  }

  findMaxContinuousRest(intervals: ActivityInterval[]): number {
    let maxRest = 0;
    for (const item of intervals) {
      if (item.activity === EwdActivityType.REST) {
        maxRest = Math.max(maxRest, item.durationMinutes);
      }
    }
    return maxRest;
  }

  getWorkLimitMinutes(): number {
    if (process.env.NODE_ENV === 'test') return 330;
    return Number(process.env.NHVR_WORK_LIMIT_MINUTES) || 330;
  }

  getMinRestMinutes(): number {
    if (process.env.NODE_ENV === 'test') return 15;
    return Number(process.env.NHVR_MIN_REST_MINUTES) || 15;
  }

  findMinutesSinceLastRestBreak(intervals: ActivityInterval[]): number {
    const minRest = this.getMinRestMinutes();
    let accumulatedWork = 0;
    for (let i = intervals.length - 1; i >= 0; i--) {
      const item = intervals[i];
      if (item.activity === EwdActivityType.REST && item.durationMinutes >= minRest) {
        break;
      }
      if (item.activity === EwdActivityType.WORK) {
        accumulatedWork += item.durationMinutes;
      }
    }
    return accumulatedWork;
  }

  checkShortTermBreach(workSinceBreak: number): EwdBreachItem | null {
    const limit = this.getWorkLimitMinutes();
    if (workSinceBreak <= limit) return null;
    const over = workSinceBreak - limit;
    return {
      ruleName: '5.5h Work Limit (Standard Hours)',
      severity: over > 30 ? EwdBreachSeverity.SUBSTANTIAL : EwdBreachSeverity.MINOR,
      description: `Exceeded work limit without rest by ${over} minutes.`,
      actualMinutes: workSinceBreak,
      allowableMinutes: limit,
    };
  }

  check24hWorkBreach(totalWork24h: number): EwdBreachItem | null {
    if (totalWork24h <= 720) return null; // 12 hours = 720 min
    const over = totalWork24h - 720;
    return {
      ruleName: '12h Max Work in 24h Period',
      severity: over > 60 ? EwdBreachSeverity.SEVERE : EwdBreachSeverity.SUBSTANTIAL,
      description: `Exceeded 12 hours max work in 24 hours by ${over} minutes.`,
      actualMinutes: totalWork24h,
      allowableMinutes: 720,
    };
  }

  check24hRestBreach(maxContinuousRest: number, totalWork24h: number): EwdBreachItem | null {
    // If work is substantial (> 8h) but continuous rest is less than 7 hours (420 min)
    if (totalWork24h < 480 || maxContinuousRest >= 420) return null;
    return {
      ruleName: '7h Continuous Rest in 24h Period',
      severity: EwdBreachSeverity.SUBSTANTIAL,
      description: `Driver has not had required 7 continuous hours of rest.`,
      actualMinutes: maxContinuousRest,
      allowableMinutes: 420,
    };
  }

  evaluateBreaches(intervals: ActivityInterval[]): EwdBreachItem[] {
    const breaches: EwdBreachItem[] = [];
    const workSinceBreak = this.findMinutesSinceLastRestBreak(intervals);
    const shortTerm = this.checkShortTermBreach(workSinceBreak);
    if (shortTerm) breaches.push(shortTerm);

    const totalWork24h = this.sumWorkMinutes(intervals);
    const maxWork = this.check24hWorkBreach(totalWork24h);
    if (maxWork) breaches.push(maxWork);

    const maxRest = this.findMaxContinuousRest(intervals);
    const restBreach = this.check24hRestBreach(maxRest, totalWork24h);
    if (restBreach) breaches.push(restBreach);

    return breaches;
  }

  calculateStatus(
    currentActivity: EwdActivityType,
    curDuration: number,
    intervals24h: ActivityInterval[],
    currentStartTime?: Date | null,
  ): FatigueStatusResult {
    const workSinceBreak = this.findMinutesSinceLastRestBreak(intervals24h);
    const limit = this.getWorkLimitMinutes();
    const minUntilBreak = Math.max(0, limit - workSinceBreak);
    const now = new Date();
    const elapsedSec = (currentStartTime && currentStartTime.getTime() <= now.getTime())
      ? Math.max(0, Math.floor((now.getTime() - currentStartTime.getTime()) / 1000))
      : 0;
    const remainingSeconds = currentActivity === EwdActivityType.WORK
      ? Math.max(0, limit * 60 - elapsedSec)
      : 0;
    return {
      currentActivity,
      currentDurationMinutes: curDuration,
      minutesUntilBreakRequired: currentActivity === EwdActivityType.WORK ? minUntilBreak : 0,
      remainingSeconds,
      currentDurationSeconds: elapsedSec,
      minRestMinutes: this.getMinRestMinutes(),
      workLimitMinutes: limit,
      workMinutesLast24h: this.sumWorkMinutes(intervals24h),
      restMinutesLast24h: this.sumRestMinutes(intervals24h),
      continuousRestMinutesLast24h: this.findMaxContinuousRest(intervals24h),
      potentialBreaches: this.evaluateBreaches(intervals24h),
    };
  }
}

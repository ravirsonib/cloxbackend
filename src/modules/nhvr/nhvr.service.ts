import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DailySheetStatus, EwdActivityType, TripStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { localDateIso, PLATFORM_TIMEZONE, utcDateFromLocalDateIso } from '../../shared/timezone';
import { ActivityInterval, NhvrCalculatorService } from './nhvr-calculator.service';
import { NhvrRoadsideService } from './nhvr-roadside.service';
import {
  EwdBreachItem,
  FatigueStatusResult,
  ManualRecordInput,
  SCHEDULE_A_STATUTORY_DECLARATION,
  SignDailySheetInput,
  SwitchActivityInput,
} from './nhvr.types';

const ACTIVE_TRIP_STATUSES: TripStatus[] = [
  TripStatus.EN_ROUTE_PICKUP,
  TripStatus.IN_TRANSIT,
];

@Injectable()
export class NhvrService {
  private readonly logger = new Logger(NhvrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: NhvrCalculatorService,
    private readonly roadside: NhvrRoadsideService,
  ) {}

  async getDriverByUserId(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      include: { user: true },
    });
    if (!driver) throw new NotFoundException('Driver profile not found');
    return driver;
  }

  private driverTimezone(driver: { baseTimezone?: string | null }): string {
    return driver.baseTimezone?.trim() || PLATFORM_TIMEZONE;
  }

  async getCurrentRecord(driverId: string) {
    return this.prisma.ewdWorkRestRecord.findFirst({
      where: { driverId, endTime: null },
      orderBy: { startTime: 'desc' },
    });
  }

  async getIntervalsLast24h(driverId: string): Promise<ActivityInterval[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const records = await this.prisma.ewdWorkRestRecord.findMany({
      where: { driverId, startTime: { gte: since } },
      orderBy: { startTime: 'asc' },
    });
    const now = new Date();
    return records.map((r) => {
      const end = r.endTime ?? now;
      const duration = this.calculator.calculateIntervalDuration(r.startTime, end);
      return { activity: r.activity, startTime: r.startTime, endTime: end, durationMinutes: duration };
    });
  }

  private async findActiveTrip(driverId: string) {
    return this.prisma.trip.findFirst({
      where: {
        assignment: { driverId },
        status: { in: ACTIVE_TRIP_STATUSES },
        completedAt: null,
      },
      include: { assignment: { include: { vehicle: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async ensureActiveTripRecord(driverId: string) {
    const trip = await this.findActiveTrip(driverId);
    if (!trip) return null;
    return this.prisma.ewdWorkRestRecord.create({
      data: {
        driverId,
        activity: EwdActivityType.WORK,
        workType: 'DRIVING',
        startTime: new Date(),
        odometerStart: trip.odometerStartKm ? Math.round(Number(trip.odometerStartKm)) : undefined,
        vehicleRego: trip.assignment?.vehicle?.registration || undefined,
      },
    });
  }

  async getStatus(userId: string): Promise<FatigueStatusResult> {
    const driver = await this.getDriverByUserId(userId);
    let current = await this.getCurrentRecord(driver.id);
    if (!current) current = await this.ensureActiveTripRecord(driver.id);
    const intervals = await this.getIntervalsLast24h(driver.id);
    const now = new Date();
    const currentDuration = current
      ? this.calculator.calculateIntervalDuration(current.startTime, now)
      : 0;
    const currentActivity = current ? current.activity : EwdActivityType.REST;
    const currentStartTime = current ? current.startTime : null;
    return this.calculator.calculateStatus(currentActivity, currentDuration, intervals, currentStartTime);
  }

  async closeActiveRecord(driverId: string, now: Date, input: SwitchActivityInput) {
    const current = await this.getCurrentRecord(driverId);
    if (!current) return;
    const raw = this.calculator.calculateIntervalDuration(current.startTime, now);
    const duration = this.calculator.roundMinutes(raw, current.activity);
    await this.prisma.ewdWorkRestRecord.update({
      where: { id: current.id },
      data: {
        endTime: now,
        durationMinutes: duration,
        odometerEnd: input.odometer,
        locationEnd: input.location,
        latEnd: input.latitude,
        lngEnd: input.longitude,
      },
    });
  }

  async persistBreaches(driverId: string, breaches: EwdBreachItem[]) {
    for (const b of breaches) {
      const existing = await this.prisma.ewdBreachRecord.findFirst({
        where: {
          driverId,
          ruleName: b.ruleName,
          resolved: false,
        },
        orderBy: { detectedAt: 'desc' },
      });
      if (existing) {
        await this.prisma.ewdBreachRecord.update({
          where: { id: existing.id },
          data: {
            severity: b.severity,
            description: b.description,
            actualMinutes: b.actualMinutes,
            allowableMinutes: b.allowableMinutes,
            detectedAt: new Date(),
          },
        });
        continue;
      }
      await this.prisma.ewdBreachRecord.create({
        data: {
          driverId,
          ruleName: b.ruleName,
          severity: b.severity,
          description: b.description,
          actualMinutes: b.actualMinutes,
          allowableMinutes: b.allowableMinutes,
        },
      });
    }
  }

  private async insertNewRecord(driverId: string, now: Date, input: SwitchActivityInput) {
    return this.prisma.ewdWorkRestRecord.create({
      data: {
        driverId,
        activity: input.activity,
        workType: input.workType || 'DRIVING',
        startTime: now,
        odometerStart: input.odometer,
        locationStart: input.location,
        latStart: input.latitude,
        lngStart: input.longitude,
        vehicleRego: input.vehicleRego,
      },
    });
  }

  private async recomputeSheetTotals(
    driverId: string,
    timeZone: string,
    at: Date = new Date(),
  ) {
    const dateIso = localDateIso(at, timeZone);
    const date = utcDateFromLocalDateIso(dateIso);
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const records = await this.prisma.ewdWorkRestRecord.findMany({
      where: { driverId, startTime: { gte: since } },
      orderBy: { startTime: 'asc' },
    });
    const now = new Date();
    let totalWorkMinutes = 0;
    let totalRestMinutes = 0;
    for (const r of records) {
      if (localDateIso(r.startTime, timeZone) !== dateIso) continue;
      const end = r.endTime ?? now;
      const raw = r.durationMinutes ?? this.calculator.calculateIntervalDuration(r.startTime, end);
      const mins = this.calculator.roundMinutes(raw, r.activity);
      if (r.activity === EwdActivityType.WORK) totalWorkMinutes += mins;
      else totalRestMinutes += mins;
    }
    await this.prisma.ewdDailySheet.upsert({
      where: { driverId_date: { driverId, date } },
      create: {
        driverId,
        date,
        timezone: timeZone,
        totalWorkMinutes,
        totalRestMinutes,
      },
      update: { totalWorkMinutes, totalRestMinutes, timezone: timeZone },
    });
  }

  async switchActivity(userId: string, input: SwitchActivityInput) {
    const driver = await this.getDriverByUserId(userId);
    const now = new Date();
    await this.closeActiveRecord(driver.id, now, input);
    const record = await this.insertNewRecord(driver.id, now, input);
    const intervals = await this.getIntervalsLast24h(driver.id);
    const breaches = this.calculator.evaluateBreaches(intervals);
    if (breaches.length > 0) await this.persistBreaches(driver.id, breaches);
    await this.recomputeSheetTotals(driver.id, this.driverTimezone(driver), now);
    return { record, breaches };
  }

  /**
   * Trip break choke-point: onBreak → REST, resume → WORK/DRIVING.
   * No-ops when the open interval already matches the desired activity.
   */
  async syncFromTripBreak(
    userId: string,
    onBreak: boolean,
    opts?: { vehicleRego?: string; odometer?: number },
  ) {
    const driver = await this.getDriverByUserId(userId);
    const desired = onBreak ? EwdActivityType.REST : EwdActivityType.WORK;
    const current = await this.getCurrentRecord(driver.id);
    if (current?.activity === desired) {
      return { record: current, breaches: [] as EwdBreachItem[], skipped: true };
    }
    try {
      return {
        ...(await this.switchActivity(userId, {
          activity: desired,
          workType: desired === EwdActivityType.WORK ? 'DRIVING' : undefined,
          vehicleRego: opts?.vehicleRego,
          odometer: opts?.odometer,
        })),
        skipped: false,
      };
    } catch (err) {
      this.logger.warn(
        `EWD syncFromTripBreak failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async createManualRecord(userId: string, input: ManualRecordInput) {
    const driver = await this.getDriverByUserId(userId);
    const start = new Date(input.startTime);
    const end = new Date(input.endTime);
    if (end <= start) throw new BadRequestException('End time must be after start time');
    const raw = this.calculator.calculateIntervalDuration(start, end);
    const duration = this.calculator.roundMinutes(raw, input.activity);
    const record = await this.insertManualRecord(driver.id, start, end, duration, input);
    await this.recomputeSheetTotals(driver.id, this.driverTimezone(driver), start);
    return record;
  }

  private insertManualRecord(
    driverId: string,
    start: Date,
    end: Date,
    duration: number,
    inDto: ManualRecordInput,
  ) {
    return this.prisma.ewdWorkRestRecord.create({
      data: {
        driverId,
        activity: inDto.activity,
        workType: inDto.workType || 'DRIVING',
        startTime: start,
        endTime: end,
        durationMinutes: duration,
        locationStart: inDto.locationStart,
        locationEnd: inDto.locationEnd,
        vehicleRego: inDto.vehicleRego,
        isEdited: true,
        editReason: inDto.editReason,
      },
    });
  }

  async getRecords(userId: string, days = 7) {
    const driver = await this.getDriverByUserId(userId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.prisma.ewdWorkRestRecord.findMany({
      where: { driverId: driver.id, startTime: { gte: since } },
      orderBy: { startTime: 'desc' },
    });
  }

  async getTodaySheet(userId: string) {
    const driver = await this.getDriverByUserId(userId);
    const tz = this.driverTimezone(driver);
    const dateIso = localDateIso(new Date(), tz);
    const date = utcDateFromLocalDateIso(dateIso);
    await this.recomputeSheetTotals(driver.id, tz);
    const existing = await this.prisma.ewdDailySheet.findUnique({
      where: { driverId_date: { driverId: driver.id, date } },
    });
    if (existing) return existing;
    return this.prisma.ewdDailySheet.create({
      data: { driverId: driver.id, date, timezone: tz },
    });
  }

  async signDailySheet(userId: string, input: SignDailySheetInput) {
    const driver = await this.getDriverByUserId(userId);
    const tz = this.driverTimezone(driver);
    const targetDate = utcDateFromLocalDateIso(input.date);
    await this.recomputeSheetTotals(
      driver.id,
      tz,
      // Use noon UTC on that calendar date so local-date recompute targets the signed day.
      new Date(`${input.date}T12:00:00.000Z`),
    );
    return this.upsertDailySheetSignature(
      driver.id,
      targetDate,
      input.signature,
      SCHEDULE_A_STATUTORY_DECLARATION,
      tz,
    );
  }

  private upsertDailySheetSignature(
    driverId: string,
    date: Date,
    sig: string,
    decl: string,
    timezone: string,
  ) {
    return this.prisma.ewdDailySheet.upsert({
      where: { driverId_date: { driverId, date } },
      create: {
        driverId,
        date,
        timezone,
        status: DailySheetStatus.SUBMITTED,
        driverSignature: sig,
        signedAt: new Date(),
        declarationText: decl,
      },
      update: {
        status: DailySheetStatus.SUBMITTED,
        driverSignature: sig,
        signedAt: new Date(),
        declarationText: decl,
      },
    });
  }

  async generateRoadsidePin(userId: string) {
    const driver = await this.getDriverByUserId(userId);
    return this.roadside.createRoadsideSession(driver.id);
  }
}

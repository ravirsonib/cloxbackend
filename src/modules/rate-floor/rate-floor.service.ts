import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, RateFloorCheckResult, RateFloorVersionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { calculateRateFloor, exGstToIncGstCents } from './rate-floor.calc';
import {
  DEFAULT_BODY_LOADINGS,
  DEFAULT_LABOUR_MULTIPLIERS,
  DEFAULT_RATE_FLOOR_LINES,
  DEFAULT_RATE_FLOOR_VERSION_LABEL,
  DEFAULT_RATE_FLOOR_VERSION_PARAMS,
  inferBodyCode,
} from './rate-floor.defaults';
import {
  ageDaysFromWeekStart,
  applyWeeklyDieselCap,
  formatWeekStartIso,
  mondayOfWeek,
  percentChange,
} from './rate-floor.fuel';
import {
  localDateIso,
  resolveLabourPeriod,
  timezoneForPickupState,
  type LabourPeriodCode,
} from './rate-floor.labour';

export type RateFloorCalculateInput = {
  vehicleClassCode: string;
  pricingModel: 'PER_KM' | 'HOURLY';
  distanceKm?: number | null;
  billableHours?: number | null;
  /** Pickup / start time for labour period (Wave 2.2). */
  at?: Date | null;
  /** Pickup state for timezone (VIC|NSW|…). */
  pickupState?: string | null;
  /** Wave 2.3 — specialised body (DRY default; inferred from reefer/DG flags when omitted). */
  bodyCode?: string | null;
  requiresReefer?: boolean | null;
  requiresDg?: boolean | null;
  /** Wave 2.4 — return-leg discount on PER_KM. */
  backhaul?: boolean | null;
  /** Wave 2.6 — when set, active RateFloorOverride may replace calculated floor. */
  jobId?: string | null;
};

export type RateFloorCalculateResult = {
  versionId: string;
  versionLabel: string;
  floorExGstCents: number;
  floorIncGstCents: number;
  breakdown: Record<string, unknown>;
};

export type RateFloorCheckRecordInput = {
  jobId?: string | null;
  actorUserId?: string | null;
  actorAdminId?: string | null;
  versionId: string;
  fuelIndexId?: string | null;
  inputs: Record<string, unknown>;
  breakdown: Record<string, unknown>;
  floorExGstCents: number;
  floorIncGstCents: number;
  offeredIncGstCents?: number | null;
  result: RateFloorCheckResult;
};

export type FuelIndexCreateInput = {
  weekStart?: string;
  dieselCpl: number;
  note?: string;
  /** Required when week-over-week move exceeds platform confirm threshold. */
  confirm?: boolean;
};

const DEFAULT_FUEL_KNOBS = {
  fuelStaleDays: 10,
  fuelMoveConfirmPercent: 8,
  fuelWeeklyChangeCapPercent: 15,
} as const;

@Injectable()
export class RateFloorService {
  constructor(private readonly prisma: PrismaService) {}

  async ensurePublishedSeed(createdByAdminId?: string | null): Promise<void> {
    const published = await this.prisma.rateFloorVersion.findFirst({
      where: { status: RateFloorVersionStatus.PUBLISHED },
      select: { id: true },
    });
    if (published) return;

    await this.prisma.rateFloorVersion.create({
      data: {
        label: DEFAULT_RATE_FLOOR_VERSION_LABEL,
        status: RateFloorVersionStatus.PUBLISHED,
        effectiveFrom: new Date(),
        ...DEFAULT_RATE_FLOOR_VERSION_PARAMS,
        createdByAdminId: createdByAdminId ?? null,
        publishedByAdminId: createdByAdminId ?? null,
        lines: {
          create: DEFAULT_RATE_FLOOR_LINES.map((l) => ({
            vehicleClassCode: l.vehicleClassCode,
            hourlyFloorCents: l.hourlyFloorCents,
            kmFloorCents: l.kmFloorCents,
            variableKmCents: l.variableKmCents,
            litresPerKm: l.litresPerKm,
            basis: l.basis,
          })),
        },
        labourMultipliers: {
          create: DEFAULT_LABOUR_MULTIPLIERS.map((m) => ({
            periodCode: m.periodCode,
            multiplier: m.multiplier,
          })),
        },
        bodyLoadings: {
          create: DEFAULT_BODY_LOADINGS.map((b) => ({
            bodyCode: b.bodyCode,
            loadingPct: b.loadingPct,
            minHours: b.minHours,
          })),
        },
      },
    });
  }

  /** Backfill §5.1 multipliers (incl. PUBLIC_HOLIDAY stub) on older versions. */
  private async ensureLabourMultipliers(versionId: string): Promise<void> {
    await this.prisma.rateFloorLabourMultiplier.createMany({
      data: DEFAULT_LABOUR_MULTIPLIERS.map((m) => ({
        versionId,
        periodCode: m.periodCode,
        multiplier: m.multiplier,
      })),
      skipDuplicates: true,
    });
  }

  /** Backfill §4.4 body loadings on versions created before W2.3. */
  private async ensureBodyLoadings(versionId: string): Promise<void> {
    const count = await this.prisma.rateFloorBodyLoading.count({
      where: { versionId },
    });
    if (count > 0) return;
    await this.prisma.rateFloorBodyLoading.createMany({
      data: DEFAULT_BODY_LOADINGS.map((b) => ({
        versionId,
        bodyCode: b.bodyCode,
        loadingPct: b.loadingPct,
        minHours: b.minHours,
      })),
      skipDuplicates: true,
    });
  }

  async ensureFuelIndexSeed(): Promise<void> {
    const any = await this.prisma.fuelIndex.findFirst({ select: { id: true } });
    if (any) return;
    await this.prisma.fuelIndex.create({
      data: {
        weekStart: mondayOfWeek(),
        dieselCpl: DEFAULT_RATE_FLOOR_VERSION_PARAMS.referenceDieselCpl,
        note: 'Seed: July 2026 national average retail reference',
      },
    });
  }

  private versionInclude() {
    return {
      lines: true as const,
      labourMultipliers: true as const,
      bodyLoadings: true as const,
    };
  }

  async getPublishedVersion() {
    await this.ensurePublishedSeed();
    let version = await this.prisma.rateFloorVersion.findFirst({
      where: { status: RateFloorVersionStatus.PUBLISHED },
      include: this.versionInclude(),
      orderBy: { updatedAt: 'desc' },
    });
    if (!version) {
      throw new ServiceUnavailableException({
        message: 'No published rate floor version',
        code: 'RATE_FLOOR_VERSION_MISSING',
      });
    }
    const labourCountBefore = version.labourMultipliers.length;
    await this.ensureLabourMultipliers(version.id);
    let needsReload =
      labourCountBefore < DEFAULT_LABOUR_MULTIPLIERS.length ||
      version.bodyLoadings.length === 0;
    if (version.bodyLoadings.length === 0) {
      await this.ensureBodyLoadings(version.id);
    }
    if (needsReload) {
      version = await this.prisma.rateFloorVersion.findFirstOrThrow({
        where: { id: version.id },
        include: this.versionInclude(),
      });
    }
    return version;
  }

  private async getFuelKnobs() {
    const settings = await this.prisma.platformSettings.findUnique({
      where: { id: 'default' },
      select: {
        gstPercent: true,
        fuelStaleDays: true,
        fuelMoveConfirmPercent: true,
        fuelWeeklyChangeCapPercent: true,
      },
    });
    return {
      gstPercent: settings?.gstPercent ?? 10,
      fuelStaleDays: settings?.fuelStaleDays ?? DEFAULT_FUEL_KNOBS.fuelStaleDays,
      fuelMoveConfirmPercent:
        settings?.fuelMoveConfirmPercent ?? DEFAULT_FUEL_KNOBS.fuelMoveConfirmPercent,
      fuelWeeklyChangeCapPercent:
        settings?.fuelWeeklyChangeCapPercent ?? DEFAULT_FUEL_KNOBS.fuelWeeklyChangeCapPercent,
    };
  }

  async getFuelStatus() {
    await this.ensureFuelIndexSeed();
    const knobs = await this.getFuelKnobs();
    const latest = await this.prisma.fuelIndex.findFirst({
      orderBy: { weekStart: 'desc' },
    });
    if (!latest) {
      return {
        latest: null,
        ageDays: null,
        isStale: true,
        fuelStaleDays: knobs.fuelStaleDays,
        fuelMoveConfirmPercent: knobs.fuelMoveConfirmPercent,
        fuelWeeklyChangeCapPercent: knobs.fuelWeeklyChangeCapPercent,
      };
    }
    const ageDays = ageDaysFromWeekStart(new Date(latest.weekStart));
    return {
      latest: {
        id: latest.id,
        weekStart: formatWeekStartIso(new Date(latest.weekStart)),
        dieselCpl: latest.dieselCpl,
        note: latest.note,
        createdAt: latest.createdAt,
      },
      ageDays,
      isStale: ageDays > knobs.fuelStaleDays,
      fuelStaleDays: knobs.fuelStaleDays,
      fuelMoveConfirmPercent: knobs.fuelMoveConfirmPercent,
      fuelWeeklyChangeCapPercent: knobs.fuelWeeklyChangeCapPercent,
    };
  }

  async listFuelIndexes(limit = 26) {
    await this.ensureFuelIndexSeed();
    const rows = await this.prisma.fuelIndex.findMany({
      orderBy: { weekStart: 'desc' },
      take: Math.min(Math.max(limit, 1), 104),
    });
    return rows.map((r) => ({
      id: r.id,
      weekStart: formatWeekStartIso(new Date(r.weekStart)),
      dieselCpl: r.dieselCpl,
      note: r.note,
      enteredByAdminId: r.enteredByAdminId,
      confirmedByAdminId: r.confirmedByAdminId,
      createdAt: r.createdAt,
    }));
  }

  async createFuelIndex(actorAdminId: string, input: FuelIndexCreateInput) {
    if (!Number.isFinite(input.dieselCpl) || input.dieselCpl < 50 || input.dieselCpl > 500) {
      throw new BadRequestException({
        message: 'dieselCpl must be between 50 and 500 c/L',
        code: 'FUEL_DIESEL_OUT_OF_RANGE',
      });
    }

    const weekStart = input.weekStart
      ? mondayOfWeek(new Date(`${input.weekStart}T00:00:00.000Z`))
      : mondayOfWeek();

    const knobs = await this.getFuelKnobs();
    const previous = await this.prisma.fuelIndex.findFirst({
      where: { weekStart: { lt: weekStart } },
      orderBy: { weekStart: 'desc' },
    });

    const movePercent =
      previous != null ? percentChange(previous.dieselCpl, input.dieselCpl) : 0;
    const needsConfirm = movePercent > knobs.fuelMoveConfirmPercent + 1e-9;
    if (needsConfirm && !input.confirm) {
      throw new BadRequestException({
        message: `Diesel moved ${movePercent.toFixed(1)}% vs prior week — confirm required`,
        code: 'FUEL_MOVE_CONFIRM_REQUIRED',
        movePercent,
        previousDieselCpl: previous?.dieselCpl ?? null,
        dieselCpl: input.dieselCpl,
        confirmThresholdPercent: knobs.fuelMoveConfirmPercent,
      });
    }

    try {
      const created = await this.prisma.fuelIndex.create({
        data: {
          weekStart,
          dieselCpl: input.dieselCpl,
          note: input.note?.trim() || null,
          enteredByAdminId: actorAdminId,
          confirmedByAdminId: needsConfirm ? actorAdminId : null,
        },
      });
      return {
        id: created.id,
        weekStart: formatWeekStartIso(new Date(created.weekStart)),
        dieselCpl: created.dieselCpl,
        note: created.note,
        enteredByAdminId: created.enteredByAdminId,
        confirmedByAdminId: created.confirmedByAdminId,
        createdAt: created.createdAt,
        movePercent,
        confirmed: needsConfirm,
      };
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      if (code === 'P2002') {
        throw new BadRequestException({
          message: 'Fuel index already exists for that week',
          code: 'FUEL_WEEK_EXISTS',
          weekStart: formatWeekStartIso(weekStart),
        });
      }
      throw err;
    }
  }

  private async isPublicHoliday(at: Date, pickupState?: string | null): Promise<{
    isHoliday: boolean;
    holidayName: string | null;
  }> {
    const tz = timezoneForPickupState(pickupState);
    const dateIso = localDateIso(at, tz);
    const holidayDate = new Date(`${dateIso}T00:00:00.000Z`);
    const state = pickupState?.trim().toUpperCase() || null;
    const row = await this.prisma.publicHoliday.findFirst({
      where: {
        holidayDate,
        OR: [
          { state: 'NATIONAL' },
          ...(state ? [{ state }] : []),
        ],
      },
      select: { name: true },
    });
    return { isHoliday: Boolean(row), holidayName: row?.name ?? null };
  }

  private async resolveLabourForCalc(
    version: {
      labourRateHrCents: number;
      labourMultipliers: Array<{ periodCode: string; multiplier: number }>;
    },
    at?: Date | null,
    pickupState?: string | null,
  ) {
    if (!at || !(at instanceof Date) || Number.isNaN(at.getTime())) {
      return null;
    }
    const tz = timezoneForPickupState(pickupState);
    const holiday = await this.isPublicHoliday(at, pickupState);
    const periodCode = resolveLabourPeriod(at, tz, holiday.isHoliday);
    const row =
      version.labourMultipliers.find((m) => m.periodCode === periodCode) ??
      DEFAULT_LABOUR_MULTIPLIERS.find((m) => m.periodCode === periodCode);
    const multiplier = row?.multiplier ?? 1;
    return {
      periodCode: periodCode as LabourPeriodCode,
      multiplier,
      labourRateHrCents: version.labourRateHrCents,
      timeZone: tz,
      holidayName: holiday.holidayName,
      awardHolidayStub: periodCode === 'PUBLIC_HOLIDAY',
    };
  }

  private async resolveFuelForCalc(referenceDieselCpl: number, litresPerKm: number) {
    await this.ensureFuelIndexSeed();
    const knobs = await this.getFuelKnobs();
    const latest = await this.prisma.fuelIndex.findFirst({
      orderBy: { weekStart: 'desc' },
    });
    if (!latest) {
      return {
        dieselCpl: referenceDieselCpl,
        referenceDieselCpl,
        litresPerKm,
        isStale: true,
        weeklyMoveCapped: false,
        fuelIndexId: null as string | null,
        weekStart: null as string | null,
      };
    }

    const previous = await this.prisma.fuelIndex.findFirst({
      where: { weekStart: { lt: latest.weekStart } },
      orderBy: { weekStart: 'desc' },
    });
    const capped = applyWeeklyDieselCap(
      previous?.dieselCpl,
      latest.dieselCpl,
      knobs.fuelWeeklyChangeCapPercent,
    );
    const ageDays = ageDaysFromWeekStart(new Date(latest.weekStart));
    return {
      dieselCpl: capped.appliedDieselCpl,
      referenceDieselCpl,
      litresPerKm,
      isStale: ageDays > knobs.fuelStaleDays,
      weeklyMoveCapped: capped.weeklyMoveCapped,
      fuelIndexId: latest.id,
      weekStart: formatWeekStartIso(new Date(latest.weekStart)),
      uncappedDieselCpl: latest.dieselCpl,
      uncappedMovePercent: capped.uncappedMovePercent,
    };
  }

  async calculate(input: RateFloorCalculateInput): Promise<RateFloorCalculateResult> {
    const code = input.vehicleClassCode?.trim().toUpperCase();
    if (!code) {
      throw new BadRequestException({
        message: 'vehicleClassCode is required for rate floor',
        code: 'RATE_FLOOR_CLASS_REQUIRED',
      });
    }

    const version = await this.getPublishedVersion();
    const line = version.lines.find((l) => l.vehicleClassCode.toUpperCase() === code);
    if (!line) {
      throw new BadRequestException({
        message: `No hard floor configured for vehicle class ${code}`,
        code: 'RATE_FLOOR_CLASS_MISSING',
        vehicleClassCode: code,
        versionId: version.id,
      });
    }

    const knobs = await this.getFuelKnobs();
    const fuel =
      input.pricingModel === 'PER_KM'
        ? await this.resolveFuelForCalc(version.referenceDieselCpl, line.litresPerKm)
        : null;
    const labour = await this.resolveLabourForCalc(version, input.at, input.pickupState);

    const resolvedBodyCode = inferBodyCode({
      bodyCode: input.bodyCode,
      vehicleClassCode: code,
      requiresReefer: input.requiresReefer,
      requiresDg: input.requiresDg,
    });
    const bodyRow =
      version.bodyLoadings.find((b) => b.bodyCode === resolvedBodyCode) ??
      DEFAULT_BODY_LOADINGS.find((b) => b.bodyCode === resolvedBodyCode);
    const body =
      bodyRow && (bodyRow.loadingPct > 0 || (bodyRow.minHours != null && bodyRow.minHours > 0))
        ? {
            bodyCode: resolvedBodyCode,
            loadingPct: bodyRow.loadingPct,
            minHours: bodyRow.minHours,
          }
        : { bodyCode: resolvedBodyCode, loadingPct: 0, minHours: bodyRow?.minHours ?? null };

    const calc = calculateRateFloor({
      pricingModel: input.pricingModel,
      distanceKm: input.distanceKm,
      billableHours: input.billableHours,
      line: {
        vehicleClassCode: line.vehicleClassCode,
        hourlyFloorCents: line.hourlyFloorCents,
        kmFloorCents: line.kmFloorCents,
        litresPerKm: line.litresPerKm,
        variableKmCents: line.variableKmCents,
      },
      version: {
        minHours: version.minHours,
        minKmChargeKm: version.minKmChargeKm,
        referenceDieselCpl: version.referenceDieselCpl,
        labourRateHrCents: version.labourRateHrCents,
        backhaulFactor: version.backhaulFactor,
      },
      gstPercent: knobs.gstPercent,
      fuel,
      labour,
      body,
      backhaul: Boolean(input.backhaul),
    });

    const modifiersApplied = Array.isArray(calc.breakdown.modifiersApplied)
      ? [...(calc.breakdown.modifiersApplied as string[])]
      : [];
    if (fuel?.isStale) modifiersApplied.push('FUEL_STALE');
    if (fuel?.weeklyMoveCapped) modifiersApplied.push('FUEL_WEEKLY_CAP');

    let floorExGstCents = calc.floorExGstCents;
    let floorIncGstCents = calc.floorIncGstCents;
    let overrideMeta: Record<string, unknown> | null = null;

    if (input.jobId) {
      const override = await this.findActiveOverride(input.jobId);
      if (override) {
        floorExGstCents = override.floorExGstCentsOverride;
        floorIncGstCents = exGstToIncGstCents(floorExGstCents, knobs.gstPercent);
        modifiersApplied.push('OVERRIDE');
        overrideMeta = {
          overrideId: override.id,
          overrideReason: override.reason,
          overrideExpiresAt: override.expiresAt.toISOString(),
          calculatedFloorExGstCents: calc.floorExGstCents,
        };
      }
    }

    return {
      versionId: version.id,
      versionLabel: version.label,
      floorExGstCents,
      floorIncGstCents,
      breakdown: {
        ...calc.breakdown,
        versionId: version.id,
        versionLabel: version.label,
        gstPercent: knobs.gstPercent,
        labourTimeZone: labour?.timeZone ?? null,
        holidayName: labour?.holidayName ?? null,
        awardHolidayStub: labour?.awardHolidayStub ?? false,
        ...overrideMeta,
        modifiersApplied: [...new Set(modifiersApplied)],
      },
    };
  }

  async findActiveOverride(jobId: string) {
    return this.prisma.rateFloorOverride.findFirst({
      where: { jobId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listVersions() {
    return this.prisma.rateFloorVersion.findMany({
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: {
        lines: { orderBy: { vehicleClassCode: 'asc' } },
        _count: { select: { lines: true } },
      },
    });
  }

  async getVersion(id: string) {
    let version = await this.prisma.rateFloorVersion.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { vehicleClassCode: 'asc' } },
        labourMultipliers: { orderBy: { periodCode: 'asc' } },
        bodyLoadings: { orderBy: { bodyCode: 'asc' } },
      },
    });
    if (!version) throw new NotFoundException('Rate floor version not found');
    const labourCountBefore = version.labourMultipliers.length;
    await this.ensureLabourMultipliers(version.id);
    let needsReload =
      labourCountBefore < DEFAULT_LABOUR_MULTIPLIERS.length ||
      version.bodyLoadings.length === 0;
    if (version.bodyLoadings.length === 0) {
      await this.ensureBodyLoadings(version.id);
    }
    if (needsReload) {
      version = await this.prisma.rateFloorVersion.findUniqueOrThrow({
        where: { id },
        include: {
          lines: { orderBy: { vehicleClassCode: 'asc' } },
          labourMultipliers: { orderBy: { periodCode: 'asc' } },
          bodyLoadings: { orderBy: { bodyCode: 'asc' } },
        },
      });
    }
    return version;
  }

  async createDraftFromPublished(actorAdminId: string, label?: string) {
    const published = await this.getPublishedVersion();
    return this.prisma.rateFloorVersion.create({
      data: {
        label: label?.trim() || `${published.label} (draft)`,
        status: RateFloorVersionStatus.DRAFT,
        referenceDieselCpl: published.referenceDieselCpl,
        labourRateHrCents: published.labourRateHrCents,
        minHours: published.minHours,
        minKmChargeKm: published.minKmChargeKm,
        backhaulFactor: published.backhaulFactor,
        createdByAdminId: actorAdminId,
        lines: {
          create: published.lines.map((l) => ({
            vehicleClassCode: l.vehicleClassCode,
            hourlyFloorCents: l.hourlyFloorCents,
            kmFloorCents: l.kmFloorCents,
            variableKmCents: l.variableKmCents,
            litresPerKm: l.litresPerKm,
            basis: l.basis,
          })),
        },
        labourMultipliers: {
          create: (published.labourMultipliers.length
            ? published.labourMultipliers
            : DEFAULT_LABOUR_MULTIPLIERS
          ).map((m) => ({
            periodCode: m.periodCode,
            multiplier: m.multiplier,
          })),
        },
        bodyLoadings: {
          create: (published.bodyLoadings.length
            ? published.bodyLoadings
            : DEFAULT_BODY_LOADINGS
          ).map((b) => ({
            bodyCode: b.bodyCode,
            loadingPct: b.loadingPct,
            minHours: b.minHours,
          })),
        },
      },
      include: { lines: true, labourMultipliers: true, bodyLoadings: true },
    });
  }

  async updateDraftLine(
    versionId: string,
    vehicleClassCode: string,
    patch: {
      hourlyFloorCents?: number;
      kmFloorCents?: number;
      variableKmCents?: number;
      litresPerKm?: number;
      basis?: string;
    },
  ) {
    const version = await this.getVersion(versionId);
    if (version.status !== RateFloorVersionStatus.DRAFT) {
      throw new BadRequestException({
        message: 'Only DRAFT floor versions can be edited',
        code: 'RATE_FLOOR_NOT_DRAFT',
      });
    }
    if (version.approvalSubmittedAt) {
      throw new BadRequestException({
        message: 'Withdraw approval before editing this draft',
        code: 'RATE_FLOOR_PENDING_APPROVAL',
      });
    }
    const code = vehicleClassCode.trim().toUpperCase();
    const line = version.lines.find((l) => l.vehicleClassCode === code);
    if (!line) {
      throw new NotFoundException(`Floor line ${code} not found on version`);
    }
    return this.prisma.rateFloorLine.update({
      where: { id: line.id },
      data: {
        ...(patch.hourlyFloorCents != null ? { hourlyFloorCents: patch.hourlyFloorCents } : {}),
        ...(patch.kmFloorCents != null ? { kmFloorCents: patch.kmFloorCents } : {}),
        ...(patch.variableKmCents != null ? { variableKmCents: patch.variableKmCents } : {}),
        ...(patch.litresPerKm != null ? { litresPerKm: patch.litresPerKm } : {}),
        ...(patch.basis != null ? { basis: patch.basis } : {}),
      },
    });
  }

  async recordCheck(input: RateFloorCheckRecordInput) {
    return this.prisma.rateFloorCheck.create({
      data: {
        jobId: input.jobId ?? null,
        actorUserId: input.actorUserId ?? null,
        actorAdminId: input.actorAdminId ?? null,
        versionId: input.versionId,
        fuelIndexId: input.fuelIndexId ?? null,
        inputs: input.inputs as Prisma.InputJsonValue,
        breakdown: input.breakdown as Prisma.InputJsonValue,
        floorExGstCents: input.floorExGstCents,
        floorIncGstCents: input.floorIncGstCents,
        offeredIncGstCents: input.offeredIncGstCents ?? null,
        result: input.result,
      },
    });
  }

  async listChecks(query: {
    jobId?: string;
    result?: RateFloorCheckResult;
    limit?: number;
  }) {
    const take = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.prisma.rateFloorCheck.findMany({
      where: {
        ...(query.jobId ? { jobId: query.jobId } : {}),
        ...(query.result ? { result: query.result } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Creator submits DRAFT for dual-approve (Wave 2.6). */
  async submitForApproval(versionId: string, actorAdminId: string) {
    const version = await this.getVersion(versionId);
    if (version.status !== RateFloorVersionStatus.DRAFT) {
      throw new BadRequestException({
        message: 'Only DRAFT floor versions can be submitted',
        code: 'RATE_FLOOR_NOT_DRAFT',
      });
    }
    if (version.lines.length === 0) {
      throw new BadRequestException({
        message: 'Cannot submit an empty floor version',
        code: 'RATE_FLOOR_EMPTY',
      });
    }
    if (version.createdByAdminId && version.createdByAdminId !== actorAdminId) {
      throw new BadRequestException({
        message: 'Only the draft creator can submit for approval',
        code: 'RATE_FLOOR_NOT_CREATOR',
      });
    }
    return this.prisma.rateFloorVersion.update({
      where: { id: versionId },
      data: {
        approvalSubmittedAt: new Date(),
        approvedByAdminId: null,
      },
      include: { lines: true, labourMultipliers: true, bodyLoadings: true },
    });
  }

  async withdrawApproval(versionId: string, actorAdminId: string) {
    const version = await this.getVersion(versionId);
    if (version.status !== RateFloorVersionStatus.DRAFT) {
      throw new BadRequestException({
        message: 'Only DRAFT floor versions can withdraw approval',
        code: 'RATE_FLOOR_NOT_DRAFT',
      });
    }
    if (!version.approvalSubmittedAt) {
      throw new BadRequestException({
        message: 'Draft is not pending approval',
        code: 'RATE_FLOOR_NOT_PENDING',
      });
    }
    if (
      version.createdByAdminId &&
      version.createdByAdminId !== actorAdminId
    ) {
      throw new BadRequestException({
        message: 'Only the draft creator can withdraw approval',
        code: 'RATE_FLOOR_NOT_CREATOR',
      });
    }
    return this.prisma.rateFloorVersion.update({
      where: { id: versionId },
      data: { approvalSubmittedAt: null, approvedByAdminId: null },
      include: { lines: true, labourMultipliers: true, bodyLoadings: true },
    });
  }

  /**
   * Dual-approve publish: second Super (≠ creator) publishes a submitted draft.
   */
  async publishDraft(versionId: string, actorAdminId: string) {
    const version = await this.getVersion(versionId);
    if (version.status !== RateFloorVersionStatus.DRAFT) {
      throw new BadRequestException({
        message: 'Only DRAFT floor versions can be published',
        code: 'RATE_FLOOR_NOT_DRAFT',
      });
    }
    if (version.lines.length === 0) {
      throw new BadRequestException({
        message: 'Cannot publish an empty floor version',
        code: 'RATE_FLOOR_EMPTY',
      });
    }
    if (!version.approvalSubmittedAt) {
      throw new BadRequestException({
        message: 'Submit draft for approval before publishing',
        code: 'RATE_FLOOR_NOT_SUBMITTED',
      });
    }
    if (version.createdByAdminId && version.createdByAdminId === actorAdminId) {
      throw new BadRequestException({
        message: 'Creator cannot self-approve / publish — a second Super Admin is required',
        code: 'RATE_FLOOR_DUAL_APPROVE_REQUIRED',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.rateFloorVersion.updateMany({
        where: { status: RateFloorVersionStatus.PUBLISHED },
        data: { status: RateFloorVersionStatus.RETIRED },
      });
      return tx.rateFloorVersion.update({
        where: { id: versionId },
        data: {
          status: RateFloorVersionStatus.PUBLISHED,
          effectiveFrom: new Date(),
          approvedByAdminId: actorAdminId,
          publishedByAdminId: actorAdminId,
        },
        include: { lines: true, labourMultipliers: true, bodyLoadings: true },
      });
    });
  }

  async createOverride(
    actorAdminId: string,
    input: {
      jobId: string;
      reason: string;
      expiresAt: string;
      floorExGstCentsOverride: number;
    },
  ) {
    const reason = input.reason?.trim();
    if (!reason || reason.length < 8) {
      throw new BadRequestException({
        message: 'Override reason must be at least 8 characters',
        code: 'RATE_FLOOR_OVERRIDE_REASON',
      });
    }
    if (
      !Number.isFinite(input.floorExGstCentsOverride) ||
      input.floorExGstCentsOverride < 0
    ) {
      throw new BadRequestException({
        message: 'floorExGstCentsOverride must be >= 0',
        code: 'RATE_FLOOR_OVERRIDE_FLOOR',
      });
    }
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        message: 'expiresAt must be a future datetime',
        code: 'RATE_FLOOR_OVERRIDE_EXPIRY',
      });
    }
    const job = await this.prisma.job.findUnique({
      where: { id: input.jobId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException('Job not found');

    const created = await this.prisma.rateFloorOverride.create({
      data: {
        jobId: input.jobId,
        approvedByAdminId: actorAdminId,
        reason,
        expiresAt,
        floorExGstCentsOverride: Math.floor(input.floorExGstCentsOverride),
      },
    });

    const published = await this.getPublishedVersion();
    await this.recordCheck({
      jobId: input.jobId,
      actorAdminId,
      versionId: published.id,
      inputs: {
        source: 'OVERRIDE_CREATE',
        reason,
        expiresAt: expiresAt.toISOString(),
        floorExGstCentsOverride: created.floorExGstCentsOverride,
      },
      breakdown: { overrideId: created.id },
      floorExGstCents: created.floorExGstCentsOverride,
      floorIncGstCents: exGstToIncGstCents(
        created.floorExGstCentsOverride,
        (await this.getFuelKnobs()).gstPercent,
      ),
      result: 'OVERRIDE',
    });

    return created;
  }

  async listOverrides(query: { jobId?: string; activeOnly?: boolean; limit?: number }) {
    const take = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const now = new Date();
    return this.prisma.rateFloorOverride.findMany({
      where: {
        ...(query.jobId ? { jobId: query.jobId } : {}),
        ...(query.activeOnly ? { expiresAt: { gt: now } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async listPublicHolidays(query?: { state?: string; fromYear?: number }) {
    const year = query?.fromYear ?? new Date().getUTCFullYear();
    const from = new Date(Date.UTC(year, 0, 1));
    return this.prisma.publicHoliday.findMany({
      where: {
        holidayDate: { gte: from },
        ...(query?.state ? { state: query.state.trim().toUpperCase() } : {}),
      },
      orderBy: [{ holidayDate: 'asc' }, { state: 'asc' }],
    });
  }

  async upsertPublicHoliday(input: {
    state: string;
    holidayDate: string;
    name: string;
  }) {
    const state = input.state.trim().toUpperCase();
    if (!/^(NATIONAL|[A-Z]{2,3})$/.test(state)) {
      throw new BadRequestException({
        message: 'state must be NATIONAL or an AU state code',
        code: 'HOLIDAY_STATE_INVALID',
      });
    }
    const name = input.name.trim();
    if (name.length < 2) {
      throw new BadRequestException({
        message: 'Holiday name required',
        code: 'HOLIDAY_NAME_REQUIRED',
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.holidayDate)) {
      throw new BadRequestException({
        message: 'holidayDate must be YYYY-MM-DD',
        code: 'HOLIDAY_DATE_INVALID',
      });
    }
    const holidayDate = new Date(`${input.holidayDate}T00:00:00.000Z`);
    return this.prisma.publicHoliday.upsert({
      where: {
        state_holidayDate: { state, holidayDate },
      },
      create: { state, holidayDate, name },
      update: { name },
    });
  }

  async deletePublicHoliday(id: string) {
    try {
      await this.prisma.publicHoliday.delete({ where: { id } });
      return { success: true };
    } catch {
      throw new NotFoundException('Public holiday not found');
    }
  }

  /** Seed a small set of national holidays if table empty (Award stub). */
  async ensurePublicHolidaySeed(): Promise<void> {
    const any = await this.prisma.publicHoliday.findFirst({ select: { id: true } });
    if (any) return;
    const rows = [
      { state: 'NATIONAL', holidayDate: '2026-01-01', name: "New Year's Day" },
      { state: 'NATIONAL', holidayDate: '2026-01-26', name: 'Australia Day' },
      { state: 'NATIONAL', holidayDate: '2026-04-03', name: 'Good Friday' },
      { state: 'NATIONAL', holidayDate: '2026-04-06', name: 'Easter Monday' },
      { state: 'NATIONAL', holidayDate: '2026-04-25', name: 'ANZAC Day' },
      { state: 'NATIONAL', holidayDate: '2026-12-25', name: 'Christmas Day' },
      { state: 'NATIONAL', holidayDate: '2026-12-26', name: 'Boxing Day' },
      { state: 'VIC', holidayDate: '2026-11-03', name: 'Melbourne Cup Day' },
    ];
    await this.prisma.publicHoliday.createMany({
      data: rows.map((r) => ({
        state: r.state,
        holidayDate: new Date(`${r.holidayDate}T00:00:00.000Z`),
        name: r.name,
      })),
      skipDuplicates: true,
    });
  }
}

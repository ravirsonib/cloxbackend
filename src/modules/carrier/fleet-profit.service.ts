import { Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  FleetPlusTier,
  TripStatus,
  VehicleCostKind,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { FleetPlusService } from './fleet-plus.service';

const MARGIN_FLAG_PCT = 15;
const IDLE_FLAG_PCT = 40;
const CARRIER_NET_SHARE = 0.7;

function dec(n: { toNumber?: () => number } | number | null | undefined): number {
  if (n == null) return 0;
  if (typeof n === 'number') return n;
  if (typeof n.toNumber === 'function') return n.toNumber();
  return Number(n);
}

export type VehicleProfitRow = {
  vehicleId: string;
  registration: string | null;
  label: string | null;
  status: VehicleStatus;
  revenueNetAud: number;
  fuelAud: number;
  wagesAud: number;
  tollsAud: number;
  maintenanceAud: number;
  depreciationAud: number;
  distanceKm: number;
  profitAud: number;
  marginPct: number | null;
  idlePct: number;
  flaggedLowMargin: boolean;
  flaggedHighIdle: boolean;
  maintenanceCause: string | null;
};

@Injectable()
export class FleetProfitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fleetPlus: FleetPlusService,
  ) {}

  /**
   * ProfitTrip = Net(70%) − [Fuel + Wages + Tolls + (MaintRate × Distance)]
   * Enterprise: − dailyDepreciation allocated over window.
   */
  calculateTripProfit(input: {
    grossFareAud: number;
    fuelAud: number;
    wagesAud: number;
    tollsAud: number;
    maintenanceRatePerKm: number;
    distanceKm: number;
    depreciationAud?: number;
  }): { netAud: number; costsAud: number; profitAud: number; marginPct: number | null } {
    const netAud = input.grossFareAud * CARRIER_NET_SHARE;
    const maint = input.maintenanceRatePerKm * input.distanceKm;
    const costsAud =
      input.fuelAud + input.wagesAud + input.tollsAud + maint + (input.depreciationAud ?? 0);
    const profitAud = netAud - costsAud;
    const marginPct = netAud > 0 ? (profitAud / netAud) * 100 : null;
    return { netAud, costsAud, profitAud, marginPct };
  }

  async getAnalytics(
    principal: AuthenticatedPrincipal,
    opts?: { from?: string; to?: string },
  ): Promise<{
    entitled: boolean;
    tier: FleetPlusTier | null;
    window: { from: string; to: string };
    summary: {
      vehicleCount: number;
      flaggedCount: number;
      totalRevenueNetAud: number;
      totalProfitAud: number;
      avgUtilisationPct: number;
    };
    vehicles: VehicleProfitRow[];
  }> {
    const fp = await this.fleetPlus.getFleetPlus(principal);
    await this.fleetPlus.assertFleetPlus(fp.companyId);
    const companyId = fp.companyId;
    const to = opts?.to ? new Date(opts.to) : new Date();
    const from = opts?.from
      ? new Date(opts.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const windowMs = Math.max(to.getTime() - from.getTime(), 1);

    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        companyId,
        status: { notIn: [VehicleStatus.DRAFT, VehicleStatus.RETIRED] },
      },
      orderBy: { registration: 'asc' },
    });

    const isEnterprise = fp.tier === FleetPlusTier.ENTERPRISE;
    const rows: VehicleProfitRow[] = [];

    for (const v of vehicles) {
      const assignments = await this.prisma.assignment.findMany({
        where: {
          vehicleId: v.id,
          status: { in: [AssignmentStatus.LOCKED, AssignmentStatus.COMPLETED] },
          createdAt: { gte: from, lte: to },
        },
        include: {
          trip: {
            select: {
              status: true,
              startedAt: true,
              completedAt: true,
              odometerStartKm: true,
              odometerEndKm: true,
            },
          },
          proposal: { select: { amountIncGstCents: true } },
        },
      });

      let revenueGross = 0;
      let distanceKm = 0;
      let busyMs = 0;
      for (const a of assignments) {
        const fare = (a.proposal?.amountIncGstCents ?? 0) / 100;
        revenueGross += fare;
        const start = a.trip?.odometerStartKm;
        const end = a.trip?.odometerEndKm;
        if (start != null && end != null && end >= start) {
          distanceKm += end - start;
        }
        if (a.trip?.startedAt) {
          const endAt = a.trip.completedAt ?? (a.trip.status === TripStatus.COMPLETED ? to : to);
          busyMs += Math.max(0, endAt.getTime() - a.trip.startedAt.getTime());
        }
      }

      const costs = await this.prisma.vehicleCostEntry.groupBy({
        by: ['kind'],
        where: {
          vehicleId: v.id,
          loggedAt: { gte: from, lte: to },
        },
        _sum: { amountAud: true },
      });
      const fuelLogs = await this.prisma.vehicleFuelLog.aggregate({
        where: { vehicleId: v.id, loggedAt: { gte: from, lte: to } },
        _sum: { amountAud: true },
      });

      let fuelAud = dec(fuelLogs._sum.amountAud);
      let wagesAud = 0;
      let tollsAud = 0;
      let maintenanceAud = 0;
      for (const c of costs) {
        const amt = dec(c._sum.amountAud);
        if (c.kind === VehicleCostKind.FUEL) fuelAud += amt;
        else if (c.kind === VehicleCostKind.WAGE) wagesAud += amt;
        else if (c.kind === VehicleCostKind.TOLL) tollsAud += amt;
        else if (c.kind === VehicleCostKind.MAINTENANCE) maintenanceAud += amt;
      }

      const maintRate = dec(v.maintenanceRatePerKm);
      const days = windowMs / (24 * 60 * 60 * 1000);
      let depreciationAud = 0;
      if (isEnterprise && v.purchasePriceAud != null && v.lifecycleMonths && v.lifecycleMonths > 0) {
        const purchase = dec(v.purchasePriceAud);
        const residual = dec(v.residualValueAud);
        const daily = (purchase - residual) / (v.lifecycleMonths * 30);
        depreciationAud = Math.max(0, daily * days);
      }

      const calc = this.calculateTripProfit({
        grossFareAud: revenueGross,
        fuelAud,
        wagesAud,
        tollsAud,
        maintenanceRatePerKm: maintRate,
        distanceKm,
        depreciationAud,
      });
      // Include explicit maintenance cost entries in profit (on top of rate×distance)
      const profitAud = calc.profitAud - maintenanceAud;
      const marginPct =
        calc.netAud > 0 ? (profitAud / calc.netAud) * 100 : null;
      const idlePct = Math.max(0, Math.min(100, (1 - busyMs / windowMs) * 100));
      const flaggedLowMargin = marginPct != null && marginPct < MARGIN_FLAG_PCT;
      const flaggedHighIdle = idlePct > IDLE_FLAG_PCT;

      rows.push({
        vehicleId: v.id,
        registration: v.registration,
        label: v.label,
        status: v.status,
        revenueNetAud: round2(calc.netAud),
        fuelAud: round2(fuelAud),
        wagesAud: round2(wagesAud),
        tollsAud: round2(tollsAud),
        maintenanceAud: round2(maintenanceAud + maintRate * distanceKm),
        depreciationAud: round2(depreciationAud),
        distanceKm: round2(distanceKm),
        profitAud: round2(profitAud),
        marginPct: marginPct == null ? null : round2(marginPct),
        idlePct: round2(idlePct),
        flaggedLowMargin,
        flaggedHighIdle,
        maintenanceCause: v.maintenanceCause,
      });
    }

    const flaggedCount = rows.filter((r) => r.flaggedLowMargin || r.flaggedHighIdle).length;
    const totalRevenueNetAud = round2(rows.reduce((s, r) => s + r.revenueNetAud, 0));
    const totalProfitAud = round2(rows.reduce((s, r) => s + r.profitAud, 0));
    const avgUtilisationPct =
      rows.length === 0
        ? 0
        : round2(rows.reduce((s, r) => s + (100 - r.idlePct), 0) / rows.length);

    return {
      entitled: fp.entitled,
      tier: fp.tier,
      window: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        vehicleCount: rows.length,
        flaggedCount,
        totalRevenueNetAud,
        totalProfitAud,
        avgUtilisationPct,
      },
      vehicles: rows,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

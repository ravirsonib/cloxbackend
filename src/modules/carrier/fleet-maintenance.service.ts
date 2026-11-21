import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ComplianceDocStatus, ComplianceDocType, VehicleMaintenanceCause, VehicleStatus } from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { FleetPlusService } from './fleet-plus.service';
import { J1939TelematicsOdometerStub, TripAndManualOdometerSource } from './odometer.source';

/**
 * Fleet+ AC5 Maintenance Watchdog — RWC expiry + service-interval vs odometer.
 * Odometer: trip POD + manual fuel logs. J1939 stub consulted but unused until wired.
 */
@Injectable()
export class FleetMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetMaintenanceService.name);
  private readonly j1939 = new J1939TelematicsOdometerStub();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fleetPlus: FleetPlusService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  onModuleInit() {
    const ms = this.config.get('COMPLIANCE_WATCHDOG_MS', { infer: true });
    if (!ms || ms <= 0) {
      this.logger.warn('Fleet maintenance watchdog disabled (COMPLIANCE_WATCHDOG_MS=0)');
      return;
    }
    void this.runMaintenanceWatchdog();
    this.timer = setInterval(() => {
      void this.runMaintenanceWatchdog();
    }, ms);
    this.logger.log(`Fleet maintenance watchdog every ${ms}ms`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private odometerSource() {
    return new TripAndManualOdometerSource({
      latestFuelLogOdometer: async (vehicleId) => {
        const log = await this.prisma.vehicleFuelLog.findFirst({
          where: { vehicleId, odometerKm: { not: null } },
          orderBy: { loggedAt: 'desc' },
          select: { odometerKm: true },
        });
        return log?.odometerKm ?? null;
      },
      latestTripEndOdometer: async (vehicleId) => {
        const trip = await this.prisma.trip.findFirst({
          where: {
            assignment: { vehicleId },
            odometerEndKm: { not: null },
          },
          orderBy: { completedAt: 'desc' },
          select: { odometerEndKm: true },
        });
        return trip?.odometerEndKm != null ? Math.round(trip.odometerEndKm) : null;
      },
    });
  }

  async runMaintenanceWatchdog(): Promise<{
    scanned: number;
    maintenanceOpened: number;
    rwc: number;
    serviceInterval: number;
  }> {
    if (!this.prisma.isConnected()) {
      return { scanned: 0, maintenanceOpened: 0, rwc: 0, serviceInterval: 0 };
    }

    let maintenanceOpened = 0;
    let rwc = 0;
    let serviceInterval = 0;
    const now = new Date();

    // Per-vehicle expired RWC → MAINTENANCE (prefer over SUSPENDED for AC5)
    const expiredRwcs = await this.prisma.complianceDocument.findMany({
      where: {
        docType: ComplianceDocType.RWC,
        vehicleId: { not: null },
        OR: [
          { status: ComplianceDocStatus.EXPIRED },
          {
            expiresAt: { lte: now },
            status: {
              in: [
                ComplianceDocStatus.APPROVED,
                ComplianceDocStatus.UPLOADED,
                ComplianceDocStatus.UNDER_REVIEW,
              ],
            },
          },
        ],
      },
      select: {
        vehicleId: true,
        vehicleUnitId: true,
        companyId: true,
        id: true,
        vehicleUnit: { select: { role: true, registration: true, label: true } },
      },
    });

    for (const doc of expiredRwcs) {
      if (!doc.vehicleId || !doc.companyId) continue;
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: doc.vehicleId },
        select: { id: true, status: true, companyId: true },
      });
      if (!vehicle || vehicle.status === VehicleStatus.MAINTENANCE || vehicle.status === VehicleStatus.RETIRED) {
        continue;
      }
      if (vehicle.status !== VehicleStatus.ACTIVE && vehicle.status !== VehicleStatus.PENDING_REVIEW) {
        continue;
      }
      const unit = doc.vehicleUnit;
      const unitNote = unit
        ? ` (${unit.label ?? unit.role}${unit.registration ? ` ${unit.registration}` : ''})`
        : '';
      await this.fleetPlus.openMaintenance({
        vehicleId: vehicle.id,
        companyId: vehicle.companyId,
        cause: VehicleMaintenanceCause.RWC_EXPIRED,
        notes: `RWC/COI document ${doc.id} expired${unitNote}`,
      });
      maintenanceOpened += 1;
      rwc += 1;
    }

    // Service interval vs odometer
    const candidates = await this.prisma.vehicle.findMany({
      where: {
        status: VehicleStatus.ACTIVE,
        serviceIntervalKm: { not: null },
        lastServiceOdometerKm: { not: null },
      },
      select: {
        id: true,
        companyId: true,
        serviceIntervalKm: true,
        lastServiceOdometerKm: true,
      },
    });

    const odo = this.odometerSource();
    for (const v of candidates) {
      // Prefer trip/manual; J1939 stub returns null until hardware is wired.
      const telematics = await this.j1939.getLatestOdometerKm(v.id);
      const reading = telematics ?? (await odo.getLatestOdometerKm(v.id));
      if (reading == null || v.serviceIntervalKm == null || v.lastServiceOdometerKm == null) {
        continue;
      }
      if (reading >= v.lastServiceOdometerKm + v.serviceIntervalKm) {
        await this.fleetPlus.openMaintenance({
          vehicleId: v.id,
          companyId: v.companyId,
          cause: VehicleMaintenanceCause.SERVICE_INTERVAL,
          notes: `Odometer ${reading}km exceeds service interval (last ${v.lastServiceOdometerKm} + ${v.serviceIntervalKm})`,
        });
        maintenanceOpened += 1;
        serviceInterval += 1;
      }
    }

    const scanned = expiredRwcs.length + candidates.length;
    if (maintenanceOpened > 0) {
      this.logger.warn(
        `Maintenance watchdog: opened=${maintenanceOpened} rwc=${rwc} service=${serviceInterval}`,
      );
    }
    return { scanned, maintenanceOpened, rwc, serviceInterval };
  }
}

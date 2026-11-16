import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FleetPlusStatus,
  FleetPlusTier,
  VehicleCostKind,
  VehicleFuelLogSource,
  VehicleMaintenanceCause,
  VehicleStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../shared/types';
import type {
  VehicleCostEntryInput,
  VehicleCostProfileInput,
  VehicleFuelLogInput,
  VehicleServiceLogInput,
} from '../../shared/types';

const TRIAL_DAYS = 14;

@Injectable()
export class FleetPlusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private ensureDb() {
    if (!this.prisma.isConnected()) {
      throw new BadRequestException({ message: 'Database unavailable', code: 'DB_UNAVAILABLE' });
    }
  }

  /** When false, Fleet+ features are free for every carrier (no trial/paywall). */
  isBillingEnabled(): boolean {
    return this.config.get('FLEET_PLUS_BILLING_ENABLED', { infer: true }) === true;
  }

  private async requireCarrierCompany(principal: AuthenticatedPrincipal) {
    this.ensureDb();
    if (!principal.id) {
      throw new ForbiddenException({ message: 'User required', code: 'USER_REQUIRED' });
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      select: { id: true, companyId: true },
    });
    if (!user?.companyId) {
      throw new ForbiddenException({ message: 'Company required', code: 'COMPANY_REQUIRED' });
    }
    return { userId: user.id, companyId: user.companyId };
  }

  isEntitled(status: FleetPlusStatus, trialEndsAt: Date | null | undefined, now = new Date()): boolean {
    if (!this.isBillingEnabled()) return true;
    if (status === FleetPlusStatus.ACTIVE || status === FleetPlusStatus.PAST_DUE) return true;
    if (status === FleetPlusStatus.TRIALING && trialEndsAt && trialEndsAt > now) return true;
    return false;
  }

  async getFleetPlus(principal: AuthenticatedPrincipal) {
    const { companyId } = await this.requireCarrierCompany(principal);
    const billingEnabled = this.isBillingEnabled();
    if (!billingEnabled) {
      return {
        companyId,
        entitled: true,
        billingEnabled: false,
        tier: FleetPlusTier.ENTERPRISE,
        status: FleetPlusStatus.ACTIVE,
        trialEndsAt: null,
        currentPeriodEnd: null,
        stripeSubscriptionId: null,
      };
    }
    const row = await this.prisma.companyFleetPlus.findUnique({ where: { companyId } });
    const entitled = row ? this.isEntitled(row.status, row.trialEndsAt) : false;
    return {
      companyId,
      entitled,
      billingEnabled: true,
      tier: row?.tier ?? null,
      status: row?.status ?? FleetPlusStatus.NONE,
      trialEndsAt: row?.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
      stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
    };
  }

  async assertFleetPlus(companyId: string) {
    if (!this.isBillingEnabled()) {
      return {
        companyId,
        tier: FleetPlusTier.ENTERPRISE,
        status: FleetPlusStatus.ACTIVE,
        trialEndsAt: null,
        currentPeriodEnd: null,
        stripeSubscriptionId: null,
      } as const;
    }
    const row = await this.prisma.companyFleetPlus.findUnique({ where: { companyId } });
    if (!row || !this.isEntitled(row.status, row.trialEndsAt)) {
      throw new ForbiddenException({
        message: 'Fleet+ subscription or active trial required',
        code: 'FLEET_PLUS_REQUIRED',
      });
    }
    return row;
  }

  /**
   * Activate a paid Fleet+ tier.
   * STRIPE_MOCK / no live Billing: activates immediately with a mock subscription id.
   * Live Stripe Billing Checkout can call `applyStripeSubscription` from the webhook.
   */
  async upgradeTier(
    principal: AuthenticatedPrincipal,
    tier: 'STARTER' | 'GROWTH' | 'ENTERPRISE',
  ) {
    if (!this.isBillingEnabled()) {
      return this.getFleetPlus(principal);
    }
    const { userId, companyId } = await this.requireCarrierCompany(principal);
    const prismaTier =
      tier === 'STARTER'
        ? FleetPlusTier.STARTER
        : tier === 'GROWTH'
          ? FleetPlusTier.GROWTH
          : FleetPlusTier.ENTERPRISE;
    const row = await this.prisma.companyFleetPlus.upsert({
      where: { companyId },
      create: {
        companyId,
        tier: prismaTier,
        status: FleetPlusStatus.ACTIVE,
        stripeSubscriptionId: `sub_mock_${tier.toLowerCase()}_${companyId.slice(0, 8)}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        trialEndsAt: null,
      },
      update: {
        tier: prismaTier,
        status: FleetPlusStatus.ACTIVE,
        stripeSubscriptionId: `sub_mock_${tier.toLowerCase()}_${companyId.slice(0, 8)}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        trialEndsAt: null,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_FLEET_PLUS_UPDATED,
      actorUserId: userId,
      entityType: 'CompanyFleetPlus',
      entityId: row.id,
      metadata: { companyId, tier, source: 'upgrade_api_mock' },
    });
    return this.getFleetPlus(principal);
  }

  async startTrial(principal: AuthenticatedPrincipal) {
    if (!this.isBillingEnabled()) {
      return this.getFleetPlus(principal);
    }
    const { userId, companyId } = await this.requireCarrierCompany(principal);
    const existing = await this.prisma.companyFleetPlus.findUnique({ where: { companyId } });
    if (existing && existing.status !== FleetPlusStatus.NONE && existing.status !== FleetPlusStatus.CANCELED) {
      throw new BadRequestException({
        message: 'Fleet+ already active or trialing',
        code: 'FLEET_PLUS_ALREADY_ACTIVE',
      });
    }
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const row = await this.prisma.companyFleetPlus.upsert({
      where: { companyId },
      create: {
        companyId,
        tier: FleetPlusTier.FREE_TRIAL,
        status: FleetPlusStatus.TRIALING,
        trialEndsAt,
      },
      update: {
        tier: FleetPlusTier.FREE_TRIAL,
        status: FleetPlusStatus.TRIALING,
        trialEndsAt,
        currentPeriodEnd: null,
        stripeSubscriptionId: null,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_FLEET_PLUS_TRIAL_STARTED,
      actorUserId: userId,
      entityType: 'CompanyFleetPlus',
      entityId: row.id,
      metadata: { companyId, trialEndsAt: trialEndsAt.toISOString() },
    });
    return this.getFleetPlus(principal);
  }

  /**
   * Stripe Billing webhook / checkout completion hook.
   * Call from payments module when subscription becomes active.
   */
  async applyStripeSubscription(input: {
    companyId: string;
    tier: FleetPlusTier;
    stripeSubscriptionId: string;
    stripeCustomerId?: string;
    currentPeriodEnd?: Date;
  }) {
    this.ensureDb();
    const row = await this.prisma.companyFleetPlus.upsert({
      where: { companyId: input.companyId },
      create: {
        companyId: input.companyId,
        tier: input.tier,
        status: FleetPlusStatus.ACTIVE,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripeCustomerId: input.stripeCustomerId,
        currentPeriodEnd: input.currentPeriodEnd,
        trialEndsAt: null,
      },
      update: {
        tier: input.tier,
        status: FleetPlusStatus.ACTIVE,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripeCustomerId: input.stripeCustomerId,
        currentPeriodEnd: input.currentPeriodEnd,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_FLEET_PLUS_UPDATED,
      entityType: 'CompanyFleetPlus',
      entityId: row.id,
      metadata: {
        companyId: input.companyId,
        tier: input.tier,
        stripeSubscriptionId: input.stripeSubscriptionId,
      },
    });
    return row;
  }

  private async requireOwnedVehicle(companyId: string, vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, companyId },
    });
    if (!vehicle) {
      throw new NotFoundException({ message: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
    }
    return vehicle;
  }

  async updateCostProfile(
    principal: AuthenticatedPrincipal,
    vehicleId: string,
    input: VehicleCostProfileInput,
  ) {
    const { userId, companyId } = await this.requireCarrierCompany(principal);
    await this.assertFleetPlus(companyId);
    await this.requireOwnedVehicle(companyId, vehicleId);
    const updated = await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        fuelType: input.fuelType === undefined ? undefined : input.fuelType,
        serviceIntervalKm: input.serviceIntervalKm === undefined ? undefined : input.serviceIntervalKm,
        lastServiceOdometerKm:
          input.lastServiceOdometerKm === undefined ? undefined : input.lastServiceOdometerKm,
        maintenanceRatePerKm:
          input.maintenanceRatePerKm === undefined ? undefined : input.maintenanceRatePerKm,
        costProfileUnit: input.costProfileUnit === undefined ? undefined : input.costProfileUnit,
        costProfileRate: input.costProfileRate === undefined ? undefined : input.costProfileRate,
        purchasePriceAud: input.purchasePriceAud === undefined ? undefined : input.purchasePriceAud,
        residualValueAud: input.residualValueAud === undefined ? undefined : input.residualValueAud,
        lifecycleMonths: input.lifecycleMonths === undefined ? undefined : input.lifecycleMonths,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_COST_PROFILE_UPDATED,
      actorUserId: userId,
      entityType: 'Vehicle',
      entityId: vehicleId,
      metadata: { ...input },
    });
    return updated;
  }

  async addFuelLog(principal: AuthenticatedPrincipal, vehicleId: string, input: VehicleFuelLogInput) {
    const { userId, companyId } = await this.requireCarrierCompany(principal);
    await this.assertFleetPlus(companyId);
    await this.requireOwnedVehicle(companyId, vehicleId);
    const row = await this.prisma.vehicleFuelLog.create({
      data: {
        vehicleId,
        companyId,
        liters: input.liters,
        amountAud: input.amountAud,
        odometerKm: input.odometerKm,
        notes: input.notes,
        loggedAt: input.loggedAt ? new Date(input.loggedAt) : new Date(),
        source: VehicleFuelLogSource.MANUAL,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_FUEL_LOGGED,
      actorUserId: userId,
      entityType: 'VehicleFuelLog',
      entityId: row.id,
      metadata: { vehicleId, amountAud: input.amountAud, liters: input.liters },
    });
    return row;
  }

  async addCostEntry(
    principal: AuthenticatedPrincipal,
    vehicleId: string,
    input: VehicleCostEntryInput,
  ) {
    const { userId, companyId } = await this.requireCarrierCompany(principal);
    await this.assertFleetPlus(companyId);
    await this.requireOwnedVehicle(companyId, vehicleId);
    const row = await this.prisma.vehicleCostEntry.create({
      data: {
        vehicleId,
        companyId,
        kind: input.kind as VehicleCostKind,
        amountAud: input.amountAud,
        tripId: input.tripId,
        notes: input.notes,
        loggedAt: input.loggedAt ? new Date(input.loggedAt) : new Date(),
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_COST_LOGGED,
      actorUserId: userId,
      entityType: 'VehicleCostEntry',
      entityId: row.id,
      metadata: { vehicleId, kind: input.kind, amountAud: input.amountAud },
    });
    return row;
  }

  async logService(
    principal: AuthenticatedPrincipal,
    vehicleId: string,
    input: VehicleServiceLogInput,
  ) {
    const { userId, companyId } = await this.requireCarrierCompany(principal);
    const vehicle = await this.requireOwnedVehicle(companyId, vehicleId);
    // Clearing service-interval maintenance or updating cost-driven service logs needs Fleet+.
    // RWC_EXPIRED / SAFETY_FAIL clear via reactivateVehicle after valid RWC / re-pass safety.
    if (input.clearMaintenance && vehicle.maintenanceCause === VehicleMaintenanceCause.SERVICE_INTERVAL) {
      await this.assertFleetPlus(companyId);
    } else if (!input.clearMaintenance) {
      await this.assertFleetPlus(companyId);
    }
    const updated = await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        lastServiceOdometerKm: input.odometerKm,
        ...(input.clearMaintenance && vehicle.status === VehicleStatus.MAINTENANCE
          ? {
              status: VehicleStatus.ACTIVE,
              maintenanceCause: null,
              maintenanceStartedAt: null,
            }
          : {}),
      },
    });
    if (input.clearMaintenance && vehicle.status === VehicleStatus.MAINTENANCE) {
      await this.prisma.vehicleMaintenanceWorkOrder.updateMany({
        where: { vehicleId, clearedAt: null },
        data: { clearedAt: new Date(), clearedNote: input.notes ?? 'Service logged' },
      });
      await this.audit.recordPlatform({
        action: AuditAction.CARRIER_VEHICLE_MAINTENANCE_CLEARED,
        actorUserId: userId,
        entityType: 'Vehicle',
        entityId: vehicleId,
        metadata: { cause: vehicle.maintenanceCause, odometerKm: input.odometerKm },
      });
    }
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_SERVICE_LOGGED,
      actorUserId: userId,
      entityType: 'Vehicle',
      entityId: vehicleId,
      metadata: { odometerKm: input.odometerKm, notes: input.notes },
    });
    return updated;
  }

  async openMaintenance(input: {
    vehicleId: string;
    companyId: string;
    cause: VehicleMaintenanceCause;
    notes?: string;
    tripId?: string;
    actorUserId?: string;
  }) {
    this.ensureDb();
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: input.vehicleId } });
    if (!vehicle || vehicle.companyId !== input.companyId) {
      throw new NotFoundException({ message: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
    }
    if (
      vehicle.status === VehicleStatus.RETIRED ||
      vehicle.status === VehicleStatus.DRAFT
    ) {
      return { vehicle, workOrder: null as null };
    }
    const updated = await this.prisma.vehicle.update({
      where: { id: input.vehicleId },
      data: {
        status: VehicleStatus.MAINTENANCE,
        maintenanceCause: input.cause,
        maintenanceStartedAt: vehicle.maintenanceStartedAt ?? new Date(),
      },
    });
    const workOrder = await this.prisma.vehicleMaintenanceWorkOrder.create({
      data: {
        vehicleId: input.vehicleId,
        companyId: input.companyId,
        cause: input.cause,
        notes: input.notes,
        tripId: input.tripId,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_MAINTENANCE_OPENED,
      actorUserId: input.actorUserId,
      entityType: 'Vehicle',
      entityId: input.vehicleId,
      metadata: { cause: input.cause, workOrderId: workOrder.id, tripId: input.tripId },
    });
    return { vehicle: updated, workOrder };
  }

  async listWorkOrders(principal: AuthenticatedPrincipal, vehicleId: string) {
    const { companyId } = await this.requireCarrierCompany(principal);
    await this.requireOwnedVehicle(companyId, vehicleId);
    return this.prisma.vehicleMaintenanceWorkOrder.findMany({
      where: { vehicleId, companyId },
      orderBy: { openedAt: 'desc' },
      take: 50,
    });
  }
}

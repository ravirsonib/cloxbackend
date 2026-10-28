import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
  DriverStatus,
  JobStatus,
  PlatformRole,
  ProposalStatus,
  TripStatus,
  UserStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AttributionService } from '../../common/services/attribution.service';
import {
  AuditAction,
  type CarrierCapabilitiesInput,
  type CarrierDriverInviteInput,
  type CarrierDriverResendInput,
  type CarrierProfileInput,
  type CarrierRegisterInput,
  type CarrierSubmitVerificationInput,
  type AssignmentReassignInput,
  type CarrierVehicleInput,
  type FleetDisableReasonInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DriverService } from '../driver/driver.service';
import { assertAssignmentCompliance } from '../jobs/assignment-gates';
import { isVehicleClassAdequate } from '../jobs/job-pricing.util';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../payments/stripe.service';

@Injectable()
export class CarrierService {
  private readonly logger = new Logger(CarrierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly drivers: DriverService,
    private readonly notifications: NotificationsService,
    private readonly attribution: AttributionService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async requireCarrier(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier principal required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: {
        company: {
          include: {
            homeRegion: true,
            vehicles: { orderBy: { createdAt: 'asc' } },
            drivers: {
              include: { user: { select: { id: true, email: true, name: true, phone: true } } },
              orderBy: { createdAt: 'asc' },
            },
            complianceCases: { orderBy: { createdAt: 'desc' }, take: 3 },
            complianceDocuments: {
              where: {
                status: {
                  in: [
                    ComplianceDocStatus.UPLOADED,
                    ComplianceDocStatus.UNDER_REVIEW,
                    ComplianceDocStatus.APPROVED,
                  ],
                },
              },
              orderBy: { updatedAt: 'desc' },
              take: 200,
            },
          },
        },
      },
    });
    if (!user?.company || user.company.type !== CompanyType.CARRIER) {
      throw new NotFoundException('Carrier company not found');
    }
    return user;
  }

  private fleetReady(company: {
    vehicles: Array<{ id?: string; status: string }>;
    drivers: Array<{ status: string }>;
    complianceDocuments?: Array<{ docType: ComplianceDocType; vehicleId?: string | null }>;
  }) {
    const activeVehicles = company.vehicles.filter((v) => v.status === 'ACTIVE');
    const activeDrivers = company.drivers.filter((d) => d.status === 'ACTIVE').length;
    if (activeVehicles.length < 1 || activeDrivers < 1) return false;
    return this.activeVehiclesHaveRwc(company);
  }

  /** Every ACTIVE vehicle must have its own RWC (vehicleId set). Company-level RWC does not count. */
  private activeVehiclesHaveRwc(company: {
    vehicles: Array<{ id?: string; status: string }>;
    complianceDocuments?: Array<{ docType: ComplianceDocType; vehicleId?: string | null }>;
  }) {
    const activeVehicles = company.vehicles.filter((v) => v.status === 'ACTIVE' && v.id);
    if (activeVehicles.length < 1) return false;
    const rwcVehicleIds = new Set(
      (company.complianceDocuments ?? [])
        .filter((d) => d.docType === ComplianceDocType.RWC && d.vehicleId)
        .map((d) => d.vehicleId as string),
    );
    return activeVehicles.every((v) => rwcVehicleIds.has(v.id!));
  }

  private goNoGo(company: {
    status: CompanyStatus;
    stripeConnectPayoutsEnabled: boolean;
    abn: string | null;
    capabilities: string[];
    serviceRegionCodes: string[];
    vehicles: Array<{ id?: string; status: string }>;
    drivers: Array<{ status: string }>;
    complianceDocuments?: Array<{ docType: ComplianceDocType; vehicleId?: string | null }>;
  }) {
    const opsApproved = company.status === CompanyStatus.BID_ELIGIBLE;
    const connectOk = company.stripeConnectPayoutsEnabled;
    const fleetOk = this.fleetReady(company);
    const profileOk = Boolean(company.abn);
    const capsOk = company.serviceRegionCodes.length >= 1;
    return {
      profileComplete: profileOk,
      connectReady: connectOk,
      fleetReady: fleetOk,
      capabilitiesSet: capsOk,
      opsApproved,
      canBid: opsApproved && connectOk && fleetOk && profileOk && capsOk,
      netPayoutHint: '70% to carrier after CLOX fee (enforced M6/M7)',
    };
  }

  private wizardStep(company: {
    status: CompanyStatus;
    abn: string | null;
    stripeConnectAccountId: string | null;
    stripeConnectPayoutsEnabled: boolean;
    serviceRegionCodes: string[];
    vehicles: Array<{ id?: string; status: string }>;
    drivers: Array<{ status: string }>;
    complianceDocuments: Array<{
      docType: ComplianceDocType;
      vehicleId?: string | null;
    }>;
  }): string {
    if (company.status === CompanyStatus.REJECTED) return 'rejected';
    if (company.status === CompanyStatus.SUSPENDED) return 'suspended';
    if (company.status === CompanyStatus.BID_ELIGIBLE) return 'complete';
    if (
      company.status === CompanyStatus.PENDING_REVIEW ||
      company.status === CompanyStatus.PENDING_VERIFICATION
    ) {
      return 'waiting_ops';
    }
    // Re-open at Submit so carrier can replace only requested docs and resubmit
    // without redoing Connect / fleet / capabilities.
    if (company.status === CompanyStatus.INFO_REQUESTED) {
      return 'submit';
    }
    if (!company.abn) return 'profile';
    const docs = new Set(company.complianceDocuments.map((d) => d.docType));
    // Company KYB: insurance only. RWC is per-vehicle on the fleet step.
    if (
      !docs.has(ComplianceDocType.PUBLIC_LIABILITY) ||
      !docs.has(ComplianceDocType.CARGO_INSURANCE)
    ) {
      return 'documents';
    }
    if (!company.stripeConnectPayoutsEnabled) return 'connect';
    // Align with fleetReady / submitForReview — DRAFT fleet does not unlock submit.
    if (company.vehicles.filter((v) => v.status === 'ACTIVE').length < 1) {
      return 'vehicles';
    }
    if (!this.activeVehiclesHaveRwc(company)) {
      return 'vehicles';
    }
    if (company.drivers.filter((d) => d.status === 'ACTIVE').length < 1) {
      return 'drivers';
    }
    if (company.serviceRegionCodes.length < 1) return 'capabilities';
    return 'submit';
  }

  async register(input: CarrierRegisterInput) {
    this.ensureDatabase();
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const resolved = await this.attribution.resolveInviteForRegister(
      input.inviteToken,
      CompanyType.CARRIER,
    );
    const vic = await this.prisma.region.findUnique({ where: { code: 'VIC' } });
    const homeRegionId = resolved.homeRegionId ?? vic?.id ?? null;
    const company = await this.prisma.company.create({
      data: {
        type: CompanyType.CARRIER,
        status: CompanyStatus.DRAFT,
        legalName: input.name,
        email: input.email,
        phone: input.phone,
        homeRegionId,
        serviceRegionCodes: vic ? ['VIC'] : [],
        referredByAdminUserId: resolved.referredByAdminUserId,
        referredAt: resolved.referredByAdminUserId ? new Date() : null,
      },
    });
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        phone: input.phone,
        role: PlatformRole.TRANSPORT_COMPANY,
        status: UserStatus.ACTIVE,
        companyId: company.id,
      },
    });
    if (resolved.inviteId) {
      await this.attribution.markInviteAccepted(resolved.inviteId, company.id);
      await this.audit.recordPlatform({
        action: AuditAction.COMPANY_INVITE_ACCEPTED,
        actorUserId: user.id,
        entityType: 'CompanyInvite',
        entityId: resolved.inviteId,
        metadata: {
          companyId: company.id,
          referredByAdminUserId: resolved.referredByAdminUserId,
        },
      });
    }
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_REGISTERED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: {
        email: user.email,
        referredByAdminUserId: resolved.referredByAdminUserId,
      },
    });

    void this.notifications
      .sendRegistrationConfirmation({
        to: user.email,
        name: user.name ?? company.legalName,
        accountType: 'TRANSPORT_COMPANY',
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send carrier registration email for ${user.email}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return {
      ok: true,
      message: 'Carrier registered. Request an OTP to sign in and continue onboarding.',
      userId: user.id,
      companyId: company.id,
      email: user.email,
    };
  }

  async getOnboarding(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    const latestCase = company.complianceCases[0] ?? null;
    const goNoGo = this.goNoGo(company);
    return {
      step: this.wizardStep(company),
      user: { id: user.id, email: user.email, name: user.name, phone: user.phone },
      company: {
        id: company.id,
        status: company.status,
        legalName: company.legalName,
        tradingName: company.tradingName,
        abn: company.abn,
        acn: company.acn,
        phone: company.phone,
        homeRegionCode: company.homeRegion?.code ?? null,
        stripeConnectAccountId: company.stripeConnectAccountId,
        stripeConnectPayoutsEnabled: company.stripeConnectPayoutsEnabled,
        capabilities: company.capabilities,
        serviceRegionCodes: company.serviceRegionCodes,
      },
      vehicles: company.vehicles.map((v) => {
        // complianceDocuments are ordered updatedAt desc — first match is latest RWC.
        const rwcDoc = company.complianceDocuments.find(
          (d) => d.docType === ComplianceDocType.RWC && d.vehicleId === v.id,
        );
        return {
          id: v.id,
          status: v.status,
          label: v.label,
          registration: v.registration,
          vehicleClass: v.vehicleClass,
          tareKg: v.tareKg,
          gvmKg: v.gvmKg,
          gcmKg: v.gcmKg,
          hasRwc: Boolean(rwcDoc),
          rwcDocumentId: rwcDoc?.id ?? null,
        };
      }),
      drivers: company.drivers.map((d) => ({
        id: d.id,
        status: d.status,
        licenceNo: d.licenceNo,
        email: d.user.email,
        name: d.user.name,
        phone: d.user.phone,
      })),
      latestCase: latestCase
        ? {
            id: latestCase.id,
            status: latestCase.status,
            caseType: latestCase.caseType,
            decisionNote: latestCase.decisionNote,
          }
        : null,
      goNoGo,
      stripeMock: this.stripe.isMockMode(),
      uploadedDocs: company.complianceDocuments.map((d) => ({
        id: d.id,
        docType: d.docType,
        status: d.status,
        vehicleId: d.vehicleId ?? null,
      })),
    };
  }

  async updateProfile(principal: AuthenticatedPrincipal, input: CarrierProfileInput) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (
      company.status !== CompanyStatus.DRAFT &&
      company.status !== CompanyStatus.INFO_REQUESTED
    ) {
      throw new BadRequestException('Profile can only be edited in draft or info-requested');
    }
    const region = await this.prisma.region.findUnique({ where: { code: input.homeRegionCode } });
    if (!region) {
      throw new NotFoundException(`Unknown region ${input.homeRegionCode}`);
    }
    await this.prisma.company.update({
      where: { id: company.id },
      data: {
        legalName: input.legalName,
        tradingName: input.tradingName,
        abn: input.abn,
        acn: input.acn,
        phone: input.phone,
        homeRegionId: region.id,
      },
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { name: input.legalName, phone: input.phone ?? user.phone },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_PROFILE_UPDATED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
    });
    return this.getOnboarding(principal);
  }

  async createConnectOnboarding(
    principal: AuthenticatedPrincipal,
    urls?: { refreshUrl?: string; returnUrl?: string },
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (!company.abn) {
      throw new BadRequestException('Complete legal profile (ABN) before Connect');
    }
    let accountId = company.stripeConnectAccountId;
    if (!accountId) {
      let account: { id: string };
      try {
        account = await this.stripe.createConnectAccount({
          email: user.email,
          businessName: company.legalName,
          metadata: { companyId: company.id },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Stripe Connect is not enabled/i.test(message)) {
          throw new BadRequestException(message);
        }
        throw error;
      }
      accountId = account.id;
      await this.prisma.company.update({
        where: { id: company.id },
        data: { stripeConnectAccountId: accountId },
      });
    }
    const adminOrigin = this.config
      .get('ADMIN_APP_URL', { infer: true })
      .replace(/\/$/, '');
    const refreshUrl = urls?.refreshUrl ?? `${adminOrigin}/carrier/onboarding`;
    const returnUrl = urls?.returnUrl ?? `${adminOrigin}/carrier/onboarding?connect=return`;
    const link = await this.stripe.createAccountLink({
      accountId,
      refreshUrl,
      returnUrl,
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_CONNECT_SETUP,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { accountId, mock: link.mock },
    });
    return {
      accountId,
      url: link.url,
      mock: link.mock,
    };
  }

  /** Mock: mark Connect payouts ready. Live: refresh from Stripe account. */
  async confirmConnect(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (!company.stripeConnectAccountId) {
      throw new BadRequestException('Create Connect onboarding first');
    }
    const account = await this.stripe.retrieveConnectAccount(company.stripeConnectAccountId);
    if (!account.payoutsEnabled) {
      throw new BadRequestException('Connect account payouts not enabled yet');
    }
    await this.prisma.company.update({
      where: { id: company.id },
      data: { stripeConnectPayoutsEnabled: true },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_CONNECT_READY,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { accountId: company.stripeConnectAccountId, mock: account.mock },
    });
    return this.getOnboarding(principal);
  }

  /** Fleet may grow after bid-eligible; blocked only when suspended/rejected. */
  private assertCanManageFleet(company: { status: CompanyStatus }) {
    if (
      company.status === CompanyStatus.SUSPENDED ||
      company.status === CompanyStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Cannot manage fleet while company is suspended or rejected',
      );
    }
  }

  /**
   * BID_ELIGIBLE carriers: orphan per-vehicle RWCs (caseId null) join/open CARRIER_FLEET_RWC
   * so Ops can approve without re-upload.
   */
  private async reconcileOrphanVehicleRwcsForOps(company: {
    id: string;
    status: CompanyStatus;
    homeRegionId: string | null;
  }) {
    if (company.status !== CompanyStatus.BID_ELIGIBLE) return;
    const orphanRows = await this.prisma.complianceDocument.findMany({
      where: {
        companyId: company.id,
        docType: ComplianceDocType.RWC,
        vehicleId: { not: null },
        caseId: null,
        status: {
          in: [ComplianceDocStatus.UPLOADED, ComplianceDocStatus.UNDER_REVIEW],
        },
      },
      select: { id: true, status: true },
    });
    // Re-filter in memory so incomplete mocks / stale rows cannot open empty fleet cases.
    const orphans = orphanRows.filter(
      (d) =>
        d.status === ComplianceDocStatus.UPLOADED ||
        d.status === ComplianceDocStatus.UNDER_REVIEW,
    );
    if (orphans.length === 0) return;

    let fleetCase = await this.prisma.complianceCase.findFirst({
      where: {
        companyId: company.id,
        caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
        status: {
          in: [
            ComplianceCaseStatus.OPEN,
            ComplianceCaseStatus.INFO_REQUESTED,
            ComplianceCaseStatus.ESCALATED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!fleetCase) {
      fleetCase = await this.prisma.complianceCase.create({
        data: {
          companyId: company.id,
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
          status: ComplianceCaseStatus.OPEN,
          regionId: company.homeRegionId,
        },
      });
    } else if (fleetCase.status === ComplianceCaseStatus.INFO_REQUESTED) {
      fleetCase = await this.prisma.complianceCase.update({
        where: { id: fleetCase.id },
        data: { status: ComplianceCaseStatus.OPEN, decisionNote: null },
      });
    }
    await this.prisma.complianceDocument.updateMany({
      where: { id: { in: orphans.map((d) => d.id) } },
      data: {
        caseId: fleetCase.id,
        status: ComplianceDocStatus.UNDER_REVIEW,
      },
    });
  }

  async listVehicles(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    await this.reconcileOrphanVehicleRwcsForOps(company);
    const items = await this.prisma.vehicle.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        label: true,
        registration: true,
        vehicleClass: true,
        tareKg: true,
        gvmKg: true,
        gcmKg: true,
        disabledAt: true,
        disabledReason: true,
        disabledNote: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const vehicleIds = items.map((v) => v.id);
    // Per-vehicle RWC only — company-level (vehicleId null) docs do not satisfy fleetReady/canBid.
    const rwcDocs =
      vehicleIds.length === 0
        ? []
        : await this.prisma.complianceDocument.findMany({
            where: {
              docType: ComplianceDocType.RWC,
              vehicleId: { in: vehicleIds },
            },
            orderBy: [{ updatedAt: 'desc' }],
            select: {
              id: true,
              vehicleId: true,
              companyId: true,
              status: true,
              expiresAt: true,
            },
          });

    const byVehicle = new Map<string, (typeof rwcDocs)[number]>();
    for (const doc of rwcDocs) {
      if (doc.vehicleId && !byVehicle.has(doc.vehicleId)) {
        byVehicle.set(doc.vehicleId, doc);
      }
    }

    const activeAssignments =
      vehicleIds.length === 0
        ? []
        : await this.prisma.assignment.findMany({
            where: {
              carrierCompanyId: company.id,
              vehicleId: { in: vehicleIds },
              OR: [
                { status: AssignmentStatus.PENDING },
                {
                  status: AssignmentStatus.LOCKED,
                  trip: {
                    status: {
                      notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED],
                    },
                  },
                },
              ],
            },
            orderBy: { updatedAt: 'desc' },
            include: {
              trip: {
                select: {
                  id: true,
                  status: true,
                  onBreak: true,
                  breakStartedAt: true,
                },
              },
              job: { select: { id: true, title: true } },
            },
          });

    const assignmentByVehicle = new Map<string, (typeof activeAssignments)[number]>();
    for (const row of activeAssignments) {
      if (row.vehicleId && !assignmentByVehicle.has(row.vehicleId)) {
        assignmentByVehicle.set(row.vehicleId, row);
      }
    }

    const openBidCommitments =
      vehicleIds.length === 0
        ? []
        : await this.prisma.proposal.findMany({
            where: {
              carrierCompanyId: company.id,
              vehicleId: { in: vehicleIds },
              status: ProposalStatus.SUBMITTED,
              job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              vehicleId: true,
              jobId: true,
              job: { select: { id: true, title: true } },
            },
          });
    const bidByVehicle = new Map<string, (typeof openBidCommitments)[number]>();
    for (const row of openBidCommitments) {
      if (row.vehicleId && !bidByVehicle.has(row.vehicleId)) {
        bidByVehicle.set(row.vehicleId, row);
      }
    }

    return {
      items: items.map((v) => {
        const active = assignmentByVehicle.get(v.id) ?? null;
        const trip = active?.trip ?? null;
        const openBid = bidByVehicle.get(v.id) ?? null;
        /** Operational label for UI — does not mutate VehicleStatus (asset lifecycle). */
        const activityStatus = trip
          ? trip.onBreak
            ? 'ON_BREAK'
            : trip.status
          : active?.status === AssignmentStatus.PENDING
            ? 'PENDING_ASSIGNMENT'
            : openBid
              ? 'BID_COMMITTED'
              : null;
        const bidAvailable = v.status === VehicleStatus.ACTIVE && activityStatus == null;
        return {
          ...v,
          activityStatus,
          bidAvailable,
          committedJob: active
            ? { id: active.job.id, title: active.job.title }
            : openBid
              ? { id: openBid.job.id, title: openBid.job.title }
              : null,
          currentTrip: trip
            ? {
                id: trip.id,
                status: trip.status,
                onBreak: trip.onBreak,
                breakStartedAt: trip.breakStartedAt,
                jobId: active!.job.id,
                jobTitle: active!.job.title,
              }
            : null,
          compliance: {
            rwc: this.summarizeRwcDoc(byVehicle.get(v.id) ?? null),
          },
        };
      }),
    };
  }

  /** FLT-01: RWC pill — uploaded/under review/approved all show OK; Ops approval is documentStatus. */
  private summarizeRwcDoc(
    doc:
      | {
          id: string;
          status: ComplianceDocStatus;
          expiresAt: Date | null;
        }
      | null
      | undefined,
  ) {
    if (!doc) {
      return {
        state: 'MISSING' as const,
        expiresAt: null as string | null,
        documentId: null as string | null,
        documentStatus: null as string | null,
      };
    }
    const now = Date.now();
    const expiresMs = doc.expiresAt?.getTime() ?? null;
    const warnMs = 30 * 24 * 60 * 60 * 1000;
    let state: 'OK' | 'EXPIRING' | 'EXPIRED' | 'PENDING' | 'MISSING' = 'OK';
    if (
      doc.status === ComplianceDocStatus.EXPIRED ||
      (expiresMs != null && expiresMs <= now)
    ) {
      state = 'EXPIRED';
    } else if (doc.status === ComplianceDocStatus.UPLOAD_PENDING) {
      state = 'PENDING';
    } else if (
      doc.status === ComplianceDocStatus.UPLOADED ||
      doc.status === ComplianceDocStatus.UNDER_REVIEW ||
      doc.status === ComplianceDocStatus.APPROVED
    ) {
      state =
        expiresMs != null && expiresMs - now <= warnMs ? 'EXPIRING' : 'OK';
    } else if (doc.status === ComplianceDocStatus.REJECTED) {
      state = 'MISSING';
    } else {
      state = 'PENDING';
    }
    return {
      state,
      expiresAt: doc.expiresAt?.toISOString() ?? null,
      documentId: doc.id,
      documentStatus: doc.status,
    };
  }

  async listDrivers(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    const rows = await this.prisma.driver.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true, phone: true, status: true } },
        assignments: {
          where: {
            OR: [
              { status: AssignmentStatus.PENDING },
              {
                status: AssignmentStatus.LOCKED,
                trip: {
                  status: {
                    notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED],
                  },
                },
              },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          include: {
            trip: {
              select: {
                id: true,
                status: true,
                onBreak: true,
                breakStartedAt: true,
              },
            },
            job: { select: { id: true, title: true } },
          },
        },
        proposals: {
          where: {
            status: ProposalStatus.SUBMITTED,
            job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            jobId: true,
            job: { select: { id: true, title: true } },
          },
        },
      },
    });
    return {
      items: rows.map((d) => {
        const active = d.assignments[0] ?? null;
        const trip = active?.trip ?? null;
        const openBid = d.proposals[0] ?? null;
        /** Operational label for UI — does not mutate DriverStatus (account lifecycle). */
        const activityStatus = trip
          ? trip.onBreak
            ? 'ON_BREAK'
            : trip.status
          : active?.status === AssignmentStatus.PENDING
            ? 'PENDING_ASSIGNMENT'
            : openBid
              ? 'BID_COMMITTED'
              : null;
        const bidAvailable = d.status === DriverStatus.ACTIVE && activityStatus == null;
        return {
          id: d.id,
          status: d.status,
          activityStatus,
          bidAvailable,
          committedJob: active
            ? { id: active.job.id, title: active.job.title }
            : openBid
              ? { id: openBid.job.id, title: openBid.job.title }
              : null,
          currentTrip: trip
            ? {
                id: trip.id,
                status: trip.status,
                onBreak: trip.onBreak,
                breakStartedAt: trip.breakStartedAt,
                jobId: active!.job.id,
                jobTitle: active!.job.title,
              }
            : null,
          licenceNo: d.licenceNo,
          licenceClass: d.licenceClass,
          licenceExpiry: d.licenceExpiry,
          reliabilityScore: d.reliabilityScore,
          inviteAcceptedAt: d.inviteAcceptedAt,
          inviteExpiresAt: d.inviteExpiresAt,
          disabledAt: d.disabledAt,
          disabledReason: d.disabledReason,
          disabledNote: d.disabledNote,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          user: d.user,
        };
      }),
    };
  }

  async addVehicle(principal: AuthenticatedPrincipal, input: CarrierVehicleInput) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);
    // Post-KYB adds need Super Admin approve before bid use; onboarding seed stays ACTIVE.
    const status =
      company.status === CompanyStatus.BID_ELIGIBLE
        ? VehicleStatus.PENDING_REVIEW
        : VehicleStatus.ACTIVE;
    const vehicle = await this.prisma.vehicle.create({
      data: {
        companyId: company.id,
        status,
        label: input.label,
        registration: input.registration.toUpperCase(),
        vehicleClass: input.vehicleClass.toUpperCase(),
        tareKg: input.tareKg,
        gvmKg: input.gvmKg,
        gcmKg: input.gcmKg,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_ADDED,
      actorUserId: user.id,
      entityType: 'Vehicle',
      entityId: vehicle.id,
      metadata: { status },
    });
    return this.getOnboarding(principal);
  }

  private async assertNotLastActiveVehicle(companyId: string, vehicleId: string) {
    const activeCount = await this.prisma.vehicle.count({
      where: { companyId, status: VehicleStatus.ACTIVE },
    });
    const target = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, companyId },
      select: { status: true },
    });
    if (target?.status === VehicleStatus.ACTIVE && activeCount <= 1) {
      throw new BadRequestException(
        'Cannot disable or retire the last active vehicle while the company remains bid-eligible. Add another active vehicle first.',
      );
    }
  }

  private async assertNotLastActiveDriver(companyId: string, driverId: string) {
    const activeCount = await this.prisma.driver.count({
      where: { companyId, status: DriverStatus.ACTIVE },
    });
    const target = await this.prisma.driver.findFirst({
      where: { id: driverId, companyId },
      select: { status: true },
    });
    if (target?.status === DriverStatus.ACTIVE && activeCount <= 1) {
      throw new BadRequestException(
        'Cannot disable the last active driver while the company remains bid-eligible. Invite or reactivate another driver first.',
      );
    }
  }

  private async assertVehicleNotOnActiveTrip(companyId: string, vehicleId: string) {
    const busy = await this.prisma.assignment.findFirst({
      where: {
        carrierCompanyId: companyId,
        vehicleId,
        status: AssignmentStatus.LOCKED,
        trip: { status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] } },
      },
      select: { id: true },
    });
    if (busy) {
      throw new BadRequestException(
        'Vehicle is on an active trip — reassign the trip before disabling or retiring',
      );
    }
  }

  private async assertDriverNotOnActiveTrip(companyId: string, driverId: string) {
    const busy = await this.prisma.assignment.findFirst({
      where: {
        carrierCompanyId: companyId,
        driverId,
        status: AssignmentStatus.LOCKED,
        trip: { status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] } },
      },
      select: { id: true },
    });
    if (busy) {
      throw new BadRequestException(
        'Driver is on an active trip — reassign the trip before disabling',
      );
    }
  }

  private shouldEnforceLastAssetGuard(status: CompanyStatus) {
    return (
      status === CompanyStatus.BID_ELIGIBLE ||
      status === CompanyStatus.ACTIVE ||
      status === CompanyStatus.PENDING_FLEET_READINESS
    );
  }

  async disableVehicle(
    principal: AuthenticatedPrincipal,
    vehicleId: string,
    input: FleetDisableReasonInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, companyId: company.id },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === VehicleStatus.SUSPENDED || vehicle.status === VehicleStatus.RETIRED) {
      throw new BadRequestException('Vehicle is already disabled or retired');
    }

    await this.assertVehicleNotOnActiveTrip(company.id, vehicleId);
    if (this.shouldEnforceLastAssetGuard(company.status)) {
      await this.assertNotLastActiveVehicle(company.id, vehicleId);
    }

    const reason = input.reason.trim();
    const note = input.note?.trim() || null;
    const now = new Date();
    const updated = await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        status: VehicleStatus.SUSPENDED,
        disabledAt: now,
        disabledReason: reason,
        disabledNote: note,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_DISABLED,
      actorUserId: user.id,
      entityType: 'Vehicle',
      entityId: vehicleId,
      metadata: { reason, note, previousStatus: vehicle.status },
    });

    return updated;
  }

  async retireVehicle(
    principal: AuthenticatedPrincipal,
    vehicleId: string,
    input: FleetDisableReasonInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, companyId: company.id },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === VehicleStatus.RETIRED) {
      throw new BadRequestException('Vehicle is already retired');
    }

    await this.assertVehicleNotOnActiveTrip(company.id, vehicleId);
    if (this.shouldEnforceLastAssetGuard(company.status)) {
      await this.assertNotLastActiveVehicle(company.id, vehicleId);
    }

    const reason = input.reason.trim();
    const note = input.note?.trim() || null;
    const now = new Date();
    const updated = await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        status: VehicleStatus.RETIRED,
        disabledAt: now,
        disabledReason: reason,
        disabledNote: note,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_RETIRED,
      actorUserId: user.id,
      entityType: 'Vehicle',
      entityId: vehicleId,
      metadata: { reason, note, previousStatus: vehicle.status },
    });

    return updated;
  }

  async reactivateVehicle(principal: AuthenticatedPrincipal, vehicleId: string) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, companyId: company.id },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (
      vehicle.status !== VehicleStatus.SUSPENDED &&
      vehicle.status !== VehicleStatus.RETIRED
    ) {
      throw new BadRequestException('Vehicle is not disabled or retired');
    }

    const updated = await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        status: VehicleStatus.ACTIVE,
        disabledAt: null,
        disabledReason: null,
        disabledNote: null,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_REACTIVATED,
      actorUserId: user.id,
      entityType: 'Vehicle',
      entityId: vehicleId,
      metadata: { previousStatus: vehicle.status },
    });

    return updated;
  }

  /**
   * Permanently remove a vehicle that was never used on marketplace records.
   * Vehicles with proposals/assignments must be disabled or retired instead.
   */
  async deleteVehicle(principal: AuthenticatedPrincipal, vehicleId: string) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, companyId: company.id },
      include: {
        _count: { select: { assignments: true, proposals: true } },
      },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (vehicle._count.assignments > 0 || vehicle._count.proposals > 0) {
      throw new BadRequestException({
        message:
          'Vehicle has bid or assignment history and cannot be deleted. Disable or retire it instead.',
        code: 'VEHICLE_HAS_HISTORY',
      });
    }

    await this.assertVehicleNotOnActiveTrip(company.id, vehicleId);
    if (
      vehicle.status === VehicleStatus.ACTIVE &&
      this.shouldEnforceLastAssetGuard(company.status)
    ) {
      await this.assertNotLastActiveVehicle(company.id, vehicleId);
    }

    await this.prisma.vehicle.delete({ where: { id: vehicleId } });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_VEHICLE_DELETED,
      actorUserId: user.id,
      entityType: 'Vehicle',
      entityId: vehicleId,
      metadata: {
        previousStatus: vehicle.status,
        registration: vehicle.registration,
        label: vehicle.label,
        vehicleClass: vehicle.vehicleClass,
      },
    });

    return { ok: true as const, id: vehicleId };
  }

  async disableDriver(
    principal: AuthenticatedPrincipal,
    driverId: string,
    input: FleetDisableReasonInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, companyId: company.id },
      include: { user: { select: { id: true, status: true } } },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    if (
      driver.status === DriverStatus.SUSPENDED ||
      driver.status === DriverStatus.DISABLED
    ) {
      throw new BadRequestException('Driver is already disabled');
    }

    await this.assertDriverNotOnActiveTrip(company.id, driverId);
    if (this.shouldEnforceLastAssetGuard(company.status)) {
      await this.assertNotLastActiveDriver(company.id, driverId);
    }

    const reason = input.reason.trim();
    const note = input.note?.trim() || null;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.driver.update({
        where: { id: driverId },
        data: {
          status: DriverStatus.SUSPENDED,
          disabledAt: now,
          disabledReason: reason,
          disabledNote: note,
        },
      });
      if (
        driver.user.status === UserStatus.ACTIVE ||
        driver.user.status === UserStatus.PENDING
      ) {
        await tx.user.update({
          where: { id: driver.userId },
          data: { status: UserStatus.SUSPENDED },
        });
        await tx.authSession.updateMany({
          where: { userId: driver.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_DRIVER_DISABLED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driverId,
      metadata: { reason, note, previousStatus: driver.status },
    });

    return this.listDrivers(principal).then((res) =>
      res.items.find((d) => d.id === driverId),
    );
  }

  async reactivateDriver(principal: AuthenticatedPrincipal, driverId: string) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, companyId: company.id },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    if (
      driver.status !== DriverStatus.SUSPENDED &&
      driver.status !== DriverStatus.DISABLED
    ) {
      throw new BadRequestException('Driver is not disabled');
    }

    const nextDriverStatus = driver.inviteAcceptedAt
      ? DriverStatus.ACTIVE
      : DriverStatus.INVITED;
    const nextUserStatus = driver.inviteAcceptedAt
      ? UserStatus.ACTIVE
      : UserStatus.PENDING;

    await this.prisma.$transaction(async (tx) => {
      await tx.driver.update({
        where: { id: driverId },
        data: {
          status: nextDriverStatus,
          disabledAt: null,
          disabledReason: null,
          disabledNote: null,
        },
      });
      await tx.user.update({
        where: { id: driver.userId },
        data: { status: nextUserStatus },
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_DRIVER_REACTIVATED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driverId,
      metadata: { previousStatus: driver.status, restoredStatus: nextDriverStatus },
    });

    return this.listDrivers(principal).then((res) =>
      res.items.find((d) => d.id === driverId),
    );
  }

  /**
   * Permanently remove a driver who was never used on marketplace records.
   * Used to cancel outstanding invites or clean never-assigned profiles.
   * Drivers with proposals/assignments must be disabled instead.
   */
  async deleteDriver(principal: AuthenticatedPrincipal, driverId: string) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, companyId: company.id },
      include: {
        user: { select: { id: true, email: true, name: true } },
        _count: { select: { assignments: true, proposals: true } },
      },
    });
    if (!driver) throw new NotFoundException('Driver not found');

    if (driver._count.assignments > 0 || driver._count.proposals > 0) {
      throw new BadRequestException({
        message:
          'Driver has bid or assignment history and cannot be deleted. Disable the driver instead.',
        code: 'DRIVER_HAS_HISTORY',
      });
    }

    await this.assertDriverNotOnActiveTrip(company.id, driverId);
    if (
      driver.status === DriverStatus.ACTIVE &&
      this.shouldEnforceLastAssetGuard(company.status)
    ) {
      await this.assertNotLastActiveDriver(company.id, driverId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.driver.delete({ where: { id: driverId } });
      await tx.user.delete({ where: { id: driver.userId } });
    });

    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_DRIVER_DELETED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driverId,
      metadata: {
        previousStatus: driver.status,
        email: driver.user.email,
        name: driver.user.name,
        inviteAccepted: !!driver.inviteAcceptedAt,
      },
    });

    return { ok: true as const, id: driverId };
  }

  /**
   * Reassign vehicle/driver on a locked assignment with an in-progress trip.
   * When the driver changes, safety gate is reset so the new driver re-runs NHVR.
   */
  async reassignAssignment(
    principal: AuthenticatedPrincipal,
    assignmentId: string,
    input: AssignmentReassignInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    this.assertCanManageFleet(company);

    const assignment = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, carrierCompanyId: company.id },
      include: {
        job: { select: { id: true, minVehicleClass: true, title: true } },
        trip: { select: { id: true, status: true } },
        vehicle: { select: { id: true, registration: true } },
        driver: { select: { id: true, user: { select: { email: true, name: true } } } },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.status !== AssignmentStatus.LOCKED) {
      throw new BadRequestException('Only locked (paid) assignments can be reassigned');
    }
    if (
      !assignment.trip ||
      assignment.trip.status === TripStatus.COMPLETED ||
      assignment.trip.status === TripStatus.CANCELLED
    ) {
      throw new BadRequestException('No active trip to reassign');
    }

    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: input.vehicleId,
        companyId: company.id,
        status: VehicleStatus.ACTIVE,
      },
    });
    if (!vehicle) {
      throw new BadRequestException({
        message: 'Active vehicle required',
        code: 'VEHICLE_NOT_ACTIVE',
      });
    }
    if (!isVehicleClassAdequate(vehicle.vehicleClass, assignment.job.minVehicleClass)) {
      throw new BadRequestException({
        message: `Vehicle class ${vehicle.vehicleClass} undersized for min ${assignment.job.minVehicleClass}`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }

    const driver = await this.prisma.driver.findFirst({
      where: {
        id: input.driverId,
        companyId: company.id,
        status: DriverStatus.ACTIVE,
      },
    });
    if (!driver) throw new BadRequestException('Active driver required');
    await assertAssignmentCompliance(
      this.prisma,
      {
        driver,
        vehicleId: vehicle.id,
        vehicleClass: vehicle.vehicleClass,
      },
      'badRequest',
    );

    const previousVehicleId = assignment.vehicleId;
    const previousDriverId = assignment.driverId;
    if (previousVehicleId === vehicle.id && previousDriverId === driver.id) {
      throw new BadRequestException('Select a different vehicle or driver');
    }
    const driverChanged = previousDriverId !== driver.id;
    const reason = input.reason.trim();
    const note = input.note?.trim() || null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.assignment.update({
        where: { id: assignmentId },
        data: {
          vehicleId: vehicle.id,
          driverId: driver.id,
        },
        include: {
          vehicle: {
            select: { id: true, registration: true, vehicleClass: true, status: true },
          },
          driver: {
            select: {
              id: true,
              status: true,
              user: { select: { email: true, name: true } },
            },
          },
          trip: { select: { id: true, status: true } },
          job: {
            select: {
              id: true,
              title: true,
              status: true,
              minVehicleClass: true,
            },
          },
        },
      });

      if (driverChanged && assignment.trip) {
        await tx.trip.update({
          where: { id: assignment.trip.id },
          data: {
            status: TripStatus.PENDING_GATES,
            safetyPassedAt: null,
            safetyFailedAt: null,
            safetyNotes: `[REASSIGN] ${reason}`,
            startedAt: null,
          },
        });
      }

      return next;
    });

    await this.audit.recordPlatform({
      action: AuditAction.ASSIGNMENT_REASSIGNED,
      actorUserId: user.id,
      entityType: 'Assignment',
      entityId: assignmentId,
      metadata: {
        reason,
        note,
        previousVehicleId,
        previousDriverId,
        vehicleId: vehicle.id,
        driverId: driver.id,
        driverChanged,
        tripId: assignment.trip.id,
        safetyReset: driverChanged,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      vehicleId: updated.vehicleId,
      driverId: updated.driverId,
      vehicle: updated.vehicle,
      driver: updated.driver,
      trip: updated.trip
        ? {
            id: updated.trip.id,
            status: driverChanged ? TripStatus.PENDING_GATES : updated.trip.status,
          }
        : null,
      job: updated.job,
      safetyReset: driverChanged,
    };
  }

  async inviteDriver(principal: AuthenticatedPrincipal, input: CarrierDriverInviteInput) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (
      company.status === CompanyStatus.SUSPENDED ||
      company.status === CompanyStatus.REJECTED
    ) {
      throw new BadRequestException('Cannot invite drivers while company is suspended or rejected');
    }
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const token = this.drivers.createInviteToken();
    const { driverUser, driver } = await this.prisma.$transaction(async (tx) => {
      const driverUser = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          phone: input.phone,
          role: PlatformRole.DRIVER,
          status: UserStatus.PENDING,
          companyId: company.id,
        },
      });
      const driver = await tx.driver.create({
        data: {
          userId: driverUser.id,
          companyId: company.id,
          status: DriverStatus.INVITED,
          licenceNo: input.licenceNo,
          inviteTokenHash: token.hash,
          inviteExpiresAt: token.expiresAt,
        },
      });
      return { driverUser, driver };
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_DRIVER_INVITED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driver.id,
      metadata: { email: input.email },
    });
    const mail = await this.drivers.sendInviteMail({
      email: input.email,
      name: input.name,
      companyName: company.legalName,
      rawToken: token.raw,
    });
    const onboarding = await this.getOnboarding(principal);
    return {
      ...onboarding,
      invite: {
        driverId: driver.id,
        email: driverUser.email,
        inviteUrl: this.drivers.inviteUrl(token.raw),
        expiresAt: token.expiresAt,
        mailSkipped: mail.skipped === true,
        /** Dev-only when SMTP skipped — never log in production UI permanently */
        debugToken: mail.skipped ? token.raw : undefined,
      },
    };
  }

  async resendDriverInvite(principal: AuthenticatedPrincipal, input: CarrierDriverResendInput) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    const driver = await this.prisma.driver.findFirst({
      where: { id: input.driverId, companyId: company.id },
      include: { user: true },
    });
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }
    if (driver.inviteAcceptedAt || driver.status !== DriverStatus.INVITED) {
      throw new BadRequestException('Invite already accepted or not in INVITED state');
    }
    const token = this.drivers.createInviteToken();
    await this.prisma.driver.update({
      where: { id: driver.id },
      data: {
        inviteTokenHash: token.hash,
        inviteExpiresAt: token.expiresAt,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_DRIVER_INVITE_RESENT,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driver.id,
      metadata: { email: driver.user.email },
    });
    const mail = await this.drivers.sendInviteMail({
      email: driver.user.email,
      name: driver.user.name ?? driver.user.email,
      companyName: company.legalName,
      rawToken: token.raw,
    });
    return {
      driverId: driver.id,
      email: driver.user.email,
      inviteUrl: this.drivers.inviteUrl(token.raw),
      expiresAt: token.expiresAt,
      mailSkipped: mail.skipped === true,
      debugToken: mail.skipped ? token.raw : undefined,
    };
  }

  async updateCapabilities(principal: AuthenticatedPrincipal, input: CarrierCapabilitiesInput) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (
      company.status !== CompanyStatus.DRAFT &&
      company.status !== CompanyStatus.INFO_REQUESTED
    ) {
      throw new BadRequestException('Capabilities editable only in draft or info-requested');
    }
    for (const code of input.serviceRegionCodes) {
      const region = await this.prisma.region.findUnique({ where: { code } });
      if (!region) {
        throw new NotFoundException(`Unknown region ${code}`);
      }
    }
    if (input.capabilities.includes('DG')) {
      const dgDoc = await this.prisma.complianceDocument.findFirst({
        where: {
          companyId: company.id,
          docType: ComplianceDocType.DG_LICENCE,
          vehicleId: null,
          status: {
            in: [
              ComplianceDocStatus.UPLOADED,
              ComplianceDocStatus.UNDER_REVIEW,
              ComplianceDocStatus.APPROVED,
            ],
          },
        },
        select: { id: true },
      });
      if (!dgDoc) {
        throw new BadRequestException(
          'Upload a dangerous goods licence (DG_LICENCE) before enabling Dangerous goods',
        );
      }
    }
    await this.prisma.company.update({
      where: { id: company.id },
      data: {
        capabilities: input.capabilities,
        serviceRegionCodes: input.serviceRegionCodes,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_CAPABILITIES_UPDATED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: {
        capabilities: input.capabilities,
        serviceRegionCodes: input.serviceRegionCodes,
      },
    });
    return this.getOnboarding(principal);
  }

  /**
   * Latest eligible RWC per ACTIVE vehicle (+ optional company DG_LICENCE) to attach on KYB submit.
   */
  private async collectKybFleetAndCapabilityDocs(
    company: {
      id: string;
      capabilities: string[];
      vehicles: Array<{ id?: string; status: string }>;
    },
    allowedDocStatuses: ComplianceDocStatus[],
  ) {
    const activeVehicleIds = company.vehicles
      .filter((v) => v.status === 'ACTIVE' && v.id)
      .map((v) => v.id!);
    if (activeVehicleIds.length < 1) {
      throw new BadRequestException('Add at least one ACTIVE vehicle before submit');
    }

    const rwcRows = await this.prisma.complianceDocument.findMany({
      where: {
        companyId: company.id,
        docType: ComplianceDocType.RWC,
        vehicleId: { in: activeVehicleIds },
        status: { in: allowedDocStatuses },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, vehicleId: true },
    });
    const latestRwcByVehicle = new Map<string, string>();
    for (const row of rwcRows) {
      if (row.vehicleId && !latestRwcByVehicle.has(row.vehicleId)) {
        latestRwcByVehicle.set(row.vehicleId, row.id);
      }
    }
    const missingRwc = activeVehicleIds.filter((id) => !latestRwcByVehicle.has(id));
    if (missingRwc.length > 0) {
      throw new BadRequestException(
        'Each ACTIVE vehicle must have a roadworthy certificate (RWC) uploaded for that vehicle',
      );
    }

    const attachIds = [...latestRwcByVehicle.values()];
    if (company.capabilities.includes('DG')) {
      const dgDoc = await this.prisma.complianceDocument.findFirst({
        where: {
          companyId: company.id,
          docType: ComplianceDocType.DG_LICENCE,
          vehicleId: null,
          status: { in: allowedDocStatuses },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      if (!dgDoc) {
        throw new BadRequestException(
          'Missing required doc: DG_LICENCE (required when Dangerous goods capability is set)',
        );
      }
      attachIds.push(dgDoc.id);
    }
    return attachIds;
  }

  async submitVerification(
    principal: AuthenticatedPrincipal,
    input: CarrierSubmitVerificationInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (!company.abn) {
      throw new BadRequestException('ABN required before submit');
    }
    if (!company.stripeConnectPayoutsEnabled) {
      throw new BadRequestException('Complete Stripe Connect before submit');
    }
    if (!this.fleetReady(company)) {
      throw new BadRequestException(
        'Add at least one ACTIVE vehicle (each with a vehicle RWC) and one ACTIVE driver before submit',
      );
    }
    if (!this.activeVehiclesHaveRwc(company)) {
      throw new BadRequestException(
        'Each ACTIVE vehicle must have a roadworthy certificate (RWC) uploaded for that vehicle',
      );
    }
    if (company.serviceRegionCodes.length < 1) {
      throw new BadRequestException('Set service regions before submit');
    }

    const open = await this.prisma.complianceCase.findFirst({
      where: {
        companyId: company.id,
        caseType: ComplianceCaseType.CARRIER_KYB,
        status: {
          in: [
            ComplianceCaseStatus.OPEN,
            ComplianceCaseStatus.INFO_REQUESTED,
            ComplianceCaseStatus.ESCALATED,
          ],
        },
      },
    });
    if (open && open.status !== ComplianceCaseStatus.INFO_REQUESTED) {
      throw new BadRequestException('An open compliance case already exists');
    }

    // First submit: UPLOADED only. Info-requested resubmit: keep prior UNDER_REVIEW
    // docs and/or replace with newly UPLOADED files.
    const isInfoResubmit =
      company.status === CompanyStatus.INFO_REQUESTED ||
      open?.status === ComplianceCaseStatus.INFO_REQUESTED;
    const allowedDocStatuses = isInfoResubmit
      ? [ComplianceDocStatus.UPLOADED, ComplianceDocStatus.UNDER_REVIEW]
      : [ComplianceDocStatus.UPLOADED];

    const docs = await this.prisma.complianceDocument.findMany({
      where: {
        id: { in: input.documentIds },
        companyId: company.id,
        status: { in: allowedDocStatuses },
      },
    });
    if (docs.length !== input.documentIds.length) {
      throw new BadRequestException(
        isInfoResubmit
          ? 'Documents must be uploaded (or previously submitted) for this company'
          : 'All documents must be uploaded for this company',
      );
    }
    const types = new Set(docs.map((d) => d.docType));
    for (const required of [
      ComplianceDocType.PUBLIC_LIABILITY,
      ComplianceDocType.CARGO_INSURANCE,
    ]) {
      if (!types.has(required)) {
        throw new BadRequestException(`Missing required doc: ${required}`);
      }
    }

    const fleetAndCapDocIds = await this.collectKybFleetAndCapabilityDocs(
      company,
      allowedDocStatuses,
    );
    const allDocumentIds = [...new Set([...input.documentIds, ...fleetAndCapDocIds])];

    const created = await this.prisma.$transaction(async (tx) => {
      let complianceCase = open;
      if (complianceCase?.status === ComplianceCaseStatus.INFO_REQUESTED) {
        complianceCase = await tx.complianceCase.update({
          where: { id: complianceCase.id },
          data: {
            status: ComplianceCaseStatus.OPEN,
            caseType: ComplianceCaseType.CARRIER_KYB,
            decisionNote: null,
            submittedByUserId: user.id,
          },
        });
      } else {
        complianceCase = await tx.complianceCase.create({
          data: {
            companyId: company.id,
            caseType: ComplianceCaseType.CARRIER_KYB,
            status: ComplianceCaseStatus.OPEN,
            regionId: company.homeRegionId,
            submittedByUserId: user.id,
          },
        });
      }
      await tx.complianceDocument.updateMany({
        where: { id: { in: allDocumentIds } },
        data: { caseId: complianceCase.id, status: ComplianceDocStatus.UNDER_REVIEW },
      });
      await tx.company.update({
        where: { id: company.id },
        data: { status: CompanyStatus.PENDING_REVIEW },
      });
      return complianceCase;
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_SUBMITTED,
      actorUserId: user.id,
      entityType: 'ComplianceCase',
      entityId: created.id,
      metadata: { caseType: 'CARRIER_KYB', documentIds: allDocumentIds },
    });
    return this.getOnboarding(principal);
  }

  async getBidEligibility(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const goNoGo = this.goNoGo(user.company!);
    return {
      canBid: goNoGo.canBid,
      goNoGo,
      companyStatus: user.company!.status,
    };
  }
}

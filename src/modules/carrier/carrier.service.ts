import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
  DriverStatus,
  PlatformRole,
  UserStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  type CarrierCapabilitiesInput,
  type CarrierDriverInviteInput,
  type CarrierDriverResendInput,
  type CarrierProfileInput,
  type CarrierRegisterInput,
  type CarrierSubmitVerificationInput,
  type CarrierVehicleInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DriverService } from '../driver/driver.service';
import { StripeService } from '../payments/stripe.service';

@Injectable()
export class CarrierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly drivers: DriverService,
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
              where: { status: { in: [ComplianceDocStatus.UPLOADED, ComplianceDocStatus.UNDER_REVIEW, ComplianceDocStatus.APPROVED] } },
              take: 20,
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
    vehicles: Array<{ status: string }>;
    drivers: Array<{ status: string }>;
  }) {
    const activeVehicles = company.vehicles.filter((v) => v.status === 'ACTIVE').length;
    const activeDrivers = company.drivers.filter((d) => d.status === 'ACTIVE').length;
    return activeVehicles >= 1 && activeDrivers >= 1;
  }

  private goNoGo(company: {
    status: CompanyStatus;
    stripeConnectPayoutsEnabled: boolean;
    abn: string | null;
    capabilities: string[];
    serviceRegionCodes: string[];
    vehicles: Array<{ status: string }>;
    drivers: Array<{ status: string }>;
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
    vehicles: Array<{ status: string }>;
    drivers: Array<{ status: string }>;
    complianceDocuments: { docType: ComplianceDocType }[];
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
    if (company.status === CompanyStatus.INFO_REQUESTED) {
      return 'documents';
    }
    if (!company.abn) return 'profile';
    const docs = new Set(company.complianceDocuments.map((d) => d.docType));
    if (
      !docs.has(ComplianceDocType.PUBLIC_LIABILITY) ||
      !docs.has(ComplianceDocType.CARGO_INSURANCE) ||
      !docs.has(ComplianceDocType.RWC)
    ) {
      return 'documents';
    }
    if (!company.stripeConnectPayoutsEnabled) return 'connect';
    // Align with fleetReady / submitForReview — DRAFT fleet does not unlock submit.
    if (company.vehicles.filter((v) => v.status === 'ACTIVE').length < 1) {
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
    const vic = await this.prisma.region.findUnique({ where: { code: 'VIC' } });
    const company = await this.prisma.company.create({
      data: {
        type: CompanyType.CARRIER,
        status: CompanyStatus.DRAFT,
        legalName: input.name,
        email: input.email,
        phone: input.phone,
        homeRegionId: vic?.id,
        serviceRegionCodes: vic ? ['VIC'] : [],
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
    await this.audit.recordPlatform({
      action: AuditAction.CARRIER_REGISTERED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { email: user.email },
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
      vehicles: company.vehicles.map((v) => ({
        id: v.id,
        status: v.status,
        label: v.label,
        registration: v.registration,
        vehicleClass: v.vehicleClass,
        tareKg: v.tareKg,
        gvmKg: v.gvmKg,
        gcmKg: v.gcmKg,
      })),
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
      const account = await this.stripe.createConnectAccount({
        email: user.email,
        businessName: company.legalName,
        metadata: { companyId: company.id },
      });
      accountId = account.id;
      await this.prisma.company.update({
        where: { id: company.id },
        data: { stripeConnectAccountId: accountId },
      });
    }
    const corsRaw = this.config.get('CORS_ORIGINS', { infer: true }) || '';
    const corsOrigins = corsRaw.split(',');
    const secondOrigin = corsOrigins.length > 1 ? corsOrigins[1].trim() : '';
    const adminOrigin = secondOrigin || 'http://localhost:5174';
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

  async addVehicle(principal: AuthenticatedPrincipal, input: CarrierVehicleInput) {
    this.ensureDatabase();
    const user = await this.requireCarrier(principal);
    const company = user.company!;
    if (
      company.status !== CompanyStatus.DRAFT &&
      company.status !== CompanyStatus.INFO_REQUESTED
    ) {
      throw new BadRequestException('Fleet editable only in draft or info-requested');
    }
    const vehicle = await this.prisma.vehicle.create({
      data: {
        companyId: company.id,
        status: VehicleStatus.ACTIVE,
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
    });
    return this.getOnboarding(principal);
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
        'Add at least one ACTIVE vehicle and one ACTIVE driver before submit',
      );
    }
    if (company.serviceRegionCodes.length < 1) {
      throw new BadRequestException('Set service regions before submit');
    }

    const docs = await this.prisma.complianceDocument.findMany({
      where: {
        id: { in: input.documentIds },
        companyId: company.id,
        status: ComplianceDocStatus.UPLOADED,
      },
    });
    if (docs.length !== input.documentIds.length) {
      throw new BadRequestException('All documents must be uploaded for this company');
    }
    const types = new Set(docs.map((d) => d.docType));
    for (const required of [
      ComplianceDocType.PUBLIC_LIABILITY,
      ComplianceDocType.CARGO_INSURANCE,
      ComplianceDocType.RWC,
    ]) {
      if (!types.has(required)) {
        throw new BadRequestException(`Missing required doc: ${required}`);
      }
    }

    const open = await this.prisma.complianceCase.findFirst({
      where: {
        companyId: company.id,
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
        where: { id: { in: input.documentIds } },
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
      metadata: { caseType: 'CARRIER_KYB', documentIds: input.documentIds },
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

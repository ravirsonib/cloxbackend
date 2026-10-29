import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
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
  NotificationType,
  UserStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { hashValue } from '../../common/utils/crypto';
import {
  AuditAction,
  type DriverAcceptInviteInput,
  type DriverProfileInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  hasUsableDriverLicenceDocument,
  USABLE_COMPLIANCE_DOC_STATUSES,
} from '../jobs/assignment-gates';

@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<AppEnv, true>,
    @Optional() private readonly inbox?: InAppNotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  inviteTtlHours() {
    return this.config.get('DRIVER_INVITE_TTL_HOURS', { infer: true });
  }

  inviteBaseUrl() {
    return this.config.get('ADMIN_APP_URL', { infer: true }).replace(/\/$/, '');
  }

  createInviteToken() {
    const raw = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.inviteTtlHours() * 60 * 60 * 1000);
    return { raw, hash: hashValue(raw), expiresAt };
  }

  inviteUrl(rawToken: string) {
    return `${this.inviteBaseUrl()}/driver/invite/${rawToken}`;
  }

  async sendInviteMail(params: {
    email: string;
    name: string;
    companyName: string;
    rawToken: string;
  }) {
    return this.notifications.sendDriverInviteEmail({
      to: params.email,
      driverName: params.name,
      companyName: params.companyName,
      inviteUrl: this.inviteUrl(params.rawToken),
      expiresHours: this.inviteTtlHours(),
    });
  }

  private hasPersonalDetails(driver: {
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    addressLine1: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
  }) {
    return Boolean(
      driver.emergencyContactName?.trim() &&
        driver.emergencyContactPhone?.trim() &&
        driver.addressLine1?.trim() &&
        driver.suburb?.trim() &&
        driver.state?.trim() &&
        driver.postcode?.trim(),
    );
  }

  private wizardStep(
    driver: {
      status: DriverStatus;
      inviteAcceptedAt: Date | null;
      licenceNo: string | null;
      licenceClass: string | null;
      licenceExpiry: Date | null;
      nhvrAcknowledgedAt: Date | null;
      emergencyContactName: string | null;
      emergencyContactPhone: string | null;
      addressLine1: string | null;
      suburb: string | null;
      state: string | null;
      postcode: string | null;
    },
    user: { name: string | null; phone: string | null },
  ) {
    if (driver.status === DriverStatus.ACTIVE) return 'complete';
    if (driver.status === DriverStatus.SUSPENDED) return 'suspended';
    if (!driver.inviteAcceptedAt) return 'accept';
    const personalOk =
      Boolean(user.name?.trim()) &&
      Boolean(user.phone?.trim()) &&
      this.hasPersonalDetails(driver);
    if (
      !personalOk ||
      !driver.licenceNo ||
      !driver.licenceClass ||
      !driver.licenceExpiry ||
      !driver.nhvrAcknowledgedAt
    ) {
      return 'licence';
    }
    return 'complete';
  }

  private goNoGo(
    driver: {
      status: DriverStatus;
      companyId: string | null;
      licenceClass: string | null;
      licenceExpiry: Date | null;
      nhvrAcknowledgedAt: Date | null;
      emergencyContactName: string | null;
      emergencyContactPhone: string | null;
      addressLine1: string | null;
      suburb: string | null;
      state: string | null;
      postcode: string | null;
    },
    opts?: {
      licenceDocumentUploaded?: boolean;
      userName?: string | null;
      userPhone?: string | null;
    },
  ) {
    const linked = Boolean(driver.companyId);
    const licenceOk =
      Boolean(driver.licenceClass) &&
      Boolean(driver.licenceExpiry) &&
      (driver.licenceExpiry as Date) > new Date();
    const nhvrOk = Boolean(driver.nhvrAcknowledgedAt);
    const licenceDocumentUploaded = opts?.licenceDocumentUploaded ?? false;
    const personalDetailsComplete =
      Boolean(opts?.userName?.trim()) &&
      Boolean(opts?.userPhone?.trim()) &&
      this.hasPersonalDetails(driver);
    const active = driver.status === DriverStatus.ACTIVE;
    return {
      companyLinked: linked,
      licenceValid: licenceOk,
      licenceDocumentUploaded,
      nhvrAcknowledged: nhvrOk,
      personalDetailsComplete,
      active,
      // Personal details are mandatory on submitProfile; already-ACTIVE drivers stay assignable.
      canBeAssigned: linked && active && licenceOk && nhvrOk && licenceDocumentUploaded,
      tripApisNote: 'Trip execution APIs return not-assigned until M8',
    };
  }

  private async requireDriver(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'DRIVER') {
      throw new ForbiddenException('Driver principal required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: {
        driver: {
          include: {
            company: { select: { id: true, legalName: true, status: true } },
          },
        },
      },
    });
    if (!user?.driver) {
      throw new NotFoundException('Driver profile not found');
    }
    return user;
  }

  async peekInvite(token: string) {
    this.ensureDatabase();
    const hash = hashValue(token);
    const driver = await this.prisma.driver.findFirst({
      where: { inviteTokenHash: hash },
      include: {
        user: { select: { email: true, name: true } },
        company: { select: { legalName: true } },
      },
    });
    if (!driver) {
      throw new NotFoundException('Invite not found');
    }
    const expired = !driver.inviteExpiresAt || driver.inviteExpiresAt < new Date();
    const consumed = Boolean(driver.inviteAcceptedAt);
    return {
      email: driver.user.email,
      name: driver.user.name,
      companyName: driver.company?.legalName ?? 'Unknown company',
      status: driver.status,
      expired,
      consumed,
      canAccept: !expired && !consumed && driver.status === DriverStatus.INVITED,
    };
  }

  async acceptInvite(input: DriverAcceptInviteInput) {
    this.ensureDatabase();
    const hash = hashValue(input.token);
    const driver = await this.prisma.driver.findFirst({
      where: { inviteTokenHash: hash },
      include: {
        user: true,
        company: { select: { legalName: true } },
      },
    });
    if (!driver) {
      throw new NotFoundException('Invite not found');
    }
    if (driver.inviteAcceptedAt) {
      throw new BadRequestException('Invite already accepted');
    }
    if (!driver.inviteExpiresAt || driver.inviteExpiresAt < new Date()) {
      throw new BadRequestException('Invite expired — ask carrier to resend');
    }
    if (driver.status !== DriverStatus.INVITED) {
      throw new BadRequestException('Invite no longer valid');
    }

    await this.prisma.$transaction([
      this.prisma.driver.update({
        where: { id: driver.id },
        data: {
          inviteAcceptedAt: new Date(),
          inviteTokenHash: null,
          inviteExpiresAt: null,
          status: DriverStatus.PENDING_REVIEW,
        },
      }),
      this.prisma.user.update({
        where: { id: driver.userId },
        data: { status: UserStatus.ACTIVE },
      }),
    ]);

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_INVITE_ACCEPTED,
      actorUserId: driver.userId,
      entityType: 'Driver',
      entityId: driver.id,
      metadata: { email: driver.user.email },
    });

    return {
      email: driver.user.email,
      companyName: driver.company?.legalName ?? 'Unknown company',
      message: 'Invite accepted — request OTP to sign in, then complete licence + NHVR',
      next: 'otp_login',
    };
  }

  async getOnboarding(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const driver = user.driver!;
    const licenceDocumentUploaded = await hasUsableDriverLicenceDocument(
      this.prisma,
      driver.id,
    );
    const goNoGo = this.goNoGo(driver, {
      licenceDocumentUploaded,
      userName: user.name,
      userPhone: user.phone,
    });
    let step = this.wizardStep(driver, { name: user.name, phone: user.phone });
    // Stay on licence until a usable DRIVER_LICENCE file exists (even if fields + NHVR are set).
    if (
      !licenceDocumentUploaded &&
      driver.inviteAcceptedAt &&
      driver.status !== DriverStatus.SUSPENDED &&
      step !== 'accept'
    ) {
      step = 'licence';
    }
    return {
      step,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
      },
      driver: {
        id: driver.id,
        status: driver.status,
        licenceNo: driver.licenceNo,
        licenceClass: driver.licenceClass,
        licenceExpiry: driver.licenceExpiry,
        nhvrAcknowledgedAt: driver.nhvrAcknowledgedAt,
        inviteAcceptedAt: driver.inviteAcceptedAt,
        emergencyContactName: driver.emergencyContactName,
        emergencyContactPhone: driver.emergencyContactPhone,
        addressLine1: driver.addressLine1,
        suburb: driver.suburb,
        state: driver.state,
        postcode: driver.postcode,
      },
      company: driver.company
        ? { id: driver.company.id, legalName: driver.company.legalName, status: driver.company.status }
        : null,
      goNoGo,
    };
  }

  async submitProfile(principal: AuthenticatedPrincipal, input: DriverProfileInput) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const driver = user.driver!;
    if (!driver.companyId) {
      throw new ForbiddenException('Driver must be linked to a transport company');
    }
    if (!driver.inviteAcceptedAt && driver.status === DriverStatus.INVITED) {
      throw new BadRequestException('Accept invite first');
    }

    const expiry =
      input.licenceExpiry.length === 10
        ? new Date(`${input.licenceExpiry}T23:59:59.000Z`)
        : new Date(input.licenceExpiry);
    if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
      throw new BadRequestException('licenceExpiry must be a future date');
    }

    const doc = await this.prisma.complianceDocument.findFirst({
      where: {
        id: input.licenceDocumentId,
        driverId: driver.id,
        docType: ComplianceDocType.DRIVER_LICENCE,
        status: { in: USABLE_COMPLIANCE_DOC_STATUSES },
      },
    });
    if (!doc) {
      throw new BadRequestException({
        message: 'Usable DRIVER_LICENCE document required before activation',
        code: 'DRIVER_LICENCE_DOC_REQUIRED',
      });
    }

    const company = await this.prisma.company.findUnique({
      where: { id: driver.companyId },
      select: {
        id: true,
        status: true,
        homeRegionId: true,
        type: true,
        legalName: true,
      },
    });
    const needsSuperReview =
      company?.type === CompanyType.CARRIER &&
      company.status === CompanyStatus.BID_ELIGIBLE;
    const nextStatus = needsSuperReview
      ? DriverStatus.PENDING_REVIEW
      : DriverStatus.ACTIVE;

    const [updated] = await this.prisma.$transaction([
      this.prisma.driver.update({
        where: { id: driver.id },
        data: {
          licenceNo: input.licenceNo,
          licenceClass: input.licenceClass,
          licenceExpiry: expiry,
          nhvrAcknowledgedAt: new Date(),
          emergencyContactName: input.emergencyContactName,
          emergencyContactPhone: input.emergencyContactPhone,
          addressLine1: input.addressLine1,
          suburb: input.suburb,
          state: input.state,
          postcode: input.postcode,
          status: nextStatus,
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          name: input.name,
          phone: input.phone,
        },
      }),
    ]);

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_PROFILE_SUBMITTED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driver.id,
      metadata: {
        licenceClass: input.licenceClass,
        licenceDocumentId: input.licenceDocumentId,
        status: nextStatus,
        state: input.state,
        postcode: input.postcode,
      },
    });

    if (needsSuperReview && company) {
      await this.attachDriverLicenceToReviewCase(
        company,
        driver.id,
        input.licenceDocumentId,
      );
    } else {
      await this.audit.recordPlatform({
        action: AuditAction.DRIVER_ACTIVATED,
        actorUserId: user.id,
        entityType: 'Driver',
        entityId: updated.id,
        metadata: { auto: true },
      });
    }

    return this.getOnboarding(principal);
  }

  /**
   * Post-KYB driver licence opens/joins CARRIER_DRIVER_LICENCE for Super Admin review.
   * Does not change company BID_ELIGIBLE.
   */
  private async attachDriverLicenceToReviewCase(
    company: {
      id: string;
      homeRegionId: string | null;
      legalName?: string | null;
    },
    driverId: string,
    documentId: string,
  ) {
    let reviewCase = await this.prisma.complianceCase.findFirst({
      where: {
        companyId: company.id,
        caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
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

    let shouldNotifyOps = false;
    if (!reviewCase) {
      reviewCase = await this.prisma.complianceCase.create({
        data: {
          companyId: company.id,
          caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
          status: ComplianceCaseStatus.OPEN,
          regionId: company.homeRegionId,
        },
      });
      shouldNotifyOps = true;
    } else if (reviewCase.status === ComplianceCaseStatus.INFO_REQUESTED) {
      reviewCase = await this.prisma.complianceCase.update({
        where: { id: reviewCase.id },
        data: {
          status: ComplianceCaseStatus.OPEN,
          decisionNote: null,
        },
      });
      shouldNotifyOps = true;
    }

    const orphanLicences = await this.prisma.complianceDocument.findMany({
      where: {
        companyId: company.id,
        docType: ComplianceDocType.DRIVER_LICENCE,
        driverId: { not: null },
        status: {
          in: [ComplianceDocStatus.UPLOADED, ComplianceDocStatus.UNDER_REVIEW],
        },
        OR: [{ caseId: null }, { id: documentId }, { driverId }],
      },
      select: { id: true },
    });
    const ids = [...new Set([documentId, ...orphanLicences.map((d) => d.id)])];
    await this.prisma.complianceDocument.updateMany({
      where: { id: { in: ids } },
      data: {
        caseId: reviewCase.id,
        status: ComplianceDocStatus.UNDER_REVIEW,
      },
    });

    if (shouldNotifyOps && this.inbox) {
      void this.inbox.notifyComplianceCaseToOps({
        caseId: reviewCase.id,
        regionId: reviewCase.regionId ?? company.homeRegionId,
        type: NotificationType.DRIVER_LICENCE_REVIEW_OPENED,
        title: `Licence review: ${company.legalName || 'Carrier'}`,
        body: 'Driver licence submitted for Ops review.',
      });
    }
  }

  async getAssignability(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const licenceDocumentUploaded = await hasUsableDriverLicenceDocument(
      this.prisma,
      user.driver!.id,
    );
    const goNoGo = this.goNoGo(user.driver!, {
      licenceDocumentUploaded,
      userName: user.name,
      userPhone: user.phone,
    });
    return {
      canBeAssigned: goNoGo.canBeAssigned,
      goNoGo,
      reason: !goNoGo.companyLinked
        ? 'ORPHAN_DRIVER'
        : !goNoGo.active
          ? 'DRIVER_NOT_ACTIVE'
          : !goNoGo.licenceValid
            ? 'LICENCE_INVALID'
            : !goNoGo.nhvrAcknowledged
              ? 'NHVR_REQUIRED'
              : !goNoGo.licenceDocumentUploaded
                ? 'DRIVER_LICENCE_DOC_REQUIRED'
                : null,
    };
  }

  /** Used by expiry watchdog */
  async suspendExpiredLicences() {
    if (!this.prisma.isConnected()) {
      return { suspended: 0 };
    }
    const now = new Date();
    const expired = await this.prisma.driver.findMany({
      where: {
        status: DriverStatus.ACTIVE,
        licenceExpiry: { lte: now },
      },
    });
    let suspended = 0;
    for (const d of expired) {
      await this.prisma.driver.update({
        where: { id: d.id },
        data: { status: DriverStatus.SUSPENDED },
      });
      await this.audit.recordPlatform({
        action: AuditAction.DRIVER_SUSPENDED,
        entityType: 'Driver',
        entityId: d.id,
        metadata: { reason: 'licence_expiry', licenceExpiry: d.licenceExpiry },
      });
      suspended += 1;
    }
    return { suspended };
  }
}

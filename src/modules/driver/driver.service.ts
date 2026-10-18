import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DriverStatus, UserStatus } from '@prisma/client';
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
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<AppEnv, true>,
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

  private wizardStep(driver: {
    status: DriverStatus;
    inviteAcceptedAt: Date | null;
    licenceNo: string | null;
    licenceClass: string | null;
    licenceExpiry: Date | null;
    nhvrAcknowledgedAt: Date | null;
  }) {
    if (driver.status === DriverStatus.ACTIVE) return 'complete';
    if (driver.status === DriverStatus.SUSPENDED) return 'suspended';
    if (!driver.inviteAcceptedAt) return 'accept';
    if (!driver.licenceNo || !driver.licenceClass || !driver.licenceExpiry || !driver.nhvrAcknowledgedAt) {
      return 'licence';
    }
    return 'complete';
  }

  private goNoGo(driver: {
    status: DriverStatus;
    companyId: string | null;
    licenceClass: string | null;
    licenceExpiry: Date | null;
    nhvrAcknowledgedAt: Date | null;
  }) {
    const linked = Boolean(driver.companyId);
    const licenceOk =
      Boolean(driver.licenceClass) &&
      Boolean(driver.licenceExpiry) &&
      (driver.licenceExpiry as Date) > new Date();
    const nhvrOk = Boolean(driver.nhvrAcknowledgedAt);
    const active = driver.status === DriverStatus.ACTIVE;
    return {
      companyLinked: linked,
      licenceValid: licenceOk,
      nhvrAcknowledged: nhvrOk,
      active,
      canBeAssigned: linked && active && licenceOk && nhvrOk,
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
    const goNoGo = this.goNoGo(driver);
    return {
      step: this.wizardStep(driver),
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

    if (input.licenceDocumentId) {
      const doc = await this.prisma.complianceDocument.findFirst({
        where: {
          id: input.licenceDocumentId,
          driverId: driver.id,
        },
      });
      if (!doc) {
        throw new BadRequestException('licenceDocumentId not found for this driver');
      }
    }

    // Phase 1: auto-activate after licence + NHVR (no separate Ops queue for drivers)
    const updated = await this.prisma.driver.update({
      where: { id: driver.id },
      data: {
        licenceNo: input.licenceNo,
        licenceClass: input.licenceClass,
        licenceExpiry: expiry,
        nhvrAcknowledgedAt: new Date(),
        status: DriverStatus.ACTIVE,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_PROFILE_SUBMITTED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: driver.id,
      metadata: {
        licenceClass: input.licenceClass,
        licenceDocumentId: input.licenceDocumentId ?? null,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_ACTIVATED,
      actorUserId: user.id,
      entityType: 'Driver',
      entityId: updated.id,
      metadata: { auto: true },
    });

    return this.getOnboarding(principal);
  }

  async getAssignability(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const goNoGo = this.goNoGo(user.driver!);
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

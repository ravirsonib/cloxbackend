import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminUserStatus,
  CompanyType,
  type Prisma,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ScopeService } from '../../common/services/scope.service';
import { hashValue } from '../../common/utils/crypto';
import {
  AdminRole,
  AuditAction,
  type CreateCompanyInviteInput,
  type CreateProspectInput,
  type GrowthMyCompaniesQuery,
  type ProspectListQuery,
  type ReassignCompanyReferrerInput,
  type UpdateProspectInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class GrowthService {
  private readonly logger = new Logger(GrowthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly scope: ScopeService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private inviteTtlHours() {
    return Number(this.config.get('DRIVER_INVITE_TTL_HOURS', { infer: true }) ?? 72);
  }

  private createInviteToken() {
    const raw = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.inviteTtlHours() * 60 * 60 * 1000);
    return { raw, hash: hashValue(raw), expiresAt };
  }

  private registerUrl(companyType: CompanyType, rawToken: string) {
    const base = (this.config.get('ADMIN_APP_URL', { infer: true }) ?? 'http://localhost:5174').replace(
      /\/$/,
      '',
    );
    const path = companyType === CompanyType.SENDER ? 'register/sender' : 'register/carrier';
    return `${base}/${path}?invite=${encodeURIComponent(rawToken)}`;
  }

  private requireActiveLocal(principal: AuthenticatedPrincipal) {
    this.scope.assertAdmin(principal);
    if (principal.role !== AdminRole.LOCAL_BDE) {
      throw new ForbiddenException('Active Local BDE required');
    }
    if (principal.adminStatus !== AdminUserStatus.ACTIVE) {
      throw new ForbiddenException('Local BDE must be ACTIVE to manage growth');
    }
  }

  private async localScopeIds(adminUserId: string) {
    const scopes = await this.prisma.adminScope.findMany({
      where: { adminUserId },
      include: {
        region: { select: { id: true, code: true } },
        localTerritory: { select: { id: true, code: true, name: true } },
      },
    });
    const region = scopes.find((s) => s.region)?.region ?? null;
    const territory = scopes.find((s) => s.localTerritory)?.localTerritory ?? null;
    return { region, territory };
  }

  async createInvite(principal: AuthenticatedPrincipal, input: CreateCompanyInviteInput) {
    this.ensureDatabase();
    this.requireActiveLocal(principal);

    if (input.prospectId) {
      const prospect = await this.prisma.prospect.findUnique({ where: { id: input.prospectId } });
      if (!prospect || prospect.ownerAdminUserId !== principal.id) {
        throw new NotFoundException('Prospect not found');
      }
      if (prospect.companyType !== input.companyType) {
        throw new BadRequestException('Prospect company type does not match invite');
      }
    }

    const { region, territory } = await this.localScopeIds(principal.id);
    const token = this.createInviteToken();
    const invite = await this.prisma.companyInvite.create({
      data: {
        tokenHash: token.hash,
        expiresAt: token.expiresAt,
        invitedByAdminUserId: principal.id,
        companyType: input.companyType,
        email: input.email,
        legalNameHint: input.legalNameHint,
        homeRegionId: region?.id ?? null,
        localTerritoryId: territory?.id ?? null,
        prospectId: input.prospectId,
      },
    });

    if (input.prospectId) {
      await this.prisma.prospect.update({
        where: { id: input.prospectId },
        data: { stage: 'INVITED', email: input.email },
      });
    }

    const inviteUrl = this.registerUrl(input.companyType, token.raw);
    const mail = await this.notifications.sendCompanyInviteEmail({
      to: input.email,
      companyType: input.companyType,
      legalNameHint: input.legalNameHint,
      territoryLabel: territory ? `${territory.code} · ${territory.name}` : region?.code ?? null,
      inviteUrl,
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_INVITE_SENT,
      actorAdminId: principal.id,
      entityType: 'CompanyInvite',
      entityId: invite.id,
      metadata: {
        companyType: input.companyType,
        email: input.email,
        prospectId: input.prospectId ?? null,
        mailSkipped: mail.skipped === true,
      },
    });

    return {
      id: invite.id,
      companyType: invite.companyType,
      email: invite.email,
      legalNameHint: invite.legalNameHint,
      expiresAt: invite.expiresAt,
      inviteUrl,
      mailSkipped: mail.skipped === true,
      ...(this.config.get('NODE_ENV', { infer: true }) !== 'production'
        ? { debugToken: token.raw }
        : {}),
    };
  }

  async resendInvite(principal: AuthenticatedPrincipal, inviteId: string) {
    this.ensureDatabase();
    this.requireActiveLocal(principal);

    const existing = await this.prisma.companyInvite.findUnique({ where: { id: inviteId } });
    if (!existing || existing.invitedByAdminUserId !== principal.id) {
      throw new NotFoundException('Invite not found');
    }
    if (existing.acceptedAt) {
      throw new BadRequestException('Invite already accepted');
    }

    const { region, territory } = await this.localScopeIds(principal.id);
    const token = this.createInviteToken();
    const invite = await this.prisma.companyInvite.update({
      where: { id: inviteId },
      data: {
        tokenHash: token.hash,
        expiresAt: token.expiresAt,
        homeRegionId: region?.id ?? existing.homeRegionId,
        localTerritoryId: territory?.id ?? existing.localTerritoryId,
      },
    });

    const inviteUrl = this.registerUrl(invite.companyType, token.raw);
    const mail = await this.notifications.sendCompanyInviteEmail({
      to: invite.email,
      companyType: invite.companyType,
      legalNameHint: invite.legalNameHint,
      territoryLabel: territory ? `${territory.code} · ${territory.name}` : region?.code ?? null,
      inviteUrl,
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_INVITE_RESENT,
      actorAdminId: principal.id,
      entityType: 'CompanyInvite',
      entityId: invite.id,
      metadata: { email: invite.email, mailSkipped: mail.skipped === true },
    });

    return {
      id: invite.id,
      companyType: invite.companyType,
      email: invite.email,
      expiresAt: invite.expiresAt,
      inviteUrl,
      mailSkipped: mail.skipped === true,
      ...(this.config.get('NODE_ENV', { infer: true }) !== 'production'
        ? { debugToken: token.raw }
        : {}),
    };
  }

  async listInvites(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    this.requireActiveLocal(principal);
    const rows = await this.prisma.companyInvite.findMany({
      where: { invitedByAdminUserId: principal.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        companyType: true,
        email: true,
        legalNameHint: true,
        expiresAt: true,
        acceptedAt: true,
        companyId: true,
        prospectId: true,
        createdAt: true,
      },
    });
    return { items: rows };
  }

  async peekInvite(token: string) {
    this.ensureDatabase();
    const invite = await this.prisma.companyInvite.findUnique({
      where: { tokenHash: hashValue(token.trim()) },
      include: {
        invitedByAdminUser: { select: { name: true, email: true } },
      },
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw new NotFoundException('Invite not found or expired');
    }
    return {
      companyType: invite.companyType,
      email: invite.email,
      legalNameHint: invite.legalNameHint,
      expiresAt: invite.expiresAt,
      inviterName: invite.invitedByAdminUser.name,
    };
  }

  async listMyCompanies(principal: AuthenticatedPrincipal, query: GrowthMyCompaniesQuery) {
    this.ensureDatabase();
    this.requireActiveLocal(principal);

    const where: Prisma.CompanyWhereInput = {
      referredByAdminUserId: principal.id,
      type: query.type ?? { in: [CompanyType.SENDER, CompanyType.CARRIER] },
    };
    if (query.q) {
      const q = query.q;
      where.OR = [
        { legalName: { contains: q, mode: 'insensitive' } },
        { tradingName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          legalName: true,
          tradingName: true,
          email: true,
          phone: true,
          abn: true,
          referredAt: true,
          createdAt: true,
          homeRegion: { select: { code: true, name: true } },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    return {
      items: rows,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async createProspect(principal: AuthenticatedPrincipal, input: CreateProspectInput) {
    this.ensureDatabase();
    this.requireActiveLocal(principal);

    const prospect = await this.prisma.prospect.create({
      data: {
        ownerAdminUserId: principal.id,
        companyType: input.companyType,
        legalName: input.legalName,
        contactName: input.contactName,
        email: input.email,
        phone: input.phone,
        notes: input.notes,
        stage: input.stage ?? 'LEAD',
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.PROSPECT_CREATED,
      actorAdminId: principal.id,
      entityType: 'Prospect',
      entityId: prospect.id,
      metadata: { companyType: prospect.companyType, stage: prospect.stage },
    });

    return prospect;
  }

  async listProspects(principal: AuthenticatedPrincipal, query: ProspectListQuery) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);

    const where: Prisma.ProspectWhereInput = {};
    if (principal.role === AdminRole.LOCAL_BDE) {
      this.requireActiveLocal(principal);
      where.ownerAdminUserId = principal.id;
    } else if (principal.role === AdminRole.STATE_MASTER) {
      const regions = principal.regionCodes;
      if (regions.length < 1) {
        return { items: [], page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1 };
      }
      where.ownerAdminUser = {
        scopes: { some: { region: { code: { in: regions } } } },
      };
    } else if (principal.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Ops admin required');
    }

    if (query.stage) where.stage = query.stage;
    if (query.companyType) where.companyType = query.companyType;
    if (query.q) {
      const q = query.q;
      where.OR = [
        { legalName: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.prospect.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: query.pageSize,
        include: {
          ownerAdminUser: { select: { id: true, name: true, email: true } },
          company: { select: { id: true, status: true, legalName: true } },
        },
      }),
      this.prisma.prospect.count({ where }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async getProspect(principal: AuthenticatedPrincipal, id: string) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);
    const prospect = await this.prisma.prospect.findUnique({
      where: { id },
      include: {
        ownerAdminUser: { select: { id: true, name: true, email: true } },
        company: { select: { id: true, status: true, legalName: true, type: true } },
        invites: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            email: true,
            expiresAt: true,
            acceptedAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!prospect) throw new NotFoundException('Prospect not found');

    if (principal.role === AdminRole.LOCAL_BDE) {
      if (prospect.ownerAdminUserId !== principal.id) {
        throw new ForbiddenException('Outside your book of business');
      }
    } else if (principal.role === AdminRole.STATE_MASTER) {
      const ownerScopes = await this.prisma.adminScope.findMany({
        where: { adminUserId: prospect.ownerAdminUserId },
        include: { region: { select: { code: true } } },
      });
      const codes = ownerScopes.map((s) => s.region?.code).filter(Boolean) as string[];
      if (!codes.some((c) => principal.regionCodes.includes(c))) {
        throw new ForbiddenException('Outside admin scope (region)');
      }
    } else if (principal.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Ops admin required');
    }

    return prospect;
  }

  async updateProspect(
    principal: AuthenticatedPrincipal,
    id: string,
    input: UpdateProspectInput,
  ) {
    this.ensureDatabase();
    this.requireActiveLocal(principal);
    const existing = await this.prisma.prospect.findUnique({ where: { id } });
    if (!existing || existing.ownerAdminUserId !== principal.id) {
      throw new NotFoundException('Prospect not found');
    }

    const prospect = await this.prisma.prospect.update({
      where: { id },
      data: {
        legalName: input.legalName,
        contactName: input.contactName === undefined ? undefined : input.contactName,
        email: input.email === undefined ? undefined : input.email,
        phone: input.phone === undefined ? undefined : input.phone,
        notes: input.notes === undefined ? undefined : input.notes,
        stage: input.stage,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.PROSPECT_UPDATED,
      actorAdminId: principal.id,
      entityType: 'Prospect',
      entityId: prospect.id,
      metadata: { stage: prospect.stage },
    });

    return prospect;
  }

  async reassignReferrer(
    principal: AuthenticatedPrincipal,
    companyId: string,
    input: ReassignCompanyReferrerInput,
  ) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);
    if (
      principal.role !== AdminRole.SUPER_ADMIN &&
      principal.role !== AdminRole.STATE_MASTER
    ) {
      throw new ForbiddenException('Super or State Master required to reassign referrer');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { homeRegion: { select: { code: true } } },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.type !== CompanyType.SENDER && company.type !== CompanyType.CARRIER) {
      throw new BadRequestException('Only sender/carrier companies can be reassigned');
    }

    if (principal.role === AdminRole.STATE_MASTER) {
      const regionCode = company.homeRegion?.code;
      if (!regionCode || !principal.regionCodes.includes(regionCode)) {
        throw new ForbiddenException('Outside admin scope (region)');
      }
    }

    let nextReferrerId: string | null = input.adminUserId;
    if (nextReferrerId) {
      const target = await this.prisma.adminUser.findUnique({
        where: { id: nextReferrerId },
        include: {
          scopes: { include: { region: { select: { code: true } } } },
        },
      });
      if (
        !target ||
        target.role !== AdminRole.LOCAL_BDE ||
        target.status !== AdminUserStatus.ACTIVE
      ) {
        throw new BadRequestException('Target must be an ACTIVE Local BDE');
      }
      if (principal.role === AdminRole.STATE_MASTER) {
        const targetRegions = target.scopes
          .map((s) => s.region?.code)
          .filter(Boolean) as string[];
        if (!targetRegions.some((c) => principal.regionCodes.includes(c))) {
          throw new ForbiddenException('Target Local BDE is outside your state');
        }
      }
    }

    const fromId = company.referredByAdminUserId;
    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: {
        referredByAdminUserId: nextReferrerId,
        referredAt: company.referredAt ?? (nextReferrerId ? new Date() : null),
      },
      include: {
        referredByAdminUser: { select: { id: true, name: true, email: true } },
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_REFERRER_REASSIGNED,
      actorAdminId: principal.id,
      entityType: 'Company',
      entityId: companyId,
      metadata: {
        fromAdminUserId: fromId,
        toAdminUserId: nextReferrerId,
      },
    });

    this.logger.log(
      `Company ${companyId} referrer ${fromId ?? 'HQ'} → ${nextReferrerId ?? 'HQ'} by ${principal.id}`,
    );

    return {
      id: updated.id,
      referredByAdminUserId: updated.referredByAdminUserId,
      referredAt: updated.referredAt,
      referredBy: updated.referredByAdminUser,
    };
  }

  /** Super/State: company referrer summary for detail UI. */
  async getCompanyReferrer(principal: AuthenticatedPrincipal, companyId: string) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);
    if (
      principal.role !== AdminRole.SUPER_ADMIN &&
      principal.role !== AdminRole.STATE_MASTER
    ) {
      throw new ForbiddenException('Super or State Master required');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        type: true,
        legalName: true,
        referredByAdminUserId: true,
        referredAt: true,
        homeRegion: { select: { code: true } },
        referredByAdminUser: { select: { id: true, name: true, email: true, status: true } },
      },
    });
    if (!company) throw new NotFoundException('Company not found');

    if (principal.role === AdminRole.STATE_MASTER) {
      const regionCode = company.homeRegion?.code;
      if (!regionCode || !principal.regionCodes.includes(regionCode)) {
        throw new ForbiddenException('Outside admin scope (region)');
      }
    }

    return company;
  }

  async listLocalBdesForReassign(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);
    if (
      principal.role !== AdminRole.SUPER_ADMIN &&
      principal.role !== AdminRole.STATE_MASTER
    ) {
      throw new ForbiddenException('Super or State Master required');
    }

    const where: Prisma.AdminUserWhereInput = {
      role: AdminRole.LOCAL_BDE,
      status: AdminUserStatus.ACTIVE,
    };
    if (principal.role === AdminRole.STATE_MASTER) {
      where.scopes = { some: { region: { code: { in: principal.regionCodes } } } };
    }

    const items = await this.prisma.adminUser.findMany({
      where,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        scopes: {
          select: {
            localTerritory: { select: { code: true, name: true } },
            region: { select: { code: true } },
          },
        },
      },
    });

    return {
      items: items.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        territoryCode: a.scopes.find((s) => s.localTerritory)?.localTerritory?.code ?? null,
        regionCode: a.scopes.find((s) => s.region)?.region?.code ?? null,
      })),
    };
  }
}

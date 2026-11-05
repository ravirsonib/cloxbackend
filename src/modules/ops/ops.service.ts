import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import {
  AdminRole,
  AdminScopeType,
  AdminUserStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
  DisputeStatus,
  JobStatus,
  LeadStatus,
  NotificationType,
  ProspectStage,
} from '@prisma/client';
import {
  AuditAction,
  type AddBdeCoachingNoteInput,
  type AdminAcceptInviteInput,
  type BdeTeamListResponse,
  type BdeTeamMemberDetail,
  type BdeTeamMemberSummary,
  type InviteAdminInput,
  type OpsDashboardStatsResponse,
  type PartnerOnboardingSubmitInput,
  type PartnerOnboardingUpdateInput,
  type ResendAdminInviteInput,
} from '../../shared/types';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { AppEnv } from '../../config/env.validation';
import { hashValue } from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';

const PARTNER_REQUIRED_DOCS: ComplianceDocType[] = [
  ComplianceDocType.ABN_EXTRACT,
  ComplianceDocType.GOVERNMENT_ID,
  ComplianceDocType.MASTER_ADMIN_AGREEMENT,
];

type PartnerProfileJson = {
  corporateAddress?: string;
  networkExperience?: string;
  executionStrategy?: string;
};

const ONBOARDING_STUCK_STATUSES: CompanyStatus[] = [
  CompanyStatus.DRAFT,
  CompanyStatus.PENDING_VERIFICATION,
  CompanyStatus.PENDING_COMPLIANCE_DOCS,
  CompanyStatus.PENDING_REVIEW,
  CompanyStatus.INFO_REQUESTED,
  CompanyStatus.PENDING_SETTLEMENT_SETUP,
  CompanyStatus.PENDING_FLEET_READINESS,
  CompanyStatus.PENDING_PAYMENT,
];

@Injectable()
export class OpsService {
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

  private inviteTtlHours() {
    return Number(this.config.get('DRIVER_INVITE_TTL_HOURS', { infer: true }) ?? 72);
  }

  private createInviteToken() {
    const raw = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.inviteTtlHours() * 60 * 60 * 1000);
    return { raw, hash: hashValue(raw), expiresAt };
  }

  private inviteUrl(rawToken: string) {
    const base = (this.config.get('ADMIN_APP_URL', { infer: true }) ?? 'http://localhost:5174').replace(
      /\/$/,
      '',
    );
    return `${base}/admin/invite/${rawToken}`;
  }

  private mapAdmin(admin: {
    id: string;
    email: string;
    name: string | null;
    phone: string | null;
    role: AdminRole;
    status: AdminUserStatus;
    active: boolean;
    companyId: string | null;
    leadId: string | null;
    inviteExpiresAt: Date | null;
    inviteAcceptedAt: Date | null;
    declarationAccuracy: boolean;
    declarationNda: boolean;
    declarationNonCompete: boolean;
    profileJson: unknown;
    scopes?: Array<{
      scopeType: AdminScopeType;
      region?: { code: string } | null;
      localTerritory?: { code: string } | null;
    }>;
    company?: {
      id: string;
      legalName: string;
      abn: string | null;
      acn: string | null;
      status: CompanyStatus;
      email: string | null;
      phone: string | null;
      invoiceAddressLine1: string | null;
    } | null;
  }) {
    const profile = (admin.profileJson ?? {}) as PartnerProfileJson;
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      phone: admin.phone,
      role: admin.role,
      status: admin.status,
      active: admin.active,
      companyId: admin.companyId,
      leadId: admin.leadId,
      inviteExpiresAt: admin.inviteExpiresAt,
      inviteAcceptedAt: admin.inviteAcceptedAt,
      declarations: {
        accuracy: admin.declarationAccuracy,
        nda: admin.declarationNda,
        nonCompete: admin.declarationNonCompete,
      },
      profile: {
        corporateAddress: profile.corporateAddress ?? admin.company?.invoiceAddressLine1 ?? null,
        networkExperience: profile.networkExperience ?? null,
        executionStrategy: profile.executionStrategy ?? null,
      },
      company: admin.company
        ? {
            id: admin.company.id,
            legalName: admin.company.legalName,
            abn: admin.company.abn,
            acn: admin.company.acn,
            status: admin.company.status,
            email: admin.company.email,
            phone: admin.company.phone,
          }
        : null,
      scopes: (admin.scopes ?? []).map((s) => ({
        scopeType: s.scopeType,
        regionCode: s.region?.code ?? null,
        territoryCode: s.localTerritory?.code ?? null,
      })),
      requiredDocs: [...PARTNER_REQUIRED_DOCS],
    };
  }

  /**
   * Super invites State Master / Local BDE.
   * Creates INVITED AdminUser + ADMIN_PARTNER company + scopes; does NOT activate ops access.
   * `POST /ops/admins` (legacy provision) delegates here.
   */
  async inviteAdmin(actor: AuthenticatedPrincipal, input: InviteAdminInput) {
    this.ensureDatabase();
    if (actor.kind !== 'admin' || actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required');
    }

    const region = await this.prisma.region.findUnique({
      where: { code: input.regionCode },
    });
    if (!region) {
      throw new NotFoundException(`Unknown region ${input.regionCode}`);
    }

    let territoryId: string | null = null;
    if (input.role === AdminRole.LOCAL_BDE) {
      if (!input.territoryCode) {
        throw new BadRequestException('territoryCode required for LOCAL_BDE');
      }
      const territory = await this.prisma.localTerritory.findUnique({
        where: {
          regionId_code: { regionId: region.id, code: input.territoryCode },
        },
      });
      if (!territory) {
        throw new NotFoundException(
          `Unknown territory ${input.territoryCode} in ${input.regionCode}`,
        );
      }
      territoryId = territory.id;
    }

    if (input.leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: input.leadId } });
      if (!lead) throw new NotFoundException('Lead not found');
      const expectedType =
        input.role === AdminRole.STATE_MASTER ? 'EOI_STATE_MASTER' : 'EOI_LOCAL_BDE';
      if (lead.type !== expectedType) {
        throw new BadRequestException('Lead type does not match invite role');
      }
    }

    const existing = await this.prisma.adminUser.findUnique({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException('Admin with this email already exists');
    }

    const token = this.createInviteToken();
    const legalName =
      input.companyName?.trim() ||
      input.name?.trim() ||
      `${input.role === AdminRole.STATE_MASTER ? 'State Master' : 'Local BDE'} — ${input.email}`;

    const admin = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          type: CompanyType.ADMIN_PARTNER,
          status: CompanyStatus.DRAFT,
          legalName,
          email: input.email,
          phone: input.phone ?? null,
          homeRegionId: region.id,
        },
      });

      const created = await tx.adminUser.create({
        data: {
          email: input.email,
          name: input.name ?? null,
          phone: input.phone ?? null,
          role: input.role,
          status: AdminUserStatus.INVITED,
          active: false,
          companyId: company.id,
          leadId: input.leadId ?? null,
          inviteTokenHash: token.hash,
          inviteExpiresAt: token.expiresAt,
          scopes: {
            create: {
              scopeType:
                input.role === AdminRole.STATE_MASTER
                  ? AdminScopeType.STATE
                  : AdminScopeType.LOCAL,
              regionId: region.id,
              localTerritoryId: territoryId,
            },
          },
        },
        include: {
          scopes: {
            include: { region: true, localTerritory: true },
          },
          company: true,
        },
      });

      if (input.leadId) {
        await tx.lead.update({
          where: { id: input.leadId },
          data: { status: LeadStatus.INVITED },
        });
      }

      return created;
    });

    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_INVITED,
      actorAdminId: actor.id,
      entityType: 'AdminUser',
      entityId: admin.id,
      metadata: {
        email: admin.email,
        role: admin.role,
        regionCode: input.regionCode,
        territoryCode: input.territoryCode ?? null,
        leadId: input.leadId ?? null,
      },
    });

    const inviteUrl = this.inviteUrl(token.raw);
    const mail = await this.notifications.sendAdminInviteEmail({
      to: admin.email,
      role: admin.role,
      name: admin.name,
      regionCode: input.regionCode,
      territoryCode: input.territoryCode ?? null,
      inviteUrl,
    });

    return {
      ...this.mapAdmin(admin),
      invite: {
        inviteUrl,
        expiresAt: token.expiresAt.toISOString(),
        mailSkipped: Boolean(mail?.skipped),
        debugToken:
          this.config.get('NODE_ENV', { infer: true }) !== 'production' ? token.raw : undefined,
      },
    };
  }

  /** @deprecated Alias — invite-only; never activates immediately. */
  async provisionAdmin(actor: AuthenticatedPrincipal, input: InviteAdminInput) {
    return this.inviteAdmin(actor, input);
  }

  async resendAdminInvite(actor: AuthenticatedPrincipal, input: ResendAdminInviteInput) {
    this.ensureDatabase();
    if (actor.kind !== 'admin' || actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required');
    }
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: input.email },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
        company: true,
      },
    });
    if (!admin) throw new NotFoundException('Admin invite not found');
    if (
      admin.status !== AdminUserStatus.INVITED &&
      admin.status !== AdminUserStatus.PENDING_DOCS
    ) {
      throw new BadRequestException('Invite can only be resent while INVITED or PENDING_DOCS');
    }
    if (admin.inviteAcceptedAt && admin.status !== AdminUserStatus.PENDING_DOCS) {
      throw new BadRequestException('Invite already accepted');
    }

    const token = this.createInviteToken();
    const updated = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        inviteTokenHash: token.hash,
        inviteExpiresAt: token.expiresAt,
        status: AdminUserStatus.INVITED,
        active: false,
        inviteAcceptedAt: null,
      },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
        company: true,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_INVITE_RESENT,
      actorAdminId: actor.id,
      entityType: 'AdminUser',
      entityId: admin.id,
      metadata: { email: admin.email },
    });

    const inviteUrl = this.inviteUrl(token.raw);
    const regionCode = updated.scopes[0]?.region?.code ?? null;
    const territoryCode = updated.scopes[0]?.localTerritory?.code ?? null;
    const mail = await this.notifications.sendAdminInviteEmail({
      to: updated.email,
      role: updated.role,
      name: updated.name,
      regionCode,
      territoryCode,
      inviteUrl,
    });

    return {
      ...this.mapAdmin(updated),
      invite: {
        inviteUrl,
        expiresAt: token.expiresAt.toISOString(),
        mailSkipped: Boolean(mail?.skipped),
        debugToken:
          this.config.get('NODE_ENV', { infer: true }) !== 'production' ? token.raw : undefined,
      },
    };
  }

  async listPartnerAdmins(actor: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (actor.kind !== 'admin' || actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required');
    }
    const openCaseStatuses: ComplianceCaseStatus[] = [
      ComplianceCaseStatus.OPEN,
      ComplianceCaseStatus.INFO_REQUESTED,
      ComplianceCaseStatus.ESCALATED,
    ];
    const rows = await this.prisma.adminUser.findMany({
      where: {
        role: { in: [AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE] },
      },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
        company: {
          include: {
            complianceCases: {
              where: { status: { in: openCaseStatuses } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, status: true, caseType: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((r) => ({
        ...this.mapAdmin(r),
        openCase: r.company?.complianceCases[0] ?? null,
      })),
    };
  }

  /** Regions + nested territories for Super invite / scope pickers. */
  async listGeography(actor: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (actor.kind !== 'admin' || actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required');
    }
    const regions = await this.prisma.region.findMany({
      orderBy: { code: 'asc' },
      include: {
        territories: {
          orderBy: { code: 'asc' },
          select: {
            id: true,
            code: true,
            name: true,
            enabled: true,
          },
        },
      },
    });
    return {
      regions: regions.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        enabled: r.enabled,
        territories: r.territories,
      })),
    };
  }

  async setRegionEnabled(actor: AuthenticatedPrincipal, code: string, enabled: boolean) {
    this.ensureDatabase();
    if (actor.kind !== 'admin' || actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required');
    }
    const normalizedCode = code.trim().toUpperCase();
    const region = await this.prisma.region.findUnique({
      where: { code: normalizedCode },
    });
    if (!region) {
      throw new NotFoundException(`Region '${normalizedCode}' not found`);
    }
    const updated = await this.prisma.region.update({
      where: { code: normalizedCode },
      data: { enabled },
    });
    await this.audit.recordPlatform({
      action: AuditAction.GEOGRAPHY_REGION_UPDATED,
      actorAdminId: actor.id,
      entityType: 'Region',
      entityId: updated.id,
      metadata: { code: updated.code, name: updated.name, enabled },
    });
    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      enabled: updated.enabled,
    };
  }

  async peekAdminInvite(token: string) {
    this.ensureDatabase();
    const hash = hashValue(token);
    const admin = await this.prisma.adminUser.findFirst({
      where: { inviteTokenHash: hash },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
        company: true,
      },
    });
    if (!admin) throw new NotFoundException('Invite not found');
    const expired = !admin.inviteExpiresAt || admin.inviteExpiresAt < new Date();
    const consumed = Boolean(admin.inviteAcceptedAt);
    return {
      email: admin.email,
      name: admin.name,
      role: admin.role,
      status: admin.status,
      regionCode: admin.scopes[0]?.region?.code ?? null,
      territoryCode: admin.scopes[0]?.localTerritory?.code ?? null,
      companyName: admin.company?.legalName ?? null,
      expired,
      consumed,
      canAccept: !expired && !consumed && admin.status === AdminUserStatus.INVITED,
    };
  }

  async acceptAdminInvite(input: AdminAcceptInviteInput) {
    this.ensureDatabase();
    const hash = hashValue(input.token);
    const admin = await this.prisma.adminUser.findFirst({
      where: { inviteTokenHash: hash },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
        company: true,
      },
    });
    if (!admin) throw new NotFoundException('Invite not found');
    if (admin.inviteAcceptedAt) {
      throw new BadRequestException('Invite already accepted');
    }
    if (!admin.inviteExpiresAt || admin.inviteExpiresAt < new Date()) {
      throw new BadRequestException('Invite expired — ask Super Admin to resend');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          inviteAcceptedAt: new Date(),
          status: AdminUserStatus.PENDING_DOCS,
          active: false,
        },
        include: {
          scopes: { include: { region: true, localTerritory: true } },
          company: true,
        },
      });
      if (next.companyId) {
        await tx.company.update({
          where: { id: next.companyId },
          data: { status: CompanyStatus.PENDING_COMPLIANCE_DOCS },
        });
      }
      if (next.leadId) {
        await tx.lead.update({
          where: { id: next.leadId },
          data: { status: LeadStatus.KYB_PENDING },
        });
      }
      return next;
    });

    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_INVITE_ACCEPTED,
      actorAdminId: updated.id,
      entityType: 'AdminUser',
      entityId: updated.id,
      metadata: { email: updated.email, role: updated.role },
    });

    return {
      email: updated.email,
      role: updated.role,
      status: updated.status,
      next: 'otp_login' as const,
    };
  }

  private async requirePartnerSelf(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'admin') {
      throw new ForbiddenException('Admin partner required');
    }
    if (
      principal.role !== AdminRole.STATE_MASTER &&
      principal.role !== AdminRole.LOCAL_BDE
    ) {
      throw new ForbiddenException('State Master or Local BDE required');
    }
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: principal.id },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
        company: true,
      },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    if (
      admin.status === AdminUserStatus.REJECTED ||
      admin.status === AdminUserStatus.SUSPENDED
    ) {
      throw new ForbiddenException('Account is not eligible for onboarding');
    }
    return admin;
  }

  async getPartnerOnboarding(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const admin = await this.requirePartnerSelf(principal);
    const documents = admin.companyId
      ? await this.prisma.complianceDocument.findMany({
          where: { companyId: admin.companyId },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            docType: true,
            status: true,
            originalFilename: true,
            createdAt: true,
            expiresAt: true,
          },
        })
      : [];
    const openCase = admin.companyId
      ? await this.prisma.complianceCase.findFirst({
          where: {
            companyId: admin.companyId,
            caseType: ComplianceCaseType.ADMIN_PARTNER_KYB,
            status: {
              in: [
                ComplianceCaseStatus.OPEN,
                ComplianceCaseStatus.INFO_REQUESTED,
                ComplianceCaseStatus.ESCALATED,
              ],
            },
          },
          select: { id: true, status: true, decisionNote: true, infoRequestedAt: true },
        })
      : null;
    return {
      ...this.mapAdmin(admin),
      documents,
      openCase,
    };
  }

  async updatePartnerOnboarding(
    principal: AuthenticatedPrincipal,
    input: PartnerOnboardingUpdateInput,
  ) {
    this.ensureDatabase();
    const admin = await this.requirePartnerSelf(principal);
    if (
      admin.status !== AdminUserStatus.PENDING_DOCS &&
      admin.status !== AdminUserStatus.INVITED &&
      admin.status !== AdminUserStatus.PENDING_REVIEW
    ) {
      if (admin.status === AdminUserStatus.ACTIVE) {
        throw new BadRequestException('Onboarding already complete');
      }
    }
    if (admin.status === AdminUserStatus.PENDING_REVIEW) {
      throw new BadRequestException('Case is under review — wait for Super Admin');
    }

    const prev = (admin.profileJson ?? {}) as PartnerProfileJson;
    const nextProfile: PartnerProfileJson = {
      ...prev,
      ...(input.corporateAddress !== undefined
        ? { corporateAddress: input.corporateAddress }
        : {}),
      ...(input.networkExperience !== undefined
        ? { networkExperience: input.networkExperience }
        : {}),
      ...(input.executionStrategy !== undefined
        ? { executionStrategy: input.executionStrategy }
        : {}),
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      if (admin.companyId) {
        await tx.company.update({
          where: { id: admin.companyId },
          data: {
            ...(input.companyName ? { legalName: input.companyName } : {}),
            ...(input.abn !== undefined ? { abn: input.abn.replace(/\s/g, '') } : {}),
            ...(input.acn !== undefined ? { acn: input.acn || null } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.corporateAddress !== undefined
              ? { invoiceAddressLine1: input.corporateAddress }
              : {}),
          },
        });
      }
      return tx.adminUser.update({
        where: { id: admin.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          profileJson: nextProfile,
          status:
            admin.status === AdminUserStatus.INVITED
              ? AdminUserStatus.PENDING_DOCS
              : admin.status,
          active: false,
        },
        include: {
          scopes: { include: { region: true, localTerritory: true } },
          company: true,
        },
      });
    });

    return this.mapAdmin(updated);
  }

  async submitPartnerOnboarding(
    principal: AuthenticatedPrincipal,
    input: PartnerOnboardingSubmitInput,
  ) {
    this.ensureDatabase();
    const admin = await this.requirePartnerSelf(principal);
    if (!admin.companyId || !admin.company) {
      throw new BadRequestException('Partner company missing');
    }
    if (
      admin.status !== AdminUserStatus.PENDING_DOCS &&
      admin.status !== AdminUserStatus.INVITED
    ) {
      if (admin.status === AdminUserStatus.PENDING_REVIEW) {
        throw new BadRequestException('Already submitted for review');
      }
      throw new BadRequestException('Cannot submit in current status');
    }

    const company = admin.company;
    if (!company.abn || !company.legalName) {
      throw new BadRequestException('Company name and ABN required before submit');
    }
    const profile = (admin.profileJson ?? {}) as PartnerProfileJson;
    if (!profile.networkExperience || !profile.executionStrategy) {
      throw new BadRequestException('Network experience and execution strategy required');
    }
    if (!admin.name) {
      throw new BadRequestException('Full legal name required');
    }

    const docs = await this.prisma.complianceDocument.findMany({
      where: {
        id: { in: input.documentIds },
        companyId: company.id,
      },
    });
    if (docs.length !== input.documentIds.length) {
      throw new BadRequestException('One or more documents not found for this company');
    }
    const types = new Set(docs.map((d) => d.docType));
    for (const required of PARTNER_REQUIRED_DOCS) {
      if (!types.has(required)) {
        throw new BadRequestException(`Missing required document: ${required}`);
      }
    }

    const regionId = admin.scopes[0]?.region
      ? (
          await this.prisma.region.findUnique({
            where: { code: admin.scopes[0].region!.code },
          })
        )?.id
      : company.homeRegionId;

    const open = await this.prisma.complianceCase.findFirst({
      where: {
        companyId: company.id,
        caseType: ComplianceCaseType.ADMIN_PARTNER_KYB,
        status: {
          in: [
            ComplianceCaseStatus.OPEN,
            ComplianceCaseStatus.INFO_REQUESTED,
            ComplianceCaseStatus.ESCALATED,
          ],
        },
      },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      let complianceCase = open;
      if (complianceCase?.status === ComplianceCaseStatus.INFO_REQUESTED) {
        complianceCase = await tx.complianceCase.update({
          where: { id: complianceCase.id },
          data: {
            status: ComplianceCaseStatus.OPEN,
            submittedByUserId: null,
            infoRequestedAt: null,
          },
        });
      } else if (!complianceCase) {
        complianceCase = await tx.complianceCase.create({
          data: {
            companyId: company.id,
            caseType: ComplianceCaseType.ADMIN_PARTNER_KYB,
            status: ComplianceCaseStatus.OPEN,
            regionId: regionId ?? null,
            assignedAdminId: null,
          },
        });
      }

      await tx.complianceDocument.updateMany({
        where: { id: { in: input.documentIds } },
        data: {
          caseId: complianceCase.id,
          status: ComplianceDocStatus.UNDER_REVIEW,
        },
      });

      await tx.company.update({
        where: { id: company.id },
        data: { status: CompanyStatus.PENDING_REVIEW },
      });

      const updatedAdmin = await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          status: AdminUserStatus.PENDING_REVIEW,
          active: false,
          declarationAccuracy: true,
          declarationNda: true,
          declarationNonCompete: true,
        },
        include: {
          scopes: { include: { region: true, localTerritory: true } },
          company: true,
        },
      });

      if (updatedAdmin.leadId) {
        await tx.lead.update({
          where: { id: updatedAdmin.leadId },
          data: { status: LeadStatus.UNDER_REVIEW },
        });
      }

      return { complianceCase, updatedAdmin };
    });

    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_PARTNER_SUBMITTED,
      actorAdminId: admin.id,
      entityType: 'ComplianceCase',
      entityId: result.complianceCase.id,
      metadata: {
        adminUserId: admin.id,
        documentIds: input.documentIds,
        role: admin.role,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_SUBMITTED,
      actorAdminId: admin.id,
      entityType: 'ComplianceCase',
      entityId: result.complianceCase.id,
      metadata: { caseType: ComplianceCaseType.ADMIN_PARTNER_KYB },
    });

    if (this.inbox) {
      const legalName = company.legalName || 'Partner';
      void this.inbox.notifyComplianceCaseToOps({
        caseId: result.complianceCase.id,
        regionId: result.complianceCase.regionId ?? regionId ?? null,
        type: NotificationType.ADMIN_PARTNER_KYB_SUBMITTED,
        title: `Partner KYB submitted: ${legalName}`,
        body: 'Invited admin partner completed KYB for Super review.',
        superOnly: true,
      });
    }

    return {
      caseId: result.complianceCase.id,
      status: result.complianceCase.status,
      admin: this.mapAdmin(result.updatedAdmin),
    };
  }

  /** Demo policy mutation — Super only + step-up (M1). */
  async publishPolicyStub(actor: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const version = await this.prisma.policyVersion.create({
      data: {
        key: 'pilot.enabled_states',
        version: Date.now(),
        payload: { enabled_states: ['VIC'] },
        publishedAt: new Date(),
        publishedBy: actor.id,
      },
    });
    return { id: version.id, key: version.key, version: version.version };
  }

  /**
   * Scoped Dashboard Stats for Ops Roles:
   * - State Master: Regional metrics (VIC/NSW/etc.), state active jobs, state carriers, 10% gross split.
   * - Local BDE: Territory metrics, prospects in pipeline, stuck onboardings, 5% gross split.
   * - Super Admin: National overview.
   */
  async getDashboardStats(actor: AuthenticatedPrincipal): Promise<OpsDashboardStatsResponse> {
    this.ensureDatabase();

    if (actor.role === AdminRole.STATE_MASTER) {
      const regionCode = actor.regionCodes[0] || 'VIC';
      const region = await this.prisma.region.findUnique({
        where: { code: regionCode },
      });

      const regionId = region?.id;

      const [
        activeCarriers,
        activeJobs,
        openDisputes,
        pendingCompliance,
        revenueSum,
        recentDisputes,
        recentComplianceCases,
        recentJobs,
      ] = await Promise.all([
        this.prisma.company.count({
          where: {
            type: CompanyType.CARRIER,
            ...(regionId ? { homeRegionId: regionId } : {}),
            status: { in: [CompanyStatus.ACTIVE, CompanyStatus.BID_ELIGIBLE] },
          },
        }),
        this.prisma.job.count({
          where: {
            ...(regionId ? { originRegionId: regionId } : {}),
            status: { in: [JobStatus.PUBLISHED, JobStatus.ASSIGNED, JobStatus.IN_TRANSIT] },
          },
        }),
        this.prisma.dispute.count({
          where: {
            ...(regionId ? { regionId } : {}),
            status: { in: [DisputeStatus.OPEN_TRIAGE, DisputeStatus.TRIAGED, DisputeStatus.ESCALATED_STATE] },
          },
        }),
        this.prisma.complianceCase.count({
          where: {
            ...(regionId ? { regionId } : {}),
            status: { in: [ComplianceCaseStatus.OPEN, ComplianceCaseStatus.INFO_REQUESTED] },
          },
        }),
        this.prisma.settlementLine.aggregate({
          where: {
            OR: [
              { adminUserId: actor.id },
              regionId ? { regionId, recipientType: 'STATE_MASTER' } : null,
            ].filter(Boolean) as any,
          },
          _sum: { amountCents: true },
        }),
        this.prisma.dispute.findMany({
          where: { ...(regionId ? { regionId } : {}) },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { company: { select: { legalName: true } } },
        }),
        this.prisma.complianceCase.findMany({
          where: { ...(regionId ? { regionId } : {}) },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { company: { select: { legalName: true } } },
        }),
        this.prisma.job.findMany({
          where: { ...(regionId ? { originRegionId: regionId } : {}) },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { stops: { orderBy: { sequence: 'asc' } } },
        }),
      ]);

      return {
        role: actor.role as any,
        scope: {
          type: 'STATE',
          regionCode: region?.code,
          regionName: region?.name,
        },
        kpis: {
          activeCarriers,
          activeJobs,
          openDisputes,
          pendingCompliance,
          accruedRevenueCents: revenueSum._sum.amountCents || 0,
        },
        recentDisputes: recentDisputes.map((d: any) => ({
          id: d.id,
          disputeNumber: d.disputeNumber,
          type: d.type,
          status: d.status,
          reason: d.reason,
          disputedAmountCents: d.disputedAmountCents,
          companyName: d.company.legalName,
          createdAt: d.createdAt.toISOString(),
        })),
        recentComplianceCases: recentComplianceCases.map((c: any) => ({
          id: c.id,
          caseType: c.caseType,
          status: c.status,
          companyName: c.company.legalName,
          createdAt: c.createdAt.toISOString(),
        })),
        recentJobs: recentJobs.map((j: any) => ({
          id: j.id,
          title: j.title,
          status: j.status,
          pickupSuburb: j.stops.find((s: any) => s.stopType === 'PICKUP')?.suburb || null,
          dropoffSuburb: j.stops.find((s: any) => s.stopType === 'DROPOFF')?.suburb || null,
          createdAt: j.createdAt.toISOString(),
        })),
      };
    }

    if (actor.role === AdminRole.LOCAL_BDE) {
      const territoryCode = actor.territoryCodes[0];
      const territory = territoryCode
        ? await this.prisma.localTerritory.findFirst({
            where: { code: territoryCode },
            include: { region: true },
          })
        : null;

      const territoryId = territory?.id;

      const [
        prospectsInPipeline,
        onboardingStuck,
        activeJobs,
        firstLineDisputes,
        revenueSum,
        recentDisputes,
        stuckCompanies,
      ] = await Promise.all([
        this.prisma.prospect.count({
          where: {
            ownerAdminUserId: actor.id,
            stage: {
              in: [
                ProspectStage.LEAD,
                ProspectStage.CONTACTED,
                ProspectStage.INVITED,
                ProspectStage.ONBOARDING,
              ],
            },
          },
        }),
        this.prisma.company.count({
          where: {
            referredByAdminUserId: actor.id,
            status: { in: ONBOARDING_STUCK_STATUSES },
          },
        }),
        this.prisma.job.count({
          where: {
            ...(territoryId ? { originTerritoryId: territoryId } : {}),
            status: { in: [JobStatus.PUBLISHED, JobStatus.ASSIGNED, JobStatus.IN_TRANSIT] },
          },
        }),
        this.prisma.dispute.count({
          where: {
            ...(territoryId ? { territoryId } : {}),
            status: DisputeStatus.OPEN_TRIAGE,
          },
        }),
        this.prisma.settlementLine.aggregate({
          where: {
            OR: [
              { adminUserId: actor.id },
              territoryId ? { territoryId, recipientType: 'LOCAL_BDE' } : null,
            ].filter(Boolean) as any,
          },
          _sum: { amountCents: true },
        }),
        this.prisma.dispute.findMany({
          where: {
            ...(territoryId ? { territoryId } : {}),
            status: DisputeStatus.OPEN_TRIAGE,
          },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { company: { select: { legalName: true } } },
        }),
        this.prisma.company.findMany({
          where: {
            referredByAdminUserId: actor.id,
            status: { in: ONBOARDING_STUCK_STATUSES },
          },
          take: 5,
          orderBy: { updatedAt: 'desc' },
        }),
      ]);

      const tasks: any[] = [];
      recentDisputes.forEach((d: any) => {
        tasks.push({
          id: `task-disp-${d.id}`,
          kind: 'DISPUTE_TRIAGE',
          title: `Triage Dispute ${d.disputeNumber} (${d.reason})`,
          description: `Disputed by ${d.company.legalName}. Verify site geofence and call both parties.`,
          href: `/ops/disputes/${d.id}`,
          dueText: 'Immediate',
        });
      });
      stuckCompanies.forEach((c: any) => {
        tasks.push({
          id: `task-comp-${c.id}`,
          kind: 'ONBOARDING_STUCK',
          title: `Assist ${c.legalName} (${c.type})`,
          description: `Stuck at ${c.status}. Assist with Australian compliance document upload.`,
          href: `/companies/${c.id}`,
          dueText: 'Follow Up',
        });
      });

      return {
        role: actor.role as any,
        scope: {
          type: 'TERRITORY',
          territoryCode: territory?.code,
          territoryName: territory?.name,
          regionCode: territory?.region?.code,
        },
        kpis: {
          activeCarriers: 0,
          activeJobs,
          openDisputes: firstLineDisputes,
          firstLineDisputes,
          prospectsInPipeline,
          onboardingStuck,
          accruedRevenueCents: revenueSum._sum.amountCents || 0,
        },
        recentDisputes: recentDisputes.map((d: any) => ({
          id: d.id,
          disputeNumber: d.disputeNumber,
          type: d.type,
          status: d.status,
          reason: d.reason,
          disputedAmountCents: d.disputedAmountCents,
          companyName: d.company.legalName,
          createdAt: d.createdAt.toISOString(),
        })),
        tasks,
      };
    }

    // Default National for Super Admin
    const [activeCarriers, activeJobs, openDisputes, revenueSum, recentDisputes] =
      await Promise.all([
        this.prisma.company.count({
          where: {
            type: CompanyType.CARRIER,
            status: { in: [CompanyStatus.ACTIVE, CompanyStatus.BID_ELIGIBLE] },
          },
        }),
        this.prisma.job.count({
          where: { status: { in: [JobStatus.PUBLISHED, JobStatus.ASSIGNED, JobStatus.IN_TRANSIT] } },
        }),
        this.prisma.dispute.count({
          where: {
            status: {
              in: [
                DisputeStatus.OPEN_TRIAGE,
                DisputeStatus.TRIAGED,
                DisputeStatus.ESCALATED_STATE,
                DisputeStatus.ESCALATED_SUPER,
              ],
            },
          },
        }),
        this.prisma.settlementLine.aggregate({
          where: { recipientType: 'SUPER_ADMIN' },
          _sum: { amountCents: true },
        }),
        this.prisma.dispute.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { company: { select: { legalName: true } } },
        }),
      ]);

    return {
      role: actor.role as any,
      scope: { type: 'NATIONAL' },
      kpis: {
        activeCarriers,
        activeJobs,
        openDisputes,
        accruedRevenueCents: revenueSum._sum.amountCents || 0,
      },
      recentDisputes: recentDisputes.map((d: any) => ({
        id: d.id,
        disputeNumber: d.disputeNumber,
        type: d.type,
        status: d.status,
        reason: d.reason,
        disputedAmountCents: d.disputedAmountCents,
        companyName: d.company.legalName,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  /**
   * OPS-STA-TEAM-01: List Local BDE field team for State Master or Super Admin
   */
  async listBdeTeam(actor: AuthenticatedPrincipal): Promise<BdeTeamListResponse> {
    this.ensureDatabase();
    if (actor.kind !== 'admin') {
      throw new ForbiddenException('Admin required');
    }
    if (actor.role !== AdminRole.SUPER_ADMIN && actor.role !== AdminRole.STATE_MASTER) {
      throw new ForbiddenException('Super Admin or State Master required');
    }

    let regionCode = actor.regionCodes?.[0];
    if (actor.role === AdminRole.SUPER_ADMIN && !regionCode) {
      const firstRegion = await this.prisma.region.findFirst({ orderBy: { code: 'asc' } });
      regionCode = firstRegion?.code ?? 'VIC';
    }
    if (!regionCode) {
      throw new BadRequestException('State Master has no assigned region');
    }

    const region = await this.prisma.region.findUnique({
      where: { code: regionCode },
    });
    const regionName = region?.name ?? regionCode;

    const bdeAdmins = await this.prisma.adminUser.findMany({
      where: {
        role: AdminRole.LOCAL_BDE,
        scopes: {
          some: {
            OR: [
              { region: { code: regionCode } },
              { localTerritory: { region: { code: regionCode } } },
            ],
          },
        },
      },
      include: {
        scopes: {
          include: {
            localTerritory: { include: { region: true } },
            region: true,
          },
        },
        prospects: {
          select: { id: true, stage: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const members: BdeTeamMemberSummary[] = await Promise.all(
      bdeAdmins.map(async (bde) => {
        const territoryScope = bde.scopes.find((s) => s.localTerritoryId != null);
        const localTerritory = territoryScope?.localTerritory;
        const territoryId = localTerritory?.id ?? null;
        const territoryCode = localTerritory?.code ?? null;
        const territoryName = localTerritory?.name ?? territoryCode ?? null;

        const [openDisputesCount, overdueDisputesCount] = territoryId
          ? await Promise.all([
              this.prisma.dispute.count({
                where: {
                  territoryId,
                  status: DisputeStatus.OPEN_TRIAGE,
                },
              }),
              this.prisma.dispute.count({
                where: {
                  territoryId,
                  status: DisputeStatus.OPEN_TRIAGE,
                  createdAt: { lt: oneDayAgo },
                },
              }),
            ])
          : [0, 0];

        const pipelineCount = bde.prospects.length;
        const openTasksCount = openDisputesCount + bde.prospects.filter((p) => p.stage === 'LEAD').length;
        const overdueTasksCount = overdueDisputesCount;

        let slaStatus: 'GOOD' | 'WARNING' | 'BREACHED' = 'GOOD';
        if (overdueTasksCount > 0) {
          slaStatus = 'BREACHED';
        } else if (openTasksCount > 3) {
          slaStatus = 'WARNING';
        }

        const revenue = await this.prisma.settlementLine.aggregate({
          where: {
            adminUserId: bde.id,
          },
          _sum: { amountCents: true },
        });

        return {
          id: bde.id,
          name: bde.name,
          email: bde.email,
          phone: bde.phone,
          status: bde.status,
          active: bde.active,
          regionCode: regionCode!,
          territoryCode,
          territoryName,
          openTasksCount,
          overdueTasksCount,
          pipelineCount,
          slaStatus,
          accruedRevenueCents: revenue._sum?.amountCents || 0,
        };
      }),
    );

    return {
      regionCode,
      regionName,
      members,
    };
  }

  /**
   * OPS-STA-TEAM-02: Get Local BDE detail view with triage disputes, pipeline & coaching notes
   */
  async getBdeTeamMember(actor: AuthenticatedPrincipal, bdeId: string): Promise<BdeTeamMemberDetail> {
    this.ensureDatabase();
    if (actor.kind !== 'admin') {
      throw new ForbiddenException('Admin required');
    }
    if (actor.role !== AdminRole.SUPER_ADMIN && actor.role !== AdminRole.STATE_MASTER) {
      throw new ForbiddenException('Super Admin or State Master required');
    }

    const bde = await this.prisma.adminUser.findUnique({
      where: { id: bdeId },
      include: {
        scopes: {
          include: {
            localTerritory: { include: { region: true } },
            region: true,
          },
        },
        company: {
          select: { legalName: true },
        },
        prospects: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!bde || bde.role !== AdminRole.LOCAL_BDE) {
      throw new NotFoundException('Local BDE not found');
    }

    const territoryScope = bde.scopes.find((s) => s.localTerritoryId != null);
    const localTerritory = territoryScope?.localTerritory;
    const territoryId = localTerritory?.id ?? null;
    const territoryCode = localTerritory?.code ?? null;
    const territoryName = localTerritory?.name ?? territoryCode ?? null;
    const regionCode = territoryScope?.region?.code ?? localTerritory?.region?.code ?? 'VIC';

    if (actor.role === AdminRole.STATE_MASTER && actor.regionCodes?.[0] !== regionCode) {
      throw new ForbiddenException('Cross-region access prohibited');
    }

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentDisputesRaw = territoryId
      ? await this.prisma.dispute.findMany({
          where: { territoryId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : [];

    const openDisputesCount = recentDisputesRaw.filter((d) => d.status === DisputeStatus.OPEN_TRIAGE).length;
    const overdueDisputesCount = recentDisputesRaw.filter(
      (d) => d.status === DisputeStatus.OPEN_TRIAGE && d.createdAt < oneDayAgo,
    ).length;

    const pipelineCount = bde.prospects.length;
    const openTasksCount = openDisputesCount + bde.prospects.filter((p) => p.stage === 'LEAD').length;
    const overdueTasksCount = overdueDisputesCount;

    let slaStatus: 'GOOD' | 'WARNING' | 'BREACHED' = 'GOOD';
    if (overdueDisputesCount > 0) {
      slaStatus = 'BREACHED';
    } else if (openTasksCount > 3) {
      slaStatus = 'WARNING';
    }

    const revenue = await this.prisma.settlementLine.aggregate({
      where: {
        adminUserId: bde.id,
      },
      _sum: { amountCents: true },
    });

    const profile = (bde.profileJson ?? {}) as {
      coachingNotes?: Array<{
        id: string;
        authorId: string;
        authorName: string;
        text: string;
        createdAt: string;
      }>;
    };

    return {
      id: bde.id,
      name: bde.name,
      email: bde.email,
      phone: bde.phone,
      status: bde.status,
      active: bde.active,
      regionCode,
      territoryCode,
      territoryName,
      openTasksCount,
      overdueTasksCount,
      pipelineCount,
      slaStatus,
      accruedRevenueCents: revenue._sum?.amountCents || 0,
      createdAt: bde.createdAt.toISOString(),
      companyName: bde.company?.legalName ?? null,
      prospects: bde.prospects.map((p) => ({
        id: p.id,
        legalName: p.legalName,
        companyType: p.companyType,
        stage: p.stage,
        contactName: p.contactName,
        email: p.email,
        phone: p.phone,
        createdAt: p.createdAt.toISOString(),
      })),
      recentDisputes: recentDisputesRaw.map((d) => ({
        id: d.id,
        disputeNumber: d.disputeNumber,
        type: d.type,
        status: d.status,
        reason: d.reason,
        disputedAmountCents: d.disputedAmountCents,
        createdAt: d.createdAt.toISOString(),
        isOverdue: d.status === DisputeStatus.OPEN_TRIAGE && d.createdAt < oneDayAgo,
      })),
      coachingNotes: profile.coachingNotes ?? [],
    };
  }

  /**
   * Add a coaching note on a Local BDE
   */
  async addBdeCoachingNote(
    actor: AuthenticatedPrincipal,
    bdeId: string,
    input: AddBdeCoachingNoteInput,
  ): Promise<BdeTeamMemberDetail> {
    this.ensureDatabase();
    if (actor.kind !== 'admin') {
      throw new ForbiddenException('Admin required');
    }
    if (actor.role !== AdminRole.SUPER_ADMIN && actor.role !== AdminRole.STATE_MASTER) {
      throw new ForbiddenException('Super Admin or State Master required');
    }

    const bde = await this.prisma.adminUser.findUnique({
      where: { id: bdeId },
      include: {
        scopes: {
          include: {
            localTerritory: { include: { region: true } },
            region: true,
          },
        },
      },
    });

    if (!bde || bde.role !== AdminRole.LOCAL_BDE) {
      throw new NotFoundException('Local BDE not found');
    }

    const territoryScope = bde.scopes.find((s) => s.localTerritoryId != null);
    const regionCode = territoryScope?.region?.code ?? territoryScope?.localTerritory?.region?.code ?? 'VIC';

    if (actor.role === AdminRole.STATE_MASTER && actor.regionCodes?.[0] !== regionCode) {
      throw new ForbiddenException('Cross-region access prohibited');
    }

    const prevProfile = (bde.profileJson ?? {}) as Record<string, any>;
    const prevNotes = Array.isArray(prevProfile.coachingNotes) ? prevProfile.coachingNotes : [];

    const newNote = {
      id: randomUUID(),
      authorId: actor.id,
      authorName: actor.email,
      text: input.text,
      createdAt: new Date().toISOString(),
    };

    const nextProfile = {
      ...prevProfile,
      coachingNotes: [newNote, ...prevNotes],
    };

    await this.prisma.adminUser.update({
      where: { id: bdeId },
      data: {
        profileJson: nextProfile,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_COACHING_NOTE_ADDED,
      actorAdminId: actor.id,
      entityType: 'AdminUser',
      entityId: bde.id,
      metadata: { noteId: newNote.id },
    });

    return this.getBdeTeamMember(actor, bdeId);
  }
}

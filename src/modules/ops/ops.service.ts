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
import { randomBytes } from 'crypto';
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
  LeadStatus,
  NotificationType,
} from '@prisma/client';
import {
  AuditAction,
  type AdminAcceptInviteInput,
  type InviteAdminInput,
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
}

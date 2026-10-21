import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AdminUserStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
  LeadStatus,
  PlatformRole,
  UserStatus,
  VehicleStatus,
  type Prisma,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AttributionService } from '../../common/services/attribution.service';
import { ScopeService } from '../../common/services/scope.service';
import {
  AdminRole,
  AuditAction,
  type ComplianceCaseListQuery,
  type ComplianceDecisionInput,
  type SubmitComplianceInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AbrService } from './abr.service';

const CARRIER_REQUIRED: ComplianceDocType[] = [
  ComplianceDocType.PUBLIC_LIABILITY,
  ComplianceDocType.CARGO_INSURANCE,
  ComplianceDocType.RWC,
];

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly attribution: AttributionService,
    private readonly abr: AbrService,
    private readonly notifications: NotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async assertCompanyMember(principal: AuthenticatedPrincipal, companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { homeRegion: true },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (principal.kind === 'admin') {
      const regionCode = company.homeRegion?.code;
      if (regionCode) {
        this.scope.assertRegionAccess(principal, regionCode);
      } else if (principal.role !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException('Company has no region — Super only');
      }
      await this.assertAdminTerritoryForCompany(principal, company);
      return company;
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user || user.companyId !== companyId) {
      throw new ForbiddenException('Not a member of this company');
    }
    return company;
  }

  /**
   * Local BDE: book-of-business isolation (referredBy = self).
   * Territory geography alone is not enough when multiple Locals share a territory.
   */
  private async assertAdminTerritoryForCompany(
    principal: AuthenticatedPrincipal,
    company: { id: string; homeRegionId: string | null; referredByAdminUserId?: string | null },
  ) {
    if (principal.role !== AdminRole.LOCAL_BDE) return;
    // Prisma always selects this scalar; missing on partial mocks → treat as HQ (null).
    this.attribution.assertLocalOwnsCompany(principal, {
      referredByAdminUserId: company.referredByAdminUserId ?? null,
    });
  }

  private assertCanDecide(principal: AuthenticatedPrincipal) {
    this.scope.assertAdmin(principal);
    if (principal.role === AdminRole.LOCAL_BDE) {
      throw new ForbiddenException('Local BDE may view/escalate only (G0-4)');
    }
    if (
      principal.role !== AdminRole.SUPER_ADMIN &&
      principal.role !== AdminRole.STATE_MASTER
    ) {
      throw new ForbiddenException('Insufficient role for compliance decision');
    }
  }

  /** Admin partner KYB: Super Admin only (G0-4 — State must not approve peers). */
  private assertCanDecidePartnerKyb(
    principal: AuthenticatedPrincipal,
    caseType: ComplianceCaseType,
  ) {
    this.assertCanDecide(principal);
    if (caseType === ComplianceCaseType.ADMIN_PARTNER_KYB) {
      if (principal.role !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'Only Super Admin may decide ADMIN_PARTNER_KYB cases',
        );
      }
    }
  }

  private async loadCaseForAdmin(principal: AuthenticatedPrincipal, caseId: string) {
    this.scope.assertAdmin(principal);
    const complianceCase = await this.prisma.complianceCase.findUnique({
      where: { id: caseId },
      include: {
        company: { include: { homeRegion: true } },
        region: true,
        documents: true,
      },
    });
    if (!complianceCase) {
      throw new NotFoundException('Compliance case not found');
    }

    const regionCode = complianceCase.region?.code ?? complianceCase.company.homeRegion?.code;
    if (regionCode) {
      this.scope.assertRegionAccess(principal, regionCode);
    } else if (principal.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Case has no region — Super only');
    }
    await this.assertAdminTerritoryForCompany(principal, complianceCase.company);

    return complianceCase;
  }

  async submit(principal: AuthenticatedPrincipal, input: SubmitComplianceInput) {
    this.ensureDatabase();
    if (principal.kind === 'user' && principal.role === 'DRIVER') {
      throw new ForbiddenException('Drivers cannot submit company KYB/KYC');
    }
    if (
      principal.kind === 'user' &&
      input.caseType === ComplianceCaseType.CARRIER_KYB &&
      principal.role !== 'TRANSPORT_COMPANY'
    ) {
      throw new ForbiddenException('Carrier ops role required for CARRIER_KYB');
    }
    if (
      principal.kind === 'user' &&
      (input.caseType === ComplianceCaseType.SENDER_KYB ||
        input.caseType === ComplianceCaseType.SENDER_KYC) &&
      principal.role !== 'SENDER'
    ) {
      throw new ForbiddenException('Sender role required for sender compliance submit');
    }
    const company = await this.assertCompanyMember(principal, input.companyId);

    if (company.type === CompanyType.SENDER && input.caseType === ComplianceCaseType.CARRIER_KYB) {
      throw new BadRequestException('Sender company cannot submit CARRIER_KYB');
    }
    if (company.type === CompanyType.CARRIER && input.caseType !== ComplianceCaseType.CARRIER_KYB) {
      throw new BadRequestException('Carrier company must submit CARRIER_KYB');
    }

    const docs = await this.prisma.complianceDocument.findMany({
      where: {
        id: { in: input.documentIds },
        companyId: company.id,
        status: ComplianceDocStatus.UPLOADED,
      },
    });
    if (docs.length !== input.documentIds.length) {
      throw new BadRequestException('All documents must exist, belong to company, and be UPLOADED');
    }

    if (input.caseType === ComplianceCaseType.CARRIER_KYB) {
      const types = new Set(docs.map((d) => d.docType));
      const missing = CARRIER_REQUIRED.filter((t) => !types.has(t));
      if (missing.length > 0) {
        throw new BadRequestException(
          `Carrier mandatory docs missing: ${missing.join(', ')}`,
        );
      }
      if (!company.abn) {
        throw new BadRequestException('Carrier ABN required before submit');
      }
    }

    if (input.caseType === ComplianceCaseType.SENDER_KYB) {
      const hasAbnDoc = docs.some((d) => d.docType === ComplianceDocType.ABN_EXTRACT);
      if (!hasAbnDoc && !company.abn) {
        throw new BadRequestException('Sender business requires ABN extract or company ABN');
      }
    }

    if (input.caseType === ComplianceCaseType.SENDER_KYC) {
      const hasId = docs.some((d) => d.docType === ComplianceDocType.GOVERNMENT_ID);
      if (!hasId) {
        throw new BadRequestException('Sender individual requires GOVERNMENT_ID');
      }
    }

    const open = await this.prisma.complianceCase.findFirst({
      where: {
        companyId: company.id,
        status: { in: [ComplianceCaseStatus.OPEN, ComplianceCaseStatus.INFO_REQUESTED, ComplianceCaseStatus.ESCALATED] },
      },
    });
    if (open) {
      throw new BadRequestException('Company already has an open compliance case');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const complianceCase = await tx.complianceCase.create({
        data: {
          companyId: company.id,
          caseType: input.caseType,
          status: ComplianceCaseStatus.OPEN,
          regionId: company.homeRegionId,
          submittedByUserId: principal.kind === 'user' ? principal.id : null,
        },
      });

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

      return complianceCase;
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_SUBMITTED,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      entityType: 'ComplianceCase',
      entityId: created.id,
      metadata: { caseType: input.caseType, documentIds: input.documentIds },
    });

    return {
      id: created.id,
      status: created.status,
      caseType: created.caseType,
      companyStatus: CompanyStatus.PENDING_REVIEW,
    };
  }

  async listCases(principal: AuthenticatedPrincipal, query: ComplianceCaseListQuery) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);

    const where: Prisma.ComplianceCaseWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.caseType) {
      where.caseType = query.caseType;
    }

    const allowedRegions = this.scope.allowedRegionCodes(principal);
    if (query.regionCode) {
      this.scope.assertRegionAccess(principal, query.regionCode);
      where.region = { code: query.regionCode };
    } else if (allowedRegions !== null) {
      where.region = { code: { in: allowedRegions } };
    }

    // Local BDE: only cases for companies in their referred book (not territory-wide).
    const bookFilter = this.attribution.complianceCaseBookFilter(principal);
    if (bookFilter) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), bookFilter];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.complianceCase.count({ where }),
      this.prisma.complianceCase.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: { createdAt: 'asc' },
        include: {
          company: { select: { id: true, legalName: true, type: true, abn: true, status: true } },
          region: { select: { code: true, name: true } },
          documents: {
            select: { id: true, docType: true, status: true, expiresAt: true, originalFilename: true },
          },
        },
      }),
    ]);

    return {
      success: true,
      data: rows,
      meta: {
        page: query.page,
        limit: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize) || 1,
      },
    };
  }

  async getCase(principal: AuthenticatedPrincipal, caseId: string) {
    this.ensureDatabase();
    const complianceCase = await this.loadCaseForAdmin(principal, caseId);
    let abrAssist: Awaited<ReturnType<AbrService['lookupAbn']>> | null = null;
    if (complianceCase.company.abn) {
      abrAssist = await this.abr.lookupAbn(complianceCase.company.abn);
    }
    const infoRequestedAt = complianceCase.infoRequestedAt;
    const infoRequestedMs = infoRequestedAt?.getTime() ?? null;
    const documents = [...complianceCase.documents]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((doc) => ({
        ...doc,
        isNewSinceInfoRequest:
          infoRequestedMs != null && doc.createdAt.getTime() > infoRequestedMs,
      }));
    return { ...complianceCase, documents, abrAssist };
  }

  private assertCaseActionable(status: ComplianceCaseStatus) {
    if (
      status !== ComplianceCaseStatus.OPEN &&
      status !== ComplianceCaseStatus.ESCALATED &&
      status !== ComplianceCaseStatus.INFO_REQUESTED
    ) {
      throw new BadRequestException('Case is not actionable');
    }
  }

  async approve(
    principal: AuthenticatedPrincipal,
    caseId: string,
    input: ComplianceDecisionInput,
  ) {
    this.ensureDatabase();
    const complianceCase = await this.loadCaseForAdmin(principal, caseId);
    this.assertCanDecidePartnerKyb(principal, complianceCase.caseType);
    this.assertCaseActionable(complianceCase.status);

    if (complianceCase.caseType === ComplianceCaseType.ADMIN_PARTNER_KYB) {
      return this.approveAdminPartnerKyb(principal, caseId, complianceCase, input);
    }

    const nextCompanyStatus =
      complianceCase.company.type === CompanyType.SENDER
        ? CompanyStatus.PENDING_PAYMENT
        : CompanyStatus.BID_ELIGIBLE;

    await this.prisma.$transaction(async (tx) => {
      await tx.complianceCase.update({
        where: { id: caseId },
        data: {
          status: ComplianceCaseStatus.APPROVED,
          decisionNote: input.note,
          decidedAt: new Date(),
          decidedByAdminId: principal.id,
        },
      });
      await tx.complianceDocument.updateMany({
        where: { caseId },
        data: { status: ComplianceDocStatus.APPROVED, reviewedAt: new Date() },
      });
      await tx.company.update({
        where: { id: complianceCase.companyId },
        data: { status: nextCompanyStatus },
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_APPROVED,
      actorAdminId: principal.id,
      entityType: 'ComplianceCase',
      entityId: caseId,
      metadata: { nextCompanyStatus, note: input.note ?? null },
    });

    void this.notifyCompanyDecision({
      kind: 'approved',
      companyId: complianceCase.companyId,
      companyEmail: complianceCase.company.email,
      companyName: complianceCase.company.legalName,
      companyType: complianceCase.company.type,
      companyStatus: nextCompanyStatus,
      caseType: complianceCase.caseType,
      decisionNote: input.note,
    }).catch((error: unknown) => {
      this.logger.error(
        `Failed to send compliance approval email for case ${caseId}`,
        error instanceof Error ? error.stack : String(error),
      );
    });

    return {
      id: caseId,
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: nextCompanyStatus,
    };
  }

  private async approveAdminPartnerKyb(
    principal: AuthenticatedPrincipal,
    caseId: string,
    complianceCase: {
      companyId: string;
      caseType: ComplianceCaseType;
      company: { email: string | null; legalName: string; type: CompanyType };
    },
    input: ComplianceDecisionInput,
  ) {
    const partner = await this.prisma.adminUser.findFirst({
      where: { companyId: complianceCase.companyId },
    });
    if (!partner) {
      throw new BadRequestException('Admin partner user not linked to this company');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.complianceCase.update({
        where: { id: caseId },
        data: {
          status: ComplianceCaseStatus.APPROVED,
          decisionNote: input.note,
          decidedAt: new Date(),
          decidedByAdminId: principal.id,
        },
      });
      await tx.complianceDocument.updateMany({
        where: { caseId },
        data: { status: ComplianceDocStatus.APPROVED, reviewedAt: new Date() },
      });
      await tx.company.update({
        where: { id: complianceCase.companyId },
        data: { status: CompanyStatus.ACTIVE },
      });
      await tx.adminUser.update({
        where: { id: partner.id },
        data: {
          status: AdminUserStatus.ACTIVE,
          active: true,
        },
      });
      if (partner.leadId) {
        await tx.lead.update({
          where: { id: partner.leadId },
          data: { status: LeadStatus.PROVISIONED },
        });
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_APPROVED,
      actorAdminId: principal.id,
      entityType: 'ComplianceCase',
      entityId: caseId,
      metadata: {
        nextCompanyStatus: CompanyStatus.ACTIVE,
        note: input.note ?? null,
        caseType: ComplianceCaseType.ADMIN_PARTNER_KYB,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.ADMIN_PARTNER_ACTIVATED,
      actorAdminId: principal.id,
      entityType: 'AdminUser',
      entityId: partner.id,
      metadata: { caseId, role: partner.role, email: partner.email },
    });

    void this.notifications
      .sendAdminProvisionedEmail({
        to: partner.email,
        role: partner.role,
        name: partner.name,
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send admin partner activation email for case ${caseId}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return {
      id: caseId,
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: CompanyStatus.ACTIVE,
      adminUserId: partner.id,
      adminStatus: AdminUserStatus.ACTIVE,
    };
  }

  /** Notify sender/carrier contacts after Ops decision (non-blocking). */
  private async notifyCompanyDecision(params: {
    kind: 'approved' | 'info_requested';
    companyId: string;
    companyEmail: string | null;
    companyName: string;
    companyType: CompanyType;
    companyStatus: CompanyStatus;
    caseType: ComplianceCaseType;
    decisionNote?: string | null;
  }) {
    if (
      params.companyType !== CompanyType.CARRIER &&
      params.companyType !== CompanyType.SENDER
    ) {
      return;
    }

    const users = await this.prisma.user.findMany({
      where: {
        companyId: params.companyId,
        status: UserStatus.ACTIVE,
        role: {
          in: [PlatformRole.SENDER, PlatformRole.TRANSPORT_COMPANY],
        },
      },
      select: { email: true },
    });

    const recipients = new Set<string>();
    if (params.companyEmail?.trim()) {
      recipients.add(params.companyEmail.trim().toLowerCase());
    }
    for (const user of users) {
      if (user.email?.trim()) {
        recipients.add(user.email.trim().toLowerCase());
      }
    }

    if (recipients.size < 1) {
      this.logger.warn(
        `No contact email for company ${params.companyId} — skipped ${params.kind} notification`,
      );
      return;
    }

    const companyType = params.companyType === CompanyType.CARRIER ? 'CARRIER' : 'SENDER';
    await Promise.all(
      [...recipients].map((to) =>
        params.kind === 'approved'
          ? this.notifications.sendComplianceApprovedEmail({
              to,
              companyName: params.companyName,
              companyType,
              companyStatus: params.companyStatus,
              caseType: params.caseType,
              decisionNote: params.decisionNote,
            })
          : this.notifications.sendComplianceInfoRequestedEmail({
              to,
              companyName: params.companyName,
              companyType,
              caseType: params.caseType,
              decisionNote: params.decisionNote,
            }),
      ),
    );
  }

  async reject(
    principal: AuthenticatedPrincipal,
    caseId: string,
    input: ComplianceDecisionInput,
  ) {
    this.ensureDatabase();
    const complianceCase = await this.loadCaseForAdmin(principal, caseId);
    this.assertCanDecidePartnerKyb(principal, complianceCase.caseType);
    this.assertCaseActionable(complianceCase.status);

    const partner =
      complianceCase.caseType === ComplianceCaseType.ADMIN_PARTNER_KYB
        ? await this.prisma.adminUser.findFirst({
            where: { companyId: complianceCase.companyId },
          })
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.complianceCase.update({
        where: { id: caseId },
        data: {
          status: ComplianceCaseStatus.REJECTED,
          decisionNote: input.note,
          decidedAt: new Date(),
          decidedByAdminId: principal.id,
        },
      });
      await tx.complianceDocument.updateMany({
        where: { caseId },
        data: {
          status: ComplianceDocStatus.REJECTED,
          reviewedAt: new Date(),
          reviewNote: input.note,
        },
      });
      await tx.company.update({
        where: { id: complianceCase.companyId },
        data: { status: CompanyStatus.REJECTED },
      });
      if (partner) {
        await tx.adminUser.update({
          where: { id: partner.id },
          data: {
            status: AdminUserStatus.REJECTED,
            active: false,
          },
        });
        await tx.authSession.updateMany({
          where: { adminUserId: partner.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (partner.leadId) {
          await tx.lead.update({
            where: { id: partner.leadId },
            data: { status: LeadStatus.REJECTED },
          });
        }
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_REJECTED,
      actorAdminId: principal.id,
      entityType: 'ComplianceCase',
      entityId: caseId,
      metadata: {
        note: input.note ?? null,
        caseType: complianceCase.caseType,
        adminUserId: partner?.id ?? null,
      },
    });

    return { id: caseId, status: ComplianceCaseStatus.REJECTED, companyStatus: CompanyStatus.REJECTED };
  }

  async requestInfo(
    principal: AuthenticatedPrincipal,
    caseId: string,
    input: ComplianceDecisionInput,
  ) {
    this.ensureDatabase();
    const complianceCase = await this.loadCaseForAdmin(principal, caseId);
    this.assertCanDecidePartnerKyb(principal, complianceCase.caseType);
    this.assertCaseActionable(complianceCase.status);

    const partner =
      complianceCase.caseType === ComplianceCaseType.ADMIN_PARTNER_KYB
        ? await this.prisma.adminUser.findFirst({
            where: { companyId: complianceCase.companyId },
          })
        : null;

    const infoRequestedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.complianceCase.update({
        where: { id: caseId },
        data: {
          status: ComplianceCaseStatus.INFO_REQUESTED,
          decisionNote: input.note,
          infoRequestedAt,
        },
      });
      await tx.company.update({
        where: { id: complianceCase.companyId },
        data: { status: CompanyStatus.INFO_REQUESTED },
      });
      if (partner) {
        await tx.adminUser.update({
          where: { id: partner.id },
          data: {
            status: AdminUserStatus.PENDING_DOCS,
            active: false,
          },
        });
        if (partner.leadId) {
          await tx.lead.update({
            where: { id: partner.leadId },
            data: { status: LeadStatus.KYB_PENDING },
          });
        }
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_INFO_REQUESTED,
      actorAdminId: principal.id,
      entityType: 'ComplianceCase',
      entityId: caseId,
      metadata: { note: input.note ?? null, caseType: complianceCase.caseType },
    });

    if (partner) {
      void this.notifications
        .sendAdminPartnerInfoRequestedEmail({
          to: partner.email,
          role: partner.role,
          name: partner.name,
          companyName: complianceCase.company.legalName,
          decisionNote: input.note,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Failed to send admin partner info-requested email for case ${caseId}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
    } else {
      void this.notifyCompanyDecision({
        kind: 'info_requested',
        companyId: complianceCase.companyId,
        companyEmail: complianceCase.company.email,
        companyName: complianceCase.company.legalName,
        companyType: complianceCase.company.type,
        companyStatus: CompanyStatus.INFO_REQUESTED,
        caseType: complianceCase.caseType,
        decisionNote: input.note,
      }).catch((error: unknown) => {
        this.logger.error(
          `Failed to send compliance info-requested email for case ${caseId}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    }

    return {
      id: caseId,
      status: ComplianceCaseStatus.INFO_REQUESTED,
      companyStatus: CompanyStatus.INFO_REQUESTED,
    };
  }

  async escalate(principal: AuthenticatedPrincipal, caseId: string, input: ComplianceDecisionInput) {
    this.ensureDatabase();
    this.scope.assertAdmin(principal);
    if (principal.role !== AdminRole.LOCAL_BDE) {
      throw new ForbiddenException('Only Local BDE uses escalate (G0-4)');
    }
    const complianceCase = await this.loadCaseForAdmin(principal, caseId);
    this.assertCaseActionable(complianceCase.status);

    await this.prisma.complianceCase.update({
      where: { id: caseId },
      data: {
        status: ComplianceCaseStatus.ESCALATED,
        escalatedAt: new Date(),
        decisionNote: input.note,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPLIANCE_ESCALATED,
      actorAdminId: principal.id,
      entityType: 'ComplianceCase',
      entityId: caseId,
      metadata: { note: input.note ?? null },
    });

    return { id: caseId, status: ComplianceCaseStatus.ESCALATED };
  }

  /** Hourly: mark expired docs + suspend vehicle/company when RWC/insurance lapses. */
  async runExpiryWatchdog() {
    if (!this.prisma.isConnected()) {
      return { scanned: 0, expired: 0, suspendedCompanies: 0, suspendedVehicles: 0 };
    }

    const now = new Date();
    const expiredDocs = await this.prisma.complianceDocument.findMany({
      where: {
        expiresAt: { lte: now },
        status: { in: [ComplianceDocStatus.APPROVED, ComplianceDocStatus.UPLOADED, ComplianceDocStatus.UNDER_REVIEW] },
      },
    });

    let suspendedVehicles = 0;
    let suspendedCompanies = 0;

    for (const doc of expiredDocs) {
      await this.prisma.complianceDocument.update({
        where: { id: doc.id },
        data: { status: ComplianceDocStatus.EXPIRED },
      });

      await this.audit.recordPlatform({
        action: AuditAction.COMPLIANCE_DOC_EXPIRED,
        entityType: 'ComplianceDocument',
        entityId: doc.id,
        metadata: { docType: doc.docType, expiresAt: doc.expiresAt },
      });

      if (doc.vehicleId && doc.docType === ComplianceDocType.RWC) {
        await this.prisma.vehicle.update({
          where: { id: doc.vehicleId },
          data: { status: VehicleStatus.SUSPENDED },
        });
        suspendedVehicles += 1;
      } else if (doc.companyId && doc.docType === ComplianceDocType.RWC) {
        // Company-level RWC (no vehicleId) — suspend entire ACTIVE fleet.
        const result = await this.prisma.vehicle.updateMany({
          where: { companyId: doc.companyId, status: VehicleStatus.ACTIVE },
          data: { status: VehicleStatus.SUSPENDED },
        });
        suspendedVehicles += result.count;
      }

      if (
        doc.companyId &&
        (doc.docType === ComplianceDocType.PUBLIC_LIABILITY ||
          doc.docType === ComplianceDocType.CARGO_INSURANCE ||
          doc.docType === ComplianceDocType.RWC)
      ) {
        const company = await this.prisma.company.findUnique({ where: { id: doc.companyId } });
        if (
          company &&
          (company.status === CompanyStatus.BID_ELIGIBLE ||
            company.status === CompanyStatus.ACTIVE)
        ) {
          await this.prisma.company.update({
            where: { id: company.id },
            data: { status: CompanyStatus.SUSPENDED },
          });
          await this.audit.recordPlatform({
            action: AuditAction.COMPANY_SUSPENDED,
            entityType: 'Company',
            entityId: company.id,
            metadata: { reason: 'doc_expiry', docType: doc.docType },
          });
          suspendedCompanies += 1;
        }
      }
    }

    return {
      scanned: expiredDocs.length,
      expired: expiredDocs.length,
      suspendedCompanies,
      suspendedVehicles,
    };
  }
}

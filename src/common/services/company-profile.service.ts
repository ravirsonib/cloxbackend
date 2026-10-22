import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  type Prisma,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';
import {
  AuditAction,
  type CompanyProfileChangeRequestInput,
  type CompanyProfileSelfInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../modules/audit/audit.service';

type CompanyProfileRow = {
  id: string;
  type: CompanyType;
  status: CompanyStatus;
  legalName: string;
  tradingName: string | null;
  abn: string | null;
  acn: string | null;
  email: string | null;
  phone: string | null;
  homeRegionId: string | null;
  homeRegion: { code: string; name: string } | null;
  serviceRegionCodes: string[];
  capabilities: string[];
  senderAccountType: string | null;
  invoiceLegalName: string | null;
  invoiceAddressLine1: string | null;
  invoiceSuburb: string | null;
  invoiceState: string | null;
  invoicePostcode: string | null;
  gstRegistered: boolean;
};

/** Stored on ComplianceCase.proposedChanges (no free-text note). */
export type ProposedCompanyProfileChanges = {
  legalName?: string;
  abn?: string;
  acn?: string | null;
  homeRegionCode?: string;
  invoiceLegalName?: string;
  invoiceAddressLine1?: string;
  invoiceSuburb?: string;
  invoiceState?: string;
  invoicePostcode?: string;
  gstRegistered?: boolean;
};

@Injectable()
export class CompanyProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private assertMarketplacePrincipal(principal: AuthenticatedPrincipal) {
    if (
      principal.kind !== 'user' ||
      (principal.role !== 'TRANSPORT_COMPANY' && principal.role !== 'SENDER')
    ) {
      throw new ForbiddenException('Sender or carrier principal required');
    }
  }

  private assertPostApprovalEditable(company: { type: CompanyType; status: CompanyStatus }) {
    if (company.type === CompanyType.CARRIER) {
      if (company.status !== CompanyStatus.BID_ELIGIBLE) {
        throw new BadRequestException(
          'Company profile self-serve is available after bid-eligible approval',
        );
      }
      return;
    }
    if (company.type === CompanyType.SENDER) {
      if (
        company.status !== CompanyStatus.ACTIVE &&
        company.status !== CompanyStatus.PENDING_PAYMENT
      ) {
        throw new BadRequestException(
          'Company profile self-serve is available after KYB approval',
        );
      }
      return;
    }
    throw new BadRequestException('Unsupported company type for profile');
  }

  private async requireCompany(principal: AuthenticatedPrincipal): Promise<{
    userId: string;
    company: CompanyProfileRow;
  }> {
    this.assertMarketplacePrincipal(principal);
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      select: {
        id: true,
        company: {
          select: {
            id: true,
            type: true,
            status: true,
            legalName: true,
            tradingName: true,
            abn: true,
            acn: true,
            email: true,
            phone: true,
            homeRegionId: true,
            homeRegion: { select: { code: true, name: true } },
            serviceRegionCodes: true,
            capabilities: true,
            senderAccountType: true,
            invoiceLegalName: true,
            invoiceAddressLine1: true,
            invoiceSuburb: true,
            invoiceState: true,
            invoicePostcode: true,
            gstRegistered: true,
          },
        },
      },
    });
    if (!user?.company) {
      throw new NotFoundException('Company not found');
    }
    const expectedType =
      principal.role === 'TRANSPORT_COMPANY' ? CompanyType.CARRIER : CompanyType.SENDER;
    if (user.company.type !== expectedType) {
      throw new ForbiddenException('Company type mismatch for principal');
    }
    return { userId: user.id, company: user.company };
  }

  private toResponse(
    company: CompanyProfileRow,
    pendingChange: {
      id: string;
      status: ComplianceCaseStatus;
      proposedChanges: unknown;
      decisionNote: string | null;
      createdAt: Date;
    } | null,
  ) {
    return {
      company: {
        id: company.id,
        type: company.type,
        status: company.status,
        legalName: company.legalName,
        tradingName: company.tradingName,
        abn: company.abn,
        acn: company.acn,
        email: company.email,
        phone: company.phone,
        homeRegionCode: company.homeRegion?.code ?? null,
        serviceRegionCodes: company.serviceRegionCodes,
        capabilities: company.capabilities,
        senderAccountType: company.senderAccountType,
        invoiceLegalName: company.invoiceLegalName,
        invoiceAddressLine1: company.invoiceAddressLine1,
        invoiceSuburb: company.invoiceSuburb,
        invoiceState: company.invoiceState,
        invoicePostcode: company.invoicePostcode,
        gstRegistered: company.gstRegistered,
      },
      fieldTiers: {
        selfServe: ['tradingName', 'phone', ...(company.type === CompanyType.CARRIER
          ? (['serviceRegionCodes'] as const)
          : [])],
        opsGated:
          company.type === CompanyType.SENDER
            ? [
                'legalName',
                'abn',
                'acn',
                'homeRegionCode',
                'invoiceLegalName',
                'invoiceAddressLine1',
                'invoiceSuburb',
                'invoiceState',
                'invoicePostcode',
                'gstRegistered',
              ]
            : ['legalName', 'abn', 'acn', 'homeRegionCode'],
      },
      pendingChange: pendingChange
        ? {
            id: pendingChange.id,
            status: pendingChange.status,
            proposedChanges: pendingChange.proposedChanges,
            note: pendingChange.decisionNote,
            createdAt: pendingChange.createdAt,
          }
        : null,
    };
  }

  private async findPendingProfileChange(companyId: string) {
    return this.prisma.complianceCase.findFirst({
      where: {
        companyId,
        caseType: ComplianceCaseType.COMPANY_PROFILE_CHANGE,
        status: {
          in: [
            ComplianceCaseStatus.OPEN,
            ComplianceCaseStatus.INFO_REQUESTED,
            ComplianceCaseStatus.ESCALATED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        proposedChanges: true,
        decisionNote: true,
        createdAt: true,
      },
    });
  }

  async getProfile(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const { company } = await this.requireCompany(principal);
    const pendingChange = await this.findPendingProfileChange(company.id);
    return this.toResponse(company, pendingChange);
  }

  async updateSelf(principal: AuthenticatedPrincipal, input: CompanyProfileSelfInput) {
    this.ensureDatabase();
    const { userId, company } = await this.requireCompany(principal);
    this.assertPostApprovalEditable(company);

    const data: Prisma.CompanyUpdateInput = {};
    if (input.tradingName !== undefined) {
      data.tradingName = input.tradingName;
    }
    if (input.phone !== undefined) {
      data.phone = input.phone;
    }
    if (input.serviceRegionCodes !== undefined) {
      if (company.type !== CompanyType.CARRIER) {
        throw new BadRequestException('serviceRegionCodes is only for carriers');
      }
      for (const code of input.serviceRegionCodes) {
        const region = await this.prisma.region.findUnique({ where: { code } });
        if (!region) {
          throw new NotFoundException(`Unknown region ${code}`);
        }
      }
      data.serviceRegionCodes = input.serviceRegionCodes;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No self-serve fields to update');
    }

    await this.prisma.company.update({ where: { id: company.id }, data });
    if (input.phone !== undefined) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { phone: input.phone },
      });
    }

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_PROFILE_SELF_UPDATED,
      actorUserId: userId,
      entityType: 'Company',
      entityId: company.id,
      metadata: data as Prisma.InputJsonValue,
    });

    return this.getProfile(principal);
  }

  private buildProposedPatch(
    company: CompanyProfileRow,
    input: CompanyProfileChangeRequestInput,
  ): ProposedCompanyProfileChanges {
    const patch: ProposedCompanyProfileChanges = {};
    if (input.legalName != null && input.legalName !== company.legalName) {
      patch.legalName = input.legalName;
    }
    if (input.abn != null && input.abn !== (company.abn ?? '')) {
      patch.abn = input.abn;
    }
    if (input.acn !== undefined) {
      const next = input.acn;
      const current = company.acn;
      if (next !== current) {
        patch.acn = next;
      }
    }
    if (
      input.homeRegionCode != null &&
      input.homeRegionCode !== (company.homeRegion?.code ?? '')
    ) {
      patch.homeRegionCode = input.homeRegionCode;
    }

    if (company.type === CompanyType.SENDER) {
      if (
        input.invoiceLegalName != null &&
        input.invoiceLegalName !== (company.invoiceLegalName ?? '')
      ) {
        patch.invoiceLegalName = input.invoiceLegalName;
      }
      if (
        input.invoiceAddressLine1 != null &&
        input.invoiceAddressLine1 !== (company.invoiceAddressLine1 ?? '')
      ) {
        patch.invoiceAddressLine1 = input.invoiceAddressLine1;
      }
      if (
        input.invoiceSuburb != null &&
        input.invoiceSuburb !== (company.invoiceSuburb ?? '')
      ) {
        patch.invoiceSuburb = input.invoiceSuburb;
      }
      if (
        input.invoiceState != null &&
        input.invoiceState !== (company.invoiceState ?? '')
      ) {
        patch.invoiceState = input.invoiceState;
      }
      if (
        input.invoicePostcode != null &&
        input.invoicePostcode !== (company.invoicePostcode ?? '')
      ) {
        patch.invoicePostcode = input.invoicePostcode;
      }
      if (
        input.gstRegistered != null &&
        input.gstRegistered !== company.gstRegistered
      ) {
        patch.gstRegistered = input.gstRegistered;
      }
    } else if (
      input.invoiceLegalName != null ||
      input.invoiceAddressLine1 != null ||
      input.invoiceSuburb != null ||
      input.invoiceState != null ||
      input.invoicePostcode != null ||
      input.gstRegistered != null
    ) {
      throw new BadRequestException('Invoice fields apply to sender companies only');
    }

    return patch;
  }

  async requestChange(
    principal: AuthenticatedPrincipal,
    input: CompanyProfileChangeRequestInput,
  ) {
    this.ensureDatabase();
    const { userId, company } = await this.requireCompany(principal);
    this.assertPostApprovalEditable(company);

    const open = await this.findPendingProfileChange(company.id);
    if (open) {
      throw new BadRequestException('A profile change request is already pending Ops review');
    }

    const proposedChanges = this.buildProposedPatch(company, input);
    if (Object.keys(proposedChanges).length === 0) {
      throw new BadRequestException('No Ops-gated field changes detected');
    }

    if (proposedChanges.homeRegionCode) {
      const region = await this.prisma.region.findUnique({
        where: { code: proposedChanges.homeRegionCode },
      });
      if (!region) {
        throw new NotFoundException(`Unknown region ${proposedChanges.homeRegionCode}`);
      }
    }

    const created = await this.prisma.complianceCase.create({
      data: {
        companyId: company.id,
        caseType: ComplianceCaseType.COMPANY_PROFILE_CHANGE,
        status: ComplianceCaseStatus.OPEN,
        regionId: company.homeRegionId,
        submittedByUserId: userId,
        decisionNote: input.note ?? null,
        proposedChanges: proposedChanges as Prisma.InputJsonValue,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_PROFILE_CHANGE_REQUESTED,
      actorUserId: userId,
      entityType: 'ComplianceCase',
      entityId: created.id,
      metadata: {
        companyId: company.id,
        proposedChanges,
        note: input.note ?? null,
      },
    });

    return this.getProfile(principal);
  }

  /**
   * Apply approved COMPANY_PROFILE_CHANGE patch. Does not alter company status.
   */
  async applyProposedChanges(
    tx: Prisma.TransactionClient,
    companyId: string,
    proposedChanges: unknown,
  ): Promise<ProposedCompanyProfileChanges> {
    if (
      proposedChanges == null ||
      typeof proposedChanges !== 'object' ||
      Array.isArray(proposedChanges)
    ) {
      throw new BadRequestException('Profile change case has no proposedChanges');
    }
    const patch = proposedChanges as ProposedCompanyProfileChanges;
    const data: Prisma.CompanyUpdateInput = {};

    if (patch.legalName != null) data.legalName = patch.legalName;
    if (patch.abn != null) data.abn = patch.abn;
    if (patch.acn !== undefined) data.acn = patch.acn;
    if (patch.invoiceLegalName != null) data.invoiceLegalName = patch.invoiceLegalName;
    if (patch.invoiceAddressLine1 != null) {
      data.invoiceAddressLine1 = patch.invoiceAddressLine1;
    }
    if (patch.invoiceSuburb != null) data.invoiceSuburb = patch.invoiceSuburb;
    if (patch.invoiceState != null) data.invoiceState = patch.invoiceState;
    if (patch.invoicePostcode != null) data.invoicePostcode = patch.invoicePostcode;
    if (patch.gstRegistered != null) data.gstRegistered = patch.gstRegistered;

    if (patch.homeRegionCode != null) {
      const region = await tx.region.findUnique({
        where: { code: patch.homeRegionCode },
      });
      if (!region) {
        throw new BadRequestException(`Unknown region ${patch.homeRegionCode}`);
      }
      data.homeRegion = { connect: { id: region.id } };
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Profile change case has empty proposedChanges');
    }

    await tx.company.update({ where: { id: companyId }, data });
    return patch;
  }
}

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
  PlatformRole,
  SenderAccountType,
  UserStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  type SenderPaymentConfirmInput,
  type SenderProfileInput,
  type SenderRegisterInput,
  type SenderSubmitVerificationInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StripeService } from '../payments/stripe.service';

type CompanyInvoiceShape = {
  invoiceLegalName: string | null;
  invoiceAddressLine1: string | null;
  invoiceSuburb: string | null;
  invoiceState: string | null;
  invoicePostcode: string | null;
};

@Injectable()
export class SenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async requireSender(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'SENDER') {
      throw new ForbiddenException('Sender principal required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: {
        company: {
          include: {
            homeRegion: true,
            complianceCases: {
              orderBy: { createdAt: 'desc' },
              take: 3,
            },
          },
        },
      },
    });
    if (!user?.company || user.company.type !== CompanyType.SENDER) {
      throw new NotFoundException('Sender company not found');
    }
    return user;
  }

  private invoiceComplete(company: CompanyInvoiceShape) {
    return Boolean(
      company.invoiceLegalName &&
        company.invoiceAddressLine1 &&
        company.invoiceSuburb &&
        company.invoiceState &&
        company.invoicePostcode,
    );
  }

  private goNoGo(company: {
    status: CompanyStatus;
    paymentReady: boolean;
  } & CompanyInvoiceShape) {
    const opsApproved =
      company.status === CompanyStatus.PENDING_PAYMENT ||
      company.status === CompanyStatus.ACTIVE;
    const invoiceOk = this.invoiceComplete(company);
    const paymentOk = company.paymentReady;
    const active = company.status === CompanyStatus.ACTIVE;
    return {
      opsApproved,
      invoiceComplete: invoiceOk,
      paymentReady: paymentOk,
      accountActive: active,
      canBook: active && invoiceOk && paymentOk,
    };
  }

  private wizardStep(
    company: {
      status: CompanyStatus;
      senderAccountType: SenderAccountType | null;
      paymentReady: boolean;
    } & CompanyInvoiceShape,
  ): string {
    if (company.status === CompanyStatus.REJECTED) return 'rejected';
    if (company.status === CompanyStatus.SUSPENDED) return 'suspended';
    if (company.status === CompanyStatus.ACTIVE) return 'complete';
    if (company.status === CompanyStatus.PENDING_PAYMENT) return 'payment';
    if (
      company.status === CompanyStatus.PENDING_REVIEW ||
      company.status === CompanyStatus.PENDING_VERIFICATION
    ) {
      return 'waiting_ops';
    }
    // INFO_REQUESTED / DRAFT — editable wizard steps
    if (!company.senderAccountType) return 'account_type';
    if (!this.invoiceComplete(company)) return 'invoice';
    return 'documents';
  }

  async register(input: SenderRegisterInput) {
    this.ensureDatabase();
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const vic = await this.prisma.region.findUnique({ where: { code: 'VIC' } });

    const company = await this.prisma.company.create({
      data: {
        type: CompanyType.SENDER,
        status: CompanyStatus.DRAFT,
        legalName: input.name,
        email: input.email,
        phone: input.phone,
        homeRegionId: vic?.id,
      },
    });

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        phone: input.phone,
        role: PlatformRole.SENDER,
        status: UserStatus.ACTIVE,
        companyId: company.id,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.SENDER_REGISTERED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { email: user.email },
    });

    return {
      ok: true,
      message: 'Sender registered. Request an OTP to sign in and continue onboarding.',
      userId: user.id,
      companyId: company.id,
      email: user.email,
    };
  }

  async getOnboarding(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireSender(principal);
    const company = user.company!;
    const latestCase = company.complianceCases[0] ?? null;
    const goNoGo = this.goNoGo(company);

    return {
      step: this.wizardStep(company),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
      },
      company: {
        id: company.id,
        status: company.status,
        legalName: company.legalName,
        tradingName: company.tradingName,
        abn: company.abn,
        acn: company.acn,
        senderAccountType: company.senderAccountType,
        invoiceLegalName: company.invoiceLegalName,
        invoiceAddressLine1: company.invoiceAddressLine1,
        invoiceSuburb: company.invoiceSuburb,
        invoiceState: company.invoiceState,
        invoicePostcode: company.invoicePostcode,
        gstRegistered: company.gstRegistered,
        paymentReady: company.paymentReady,
        stripeCustomerId: company.stripeCustomerId,
        homeRegionCode: company.homeRegion?.code ?? null,
      },
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
    };
  }

  async updateProfile(principal: AuthenticatedPrincipal, input: SenderProfileInput) {
    this.ensureDatabase();
    const user = await this.requireSender(principal);
    const company = user.company!;

    if (
      company.status !== CompanyStatus.DRAFT &&
      company.status !== CompanyStatus.INFO_REQUESTED
    ) {
      throw new BadRequestException('Profile can only be edited in draft or info-requested');
    }

    const region = await this.prisma.region.findUnique({
      where: { code: input.homeRegionCode },
    });
    if (!region) {
      throw new NotFoundException(`Unknown region ${input.homeRegionCode}`);
    }

    await this.prisma.company.update({
      where: { id: company.id },
      data: {
        senderAccountType: input.accountType as SenderAccountType,
        legalName: input.legalName,
        tradingName: input.tradingName,
        abn: input.abn || null,
        acn: input.acn,
        phone: input.phone,
        homeRegionId: region.id,
        invoiceLegalName: input.invoiceLegalName,
        invoiceAddressLine1: input.invoiceAddressLine1,
        invoiceSuburb: input.invoiceSuburb,
        invoiceState: input.invoiceState,
        invoicePostcode: input.invoicePostcode,
        gstRegistered: input.gstRegistered,
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        phone: input.phone ?? user.phone,
        name: input.legalName,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.SENDER_PROFILE_UPDATED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { accountType: input.accountType },
    });

    return this.getOnboarding(principal);
  }

  async submitVerification(
    principal: AuthenticatedPrincipal,
    input: SenderSubmitVerificationInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireSender(principal);
    const company = user.company!;

    if (!company.senderAccountType) {
      throw new BadRequestException('Set account type before submitting');
    }
    if (!this.invoiceComplete(company)) {
      throw new BadRequestException('Complete invoice profile before submitting');
    }

    const caseType =
      company.senderAccountType === SenderAccountType.BUSINESS
        ? ComplianceCaseType.SENDER_KYB
        : ComplianceCaseType.SENDER_KYC;

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

    if (caseType === ComplianceCaseType.SENDER_KYB) {
      const hasAbnDoc = docs.some((d) => d.docType === ComplianceDocType.ABN_EXTRACT);
      if (!hasAbnDoc && !company.abn) {
        throw new BadRequestException('Business sender requires ABN extract or ABN on profile');
      }
    } else {
      const hasId = docs.some((d) => d.docType === ComplianceDocType.GOVERNMENT_ID);
      if (!hasId) {
        throw new BadRequestException('Individual sender requires GOVERNMENT_ID');
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
            caseType,
            decisionNote: null,
            submittedByUserId: user.id,
          },
        });
      } else {
        complianceCase = await tx.complianceCase.create({
          data: {
            companyId: company.id,
            caseType,
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
      metadata: { caseType, documentIds: input.documentIds },
    });

    return this.getOnboarding(principal);
  }

  async createPaymentSetup(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireSender(principal);
    const company = user.company!;

    if (
      company.status !== CompanyStatus.PENDING_PAYMENT &&
      company.status !== CompanyStatus.ACTIVE
    ) {
      throw new BadRequestException('Payment setup available only after Ops approve');
    }
    if (!this.invoiceComplete(company)) {
      throw new BadRequestException('Invoice profile incomplete');
    }

    let customerId = company.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.createCustomer({
        email: user.email,
        // invoiceComplete() already requires invoiceLegalName
        name: company.invoiceLegalName!,
        metadata: { companyId: company.id, userId: user.id },
      });
      customerId = customer.id;
      await this.prisma.company.update({
        where: { id: company.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const setup = await this.stripe.createSetupIntent(customerId);

    await this.audit.recordPlatform({
      action: AuditAction.SENDER_PAYMENT_SETUP,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { setupIntentId: setup.id, mock: setup.mock },
    });

    return {
      customerId,
      setupIntentId: setup.id,
      clientSecret: setup.clientSecret,
      mock: setup.mock,
      publishableKey: this.config.get('STRIPE_PUBLISHABLE_KEY', { infer: true }) ?? null,
    };
  }

  async confirmPayment(principal: AuthenticatedPrincipal, input: SenderPaymentConfirmInput) {
    this.ensureDatabase();
    const user = await this.requireSender(principal);
    const company = user.company!;

    if (company.status !== CompanyStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Company must be PENDING_PAYMENT to activate');
    }
    if (!company.stripeCustomerId) {
      throw new BadRequestException('Call payment setup first');
    }
    if (!this.invoiceComplete(company)) {
      throw new BadRequestException('Invoice profile incomplete');
    }

    const pmId = input.paymentMethodId ?? (this.stripe.isMockMode() ? 'pm_mock_default' : '');
    if (!pmId) {
      throw new BadRequestException('paymentMethodId is required when Stripe is live');
    }

    const attached = await this.stripe.attachPaymentMethod({
      customerId: company.stripeCustomerId,
      paymentMethodId: pmId,
    });

    await this.prisma.company.update({
      where: { id: company.id },
      data: {
        stripeDefaultPaymentMethodId: attached.paymentMethodId,
        paymentReady: true,
        status: CompanyStatus.ACTIVE,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.SENDER_PAYMENT_READY,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
      metadata: { paymentMethodId: attached.paymentMethodId, mock: attached.mock },
    });
    await this.audit.recordPlatform({
      action: AuditAction.SENDER_ACTIVATED,
      actorUserId: user.id,
      entityType: 'Company',
      entityId: company.id,
    });

    return this.getOnboarding(principal);
  }

  async getBookingEligibility(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireSender(principal);
    const goNoGo = this.goNoGo(user.company!);
    return {
      canBook: goNoGo.canBook,
      goNoGo,
      companyStatus: user.company!.status,
    };
  }
}

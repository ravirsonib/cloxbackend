import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceDocStatus,
  ComplianceDocType,
  SenderAccountType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { SenderService } from './sender.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function senderCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-s',
    type: CompanyType.SENDER,
    status: CompanyStatus.DRAFT,
    legalName: 'Sender Co',
    tradingName: null,
    abn: '51824753556',
    acn: null,
    senderAccountType: SenderAccountType.BUSINESS,
    paymentReady: false,
    gstRegistered: true,
    stripeCustomerId: null,
    stripeDefaultPaymentMethodId: null,
    invoiceLegalName: 'Sender Co',
    invoiceAddressLine1: '1 St',
    invoiceSuburb: 'Melbourne',
    invoiceState: 'VIC',
    invoicePostcode: '3000',
    homeRegionId: 'reg-vic',
    homeRegion: { code: 'VIC' },
    complianceCases: [],
    ...overrides,
  };
}

describe('SenderService register / profile / submit paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: jest.fn().mockReturnValue(true) };
  const config = { get: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new SenderService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('register rejects duplicate email', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1' }) },
    };
    const service = makeService(prisma);
    await expect(
      service.register({
        email: 'sender.clox@yopmail.com',
        name: 'Sender',
        phone: '+61400000000',
        acceptedTerms: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('register creates company + user', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'user-new', email: 'sender.clox@yopmail.com' }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      company: { create: jest.fn().mockResolvedValue({ id: 'co-new' }) },
    };
    const service = makeService(prisma);
    const result = await service.register({
      email: 'sender.clox@yopmail.com',
      name: 'Sender',
      phone: '+61400000000',
      acceptedTerms: true,
    });
    expect(result).toMatchObject({
      ok: true,
      userId: 'user-new',
      companyId: 'co-new',
    });
  });

  it('updateProfile rejects when not draft/info-requested', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'S',
          phone: null,
          company: senderCompany({ status: CompanyStatus.ACTIVE }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.updateProfile(senderPrincipal, {
        accountType: 'BUSINESS',
        legalName: 'Sender Co',
        homeRegionCode: 'VIC',
        invoiceLegalName: 'Sender Co',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
        gstRegistered: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateProfile updates company + user in draft', async () => {
    const company = senderCompany();
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'S',
          phone: null,
          company,
        }),
        update: jest.fn(),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      company: { update: jest.fn() },
    };
    const service = makeService(prisma);
    const result = await service.updateProfile(senderPrincipal, {
      accountType: 'BUSINESS',
      legalName: 'Sender Co Pty',
      abn: '51824753556',
      homeRegionCode: 'VIC',
      invoiceLegalName: 'Sender Co Pty',
      invoiceAddressLine1: '1 St',
      invoiceSuburb: 'Melbourne',
      invoiceState: 'VIC',
      invoicePostcode: '3000',
      gstRegistered: true,
    });
    expect(prisma.company.update).toHaveBeenCalled();
    expect(result.company.legalName).toBeDefined();
  });

  it('submitVerification requires GOVERNMENT_ID for INDIVIDUAL', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'S',
          phone: null,
          company: senderCompany({
            senderAccountType: SenderAccountType.INDIVIDUAL,
            abn: null,
          }),
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            docType: ComplianceDocType.ABN_EXTRACT,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.submitVerification(senderPrincipal, {
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('submitVerification creates OPEN SENDER_KYB case', async () => {
    const company = senderCompany();
    const docId = '11111111-1111-4111-8111-111111111111';
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'S',
          phone: null,
          company,
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: docId,
            docType: ComplianceDocType.ABN_EXTRACT,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: {
            create: jest.fn().mockResolvedValue({
              id: 'case-s',
              status: ComplianceCaseStatus.OPEN,
            }),
          },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const service = makeService(prisma);
    const result = await service.submitVerification(senderPrincipal, {
      documentIds: [docId],
    });
    expect(result).toMatchObject({
      step: 'documents',
      company: expect.objectContaining({ id: 'co-s' }),
      goNoGo: expect.objectContaining({
        invoiceComplete: true,
        paymentReady: false,
      }),
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('updateProfile throws for unknown region', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          name: 'S',
          phone: null,
          company: senderCompany(),
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(
      service.updateProfile(senderPrincipal, {
        accountType: 'BUSINESS',
        legalName: 'Sender Co',
        homeRegionCode: 'ZZZ',
        invoiceLegalName: 'Sender Co',
        invoiceAddressLine1: '1 St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
        gstRegistered: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

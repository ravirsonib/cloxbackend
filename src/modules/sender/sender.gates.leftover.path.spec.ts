import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
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

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
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
    stripeCustomerId: null as string | null,
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

describe('SenderService gate leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createCustomer: jest.fn(),
    createSetupIntent: jest.fn(),
    attachPaymentMethod: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(false),
  };
  const config = { get: jest.fn().mockReturnValue('pk_live') };

  function makeService(prisma: Record<string, unknown>) {
    return new SenderService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('ensureDatabase throws when offline', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(service.getOnboarding(senderPrincipal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('requireSender forbids non-sender and 404s missing company', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.getOnboarding(carrierPrincipal)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', company: null }) },
    };
    await expect(
      makeService(prisma).getOnboarding(senderPrincipal),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('submitVerification rejects missing account type / invoice / docs / ABN / open case', async () => {
    const baseUser = (company: Record<string, unknown>) => ({
      id: 'user-sender',
      email: 'sender@yopmail.com',
      name: 'S',
      phone: null,
      company,
    });

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(senderCompany({ senderAccountType: null })),
          ),
        },
      }).submitVerification(senderPrincipal, { documentIds: ['d1'] }),
    ).rejects.toThrow('Set account type before submitting');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(
              senderCompany({
                invoiceLegalName: null,
                invoiceAddressLine1: null,
              }),
            ),
          ),
        },
      }).submitVerification(senderPrincipal, { documentIds: ['d1'] }),
    ).rejects.toThrow('Complete invoice profile before submitting');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(baseUser(senderCompany())),
        },
        complianceDocument: { findMany: jest.fn().mockResolvedValue([]) },
      }).submitVerification(senderPrincipal, {
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toThrow('All documents must be uploaded for this company');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(senderCompany({ abn: null })),
          ),
        },
        complianceDocument: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: '11111111-1111-4111-8111-111111111111',
              docType: ComplianceDocType.GOVERNMENT_ID,
              status: ComplianceDocStatus.UPLOADED,
            },
          ]),
        },
      }).submitVerification(senderPrincipal, {
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toThrow('Business sender requires ABN extract or ABN on profile');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(baseUser(senderCompany())),
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
        complianceCase: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'case-open',
            status: ComplianceCaseStatus.OPEN,
          }),
        },
      }).submitVerification(senderPrincipal, {
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toThrow('An open compliance case already exists');
  });

  it('submitVerification reopens INFO_REQUESTED case', async () => {
    const docId = '11111111-1111-4111-8111-111111111111';
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
      complianceCase: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-info',
          status: ComplianceCaseStatus.INFO_REQUESTED,
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: {
            update: jest.fn().mockResolvedValue({
              id: 'case-info',
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
    await service.submitVerification(senderPrincipal, { documentIds: [docId] });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('createPaymentSetup rejects incomplete invoice', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          email: 'sender@yopmail.com',
          company: senderCompany({
            status: CompanyStatus.PENDING_PAYMENT,
            invoicePostcode: null,
          }),
        }),
      },
    };
    await expect(
      makeService(prisma).createPaymentSetup(senderPrincipal),
    ).rejects.toThrow('Invoice profile incomplete');
  });

  it('confirmPayment rejects wrong status / missing customer / incomplete invoice / live pm', async () => {
    const baseUser = (company: Record<string, unknown>) => ({
      id: 'user-sender',
      email: 'sender@yopmail.com',
      company,
    });

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(senderCompany({ status: CompanyStatus.ACTIVE })),
          ),
        },
      }).confirmPayment(senderPrincipal, {}),
    ).rejects.toThrow('Company must be PENDING_PAYMENT to activate');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(
              senderCompany({
                status: CompanyStatus.PENDING_PAYMENT,
                stripeCustomerId: null,
              }),
            ),
          ),
        },
      }).confirmPayment(senderPrincipal, {}),
    ).rejects.toThrow('Call payment setup first');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(
              senderCompany({
                status: CompanyStatus.PENDING_PAYMENT,
                stripeCustomerId: 'cus_1',
                invoiceSuburb: null,
              }),
            ),
          ),
        },
      }).confirmPayment(senderPrincipal, {}),
    ).rejects.toThrow('Invoice profile incomplete');

    await expect(
      makeService({
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            baseUser(
              senderCompany({
                status: CompanyStatus.PENDING_PAYMENT,
                stripeCustomerId: 'cus_1',
              }),
            ),
          ),
        },
      }).confirmPayment(senderPrincipal, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

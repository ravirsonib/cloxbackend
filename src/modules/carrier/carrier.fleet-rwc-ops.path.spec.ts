import { BadRequestException } from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { CarrierService } from './carrier.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function carrierCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-c',
    type: CompanyType.CARRIER,
    status: CompanyStatus.DRAFT,
    legalName: 'Carrier Co',
    tradingName: null,
    abn: '51824753556',
    acn: null,
    phone: null,
    homeRegionId: 'reg-vic',
    stripeConnectAccountId: 'acct_1',
    stripeConnectPayoutsEnabled: true,
    capabilities: [] as string[],
    serviceRegionCodes: ['VIC'],
    homeRegion: { code: 'VIC' },
    vehicles: [{ id: 'veh-1', status: 'ACTIVE', label: 'V1', registration: 'ABC' }],
    drivers: [{ status: 'ACTIVE', user: { id: 'u', email: 'd@yopmail.com', name: 'D', phone: null } }],
    complianceCases: [],
    complianceDocuments: [
      { docType: ComplianceDocType.RWC, vehicleId: 'veh-1', id: 'rwc-1' },
    ],
    ...overrides,
  };
}

describe('CarrierService fleet RWC + DG KYB attach', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: () => true };
  const config = { get: () => undefined };
  const drivers = {
    createInviteToken: jest.fn(),
    sendInviteMail: jest.fn(),
    inviteUrl: jest.fn(),
  };

  function makeService(
    prisma: Record<string, unknown>,
    inbox?: { notifyComplianceCaseToOps: jest.Mock },
  ) {
    return new CarrierService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
      drivers as never,
      { sendRegistrationConfirmation: jest.fn().mockResolvedValue({ skipped: true }) } as never,
      {
        resolveInviteForRegister: jest.fn().mockResolvedValue({
          referredByAdminUserId: null,
          inviteId: null,
          prospectId: null,
          homeRegionId: null,
        }),
        markInviteAccepted: jest.fn(),
      } as never,
      inbox as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('submitVerification attaches vehicle RWC ids onto the KYB case', async () => {
    const pl = '11111111-1111-4111-8111-111111111111';
    const cargo = '22222222-2222-4222-8222-222222222222';
    const rwc = '33333333-3333-4333-8333-333333333333';
    const tx = {
      complianceCase: {
        create: jest.fn().mockResolvedValue({ id: 'case-kyb', status: ComplianceCaseStatus.OPEN }),
        update: jest.fn(),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany(),
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockImplementation(async (args: { where?: { docType?: string } }) => {
          if (args?.where?.docType === ComplianceDocType.RWC) {
            return [{ id: rwc, vehicleId: 'veh-1' }];
          }
          return [
            { id: pl, docType: ComplianceDocType.PUBLIC_LIABILITY, status: ComplianceDocStatus.UPLOADED },
            { id: cargo, docType: ComplianceDocType.CARGO_INSURANCE, status: ComplianceDocStatus.UPLOADED },
          ];
        }),
      },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    };

    await makeService(prisma).submitVerification(carrierPrincipal, {
      documentIds: [pl, cargo],
    });
    expect(tx.complianceDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: expect.arrayContaining([pl, cargo, rwc]) } },
        data: expect.objectContaining({
          caseId: 'case-kyb',
          status: ComplianceDocStatus.UNDER_REVIEW,
        }),
      }),
    );
  });

  it('submitVerification requires DG_LICENCE when DG capability set', async () => {
    const pl = '11111111-1111-4111-8111-111111111111';
    const cargo = '22222222-2222-4222-8222-222222222222';
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany({ capabilities: ['DG'] }),
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockImplementation(async (args: { where?: { docType?: string } }) => {
          if (args?.where?.docType === ComplianceDocType.RWC) {
            return [{ id: 'rwc-1', vehicleId: 'veh-1' }];
          }
          return [
            { id: pl, docType: ComplianceDocType.PUBLIC_LIABILITY, status: ComplianceDocStatus.UPLOADED },
            { id: cargo, docType: ComplianceDocType.CARGO_INSURANCE, status: ComplianceDocStatus.UPLOADED },
          ];
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await expect(
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: [pl, cargo] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateCapabilities rejects DG without DG_LICENCE', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany(),
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }) },
      complianceDocument: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).updateCapabilities(carrierPrincipal, {
        capabilities: ['DG'],
        serviceRegionCodes: ['VIC'],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/DG_LICENCE/i),
    });
  });

  it('listVehicles reconciles orphan UPLOADED vehicle RWCs into CARRIER_FLEET_RWC', async () => {
    const company = carrierCompany({ status: CompanyStatus.BID_ELIGIBLE });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company,
        }),
      },
      complianceDocument: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 'orphan-rwc', status: ComplianceDocStatus.UPLOADED },
          ])
          .mockResolvedValueOnce([
            {
              id: 'orphan-rwc',
              vehicleId: 'veh-1',
              companyId: 'co-c',
              status: ComplianceDocStatus.UNDER_REVIEW,
              expiresAt: null,
            },
          ]),
        updateMany: jest.fn(),
      },
      complianceCase: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'case-fleet',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
        }),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'veh-1',
            status: 'ACTIVE',
            label: 'V1',
            registration: 'ABC',
            vehicleClass: 'RIGID_1_2T',
            tareKg: 1,
            gvmKg: 2,
            gcmKg: null,
            disabledAt: null,
            disabledReason: null,
            disabledNote: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      },
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
      proposal: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const inbox = {
      notifyComplianceCaseToOps: jest.fn().mockResolvedValue(2),
    };
    const result = await makeService(prisma, inbox).listVehicles(carrierPrincipal);
    expect(prisma.complianceCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
        }),
      }),
    );
    expect(inbox.notifyComplianceCaseToOps).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-fleet',
        type: 'FLEET_RWC_REVIEW_OPENED',
      }),
    );
    expect(prisma.complianceDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['orphan-rwc'] } },
        data: expect.objectContaining({
          caseId: 'case-fleet',
          status: ComplianceDocStatus.UNDER_REVIEW,
        }),
      }),
    );
    expect(result.items[0].compliance.rwc.state).toBe('OK');
  });
});

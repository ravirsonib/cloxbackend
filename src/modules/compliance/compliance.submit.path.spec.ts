import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AppRole } from '../../shared/types';
import { AbrService } from './abr.service';
import { ComplianceService } from './compliance.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: AppRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

describe('ComplianceService submit + approve/reject happy paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
    assertTerritoryAccess: jest.fn(),
  };
  const abr = { lookupAbn: jest.fn() } as unknown as AbrService;

  function makeService(prisma: Record<string, unknown>) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('submit', () => {
    it('rejects DRIVER principal', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.submit(
          { ...carrierPrincipal, role: 'DRIVER' },
          {
            companyId: 'co-c',
            caseType: ComplianceCaseType.CARRIER_KYB,
            documentIds: ['11111111-1111-4111-8111-111111111111'],
          },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects carrier KYB missing mandatory docs', async () => {
      const prisma = {
        isConnected: () => true,
        company: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'co-c',
            type: CompanyType.CARRIER,
            abn: '51824753556',
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-carrier',
            companyId: 'co-c',
          }),
        },
        complianceDocument: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: '11111111-1111-4111-8111-111111111111',
              docType: ComplianceDocType.PUBLIC_LIABILITY,
              status: ComplianceDocStatus.UPLOADED,
            },
          ]),
        },
      };
      const service = makeService(prisma);
      await expect(
        service.submit(carrierPrincipal, {
          companyId: 'co-c',
          caseType: ComplianceCaseType.CARRIER_KYB,
          documentIds: ['11111111-1111-4111-8111-111111111111'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates OPEN case and PENDING_REVIEW company for carrier KYB', async () => {
      const docIds = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ];
      const prisma = {
        isConnected: () => true,
        company: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'co-c',
            type: CompanyType.CARRIER,
            abn: '51824753556',
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          }),
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-carrier',
            companyId: 'co-c',
          }),
        },
        complianceDocument: {
          findMany: jest.fn().mockResolvedValue([
            { id: docIds[0], docType: ComplianceDocType.PUBLIC_LIABILITY, status: ComplianceDocStatus.UPLOADED },
            { id: docIds[1], docType: ComplianceDocType.CARGO_INSURANCE, status: ComplianceDocStatus.UPLOADED },
            { id: docIds[2], docType: ComplianceDocType.RWC, status: ComplianceDocStatus.UPLOADED },
          ]),
          updateMany: jest.fn(),
        },
        complianceCase: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            complianceCase: {
              create: jest.fn().mockResolvedValue({
                id: 'case-1',
                status: ComplianceCaseStatus.OPEN,
                caseType: ComplianceCaseType.CARRIER_KYB,
              }),
            },
            complianceDocument: { updateMany: jest.fn() },
            company: { update: jest.fn() },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      const result = await service.submit(carrierPrincipal, {
        companyId: 'co-c',
        caseType: ComplianceCaseType.CARRIER_KYB,
        documentIds: docIds,
      });
      expect(result).toEqual({
        id: 'case-1',
        status: ComplianceCaseStatus.OPEN,
        caseType: ComplianceCaseType.CARRIER_KYB,
        companyStatus: CompanyStatus.PENDING_REVIEW,
      });
      expect(audit.recordPlatform).toHaveBeenCalled();
    });
  });

  describe('approve / reject', () => {
    function openCase(type: CompanyType) {
      return {
        id: 'case-1',
        status: ComplianceCaseStatus.OPEN,
        companyId: 'co-1',
        company: {
          id: 'co-1',
          type,
          status: CompanyStatus.PENDING_REVIEW,
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        },
        region: { code: 'VIC' },
        documents: [],
      };
    }

    it('approve carrier → BID_ELIGIBLE', async () => {
      const prisma = {
        isConnected: () => true,
        complianceCase: {
          findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.CARRIER)),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            complianceCase: { update: jest.fn() },
            complianceDocument: { updateMany: jest.fn() },
            company: { update: jest.fn() },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      const result = await service.approve(superAdmin, 'case-1', { note: 'ok' });
      expect(result).toEqual({
        id: 'case-1',
        status: ComplianceCaseStatus.APPROVED,
        companyStatus: CompanyStatus.BID_ELIGIBLE,
      });
    });

    it('approve sender → PENDING_PAYMENT', async () => {
      const prisma = {
        isConnected: () => true,
        complianceCase: {
          findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.SENDER)),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            complianceCase: { update: jest.fn() },
            complianceDocument: { updateMany: jest.fn() },
            company: { update: jest.fn() },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      const result = await service.approve(superAdmin, 'case-1', {});
      expect(result.companyStatus).toBe(CompanyStatus.PENDING_PAYMENT);
    });

    it('reject sets company REJECTED', async () => {
      const prisma = {
        isConnected: () => true,
        complianceCase: {
          findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.CARRIER)),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            complianceCase: { update: jest.fn() },
            complianceDocument: { updateMany: jest.fn() },
            company: { update: jest.fn() },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      await expect(
        service.reject(superAdmin, 'case-1', { note: 'bad docs' }),
      ).resolves.toEqual({
        id: 'case-1',
        status: ComplianceCaseStatus.REJECTED,
        companyStatus: CompanyStatus.REJECTED,
      });
    });
  });
});

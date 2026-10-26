import { ForbiddenException } from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  DriverStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';
import { ComplianceService } from './compliance.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'super@yopmail.com',
  role: AdminRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const stateMaster: AuthenticatedPrincipal = {
  id: 'admin-state',
  email: 'state@yopmail.com',
  role: AdminRole.STATE_MASTER,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
};

describe('ComplianceService CARRIER_FLEET_RWC + CARRIER_DRIVER_LICENCE', () => {
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
  };
  const notifications = {
    sendComplianceDecisionEmail: jest.fn(),
  };
  const attribution = {
    assertLocalOwnsCompany: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      attribution as never,
      abr as never,
      notifications as never,
      { applyProposedChanges: jest.fn() } as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('approve fleet RWC activates PENDING_REVIEW vehicles; company unchanged', async () => {
    const txVehicle = { updateMany: jest.fn() };
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-fleet',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
          companyId: 'co-c',
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [{ id: 'rwc-1', vehicleId: 'veh-1' }],
        }),
        update: jest.fn(),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
          vehicle: txVehicle,
          driver: { updateMany: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const result = await makeService(prisma).approve(superAdmin, 'case-fleet', {
      note: 'fleet ok',
    });
    expect(result).toEqual({
      id: 'case-fleet',
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: CompanyStatus.BID_ELIGIBLE,
    });
    expect(prisma.company.update).not.toHaveBeenCalled();
    expect(txVehicle.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['veh-1'] },
        companyId: 'co-c',
        status: VehicleStatus.PENDING_REVIEW,
      },
      data: { status: VehicleStatus.ACTIVE },
    });
  });

  it('State Master cannot approve CARRIER_FLEET_RWC', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-fleet',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
          companyId: 'co-c',
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [],
        }),
      },
    };
    await expect(
      makeService(prisma).approve(stateMaster, 'case-fleet', { note: 'no' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approve CARRIER_DRIVER_LICENCE activates PENDING_REVIEW drivers', async () => {
    const txDriver = { updateMany: jest.fn() };
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-drv',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
          companyId: 'co-c',
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [{ id: 'lic-1', driverId: 'drv-1' }],
        }),
        update: jest.fn(),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
          vehicle: { updateMany: jest.fn() },
          driver: txDriver,
        };
        return fn(tx);
      }),
    };

    const result = await makeService(prisma).approve(superAdmin, 'case-drv', {
      note: 'licence ok',
    });
    expect(result).toEqual({
      id: 'case-drv',
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: CompanyStatus.BID_ELIGIBLE,
    });
    expect(txDriver.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['drv-1'] },
        companyId: 'co-c',
        status: DriverStatus.PENDING_REVIEW,
      },
      data: { status: DriverStatus.ACTIVE },
    });
  });

  it('State Master cannot approve CARRIER_DRIVER_LICENCE', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-drv',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
          companyId: 'co-c',
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [],
        }),
      },
    };
    await expect(
      makeService(prisma).approve(stateMaster, 'case-drv', { note: 'no' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getCase includes vehicle registration for RWC docs', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-kyb',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_KYB,
          companyId: 'co-c',
          infoRequestedAt: null,
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.PENDING_REVIEW,
            abn: '51824753556',
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [
            {
              id: 'rwc-1',
              docType: 'RWC',
              vehicleId: 'veh-1',
              driverId: null,
              status: ComplianceDocStatus.UNDER_REVIEW,
              createdAt: new Date('2026-10-22T00:00:00Z'),
              originalFilename: 'rwc.pdf',
              expiresAt: null,
            },
          ],
        }),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'veh-1', registration: 'ABC123', label: 'Primary', status: VehicleStatus.ACTIVE },
        ]),
      },
      driver: { findMany: jest.fn() },
    };

    const result = await makeService(prisma).getCase(superAdmin, 'case-kyb');
    expect(result.documents[0]).toMatchObject({
      id: 'rwc-1',
      vehicleRegistration: 'ABC123',
      vehicleLabel: 'Primary',
      vehicleStatus: VehicleStatus.ACTIVE,
    });
  });

  it('getCase includes driver identity for licence docs', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-drv',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
          companyId: 'co-c',
          infoRequestedAt: null,
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            abn: null,
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [
            {
              id: 'lic-1',
              docType: 'DRIVER_LICENCE',
              vehicleId: null,
              driverId: 'drv-1',
              status: ComplianceDocStatus.UNDER_REVIEW,
              createdAt: new Date('2026-10-22T00:00:00Z'),
              originalFilename: 'licence.pdf',
              expiresAt: null,
            },
          ],
        }),
      },
      vehicle: { findMany: jest.fn() },
      driver: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'drv-1',
            status: DriverStatus.PENDING_REVIEW,
            licenceClass: 'HC',
            user: { email: 'd@yopmail.com', name: 'Driver One' },
          },
        ]),
      },
    };

    const result = await makeService(prisma).getCase(superAdmin, 'case-drv');
    expect(result.documents[0]).toMatchObject({
      id: 'lic-1',
      driverEmail: 'd@yopmail.com',
      driverName: 'Driver One',
      driverLicenceClass: 'HC',
      driverStatus: DriverStatus.PENDING_REVIEW,
    });
  });
});

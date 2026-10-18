import {
  ComplianceDocStatus,
  ComplianceDocType,
  CompanyStatus,
  VehicleStatus,
} from '@prisma/client';
import { ComplianceService } from './compliance.service';

describe('ComplianceService.runExpiryWatchdog leftover edges', () => {
  const audit = { recordPlatform: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      {} as never,
      { lookupAbn: jest.fn() } as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('suspends vehicle for expired per-vehicle RWC', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-v',
            docType: ComplianceDocType.RWC,
            vehicleId: 'veh-1',
            companyId: 'co-1',
            expiresAt: new Date('2020-01-01'),
            status: ComplianceDocStatus.APPROVED,
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      vehicle: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          status: CompanyStatus.ACTIVE,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const result = await makeService(prisma).runExpiryWatchdog();
    expect(result).toMatchObject({
      scanned: 1,
      expired: 1,
      suspendedVehicles: 1,
      suspendedCompanies: 1,
    });
    expect(prisma.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'veh-1' },
      data: { status: VehicleStatus.SUSPENDED },
    });
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('suspends company for expired PUBLIC_LIABILITY when BID_ELIGIBLE', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-pl',
            docType: ComplianceDocType.PUBLIC_LIABILITY,
            vehicleId: null,
            companyId: 'co-1',
            expiresAt: new Date('2020-01-01'),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      vehicle: { update: jest.fn(), updateMany: jest.fn() },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          status: CompanyStatus.BID_ELIGIBLE,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const result = await makeService(prisma).runExpiryWatchdog();
    expect(result.suspendedCompanies).toBe(1);
    expect(result.suspendedVehicles).toBe(0);
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { status: CompanyStatus.SUSPENDED },
    });
  });

  it('does not suspend company when status is PENDING_REVIEW', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-cargo',
            docType: ComplianceDocType.CARGO_INSURANCE,
            vehicleId: null,
            companyId: 'co-1',
            expiresAt: new Date('2020-01-01'),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      vehicle: { update: jest.fn(), updateMany: jest.fn() },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          status: CompanyStatus.PENDING_REVIEW,
        }),
        update: jest.fn(),
      },
    };
    const result = await makeService(prisma).runExpiryWatchdog();
    expect(result.expired).toBe(1);
    expect(result.suspendedCompanies).toBe(0);
    expect(prisma.company.update).not.toHaveBeenCalled();
  });
});

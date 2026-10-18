import { ComplianceDocType, ComplianceDocStatus, CompanyStatus, VehicleStatus } from '@prisma/client';
import { ComplianceService } from './compliance.service';

describe('ComplianceService.runExpiryWatchdog paths', () => {
  it('returns zeros when DB disconnected', async () => {
    const service = new ComplianceService(
      { isConnected: () => false } as never,
      { recordPlatform: jest.fn() } as never,
      {} as never,
      { lookupAbn: jest.fn() } as never,
    );
    await expect(service.runExpiryWatchdog()).resolves.toEqual({
      scanned: 0,
      expired: 0,
      suspendedCompanies: 0,
      suspendedVehicles: 0,
    });
  });

  it('expires RWC without vehicleId and suspends ACTIVE fleet', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-rwc',
            docType: ComplianceDocType.RWC,
            vehicleId: null,
            companyId: 'co-1',
            expiresAt: new Date('2020-01-01'),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      vehicle: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          status: CompanyStatus.BID_ELIGIBLE,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new ComplianceService(
      prisma as never,
      audit as never,
      {} as never,
      { lookupAbn: jest.fn() } as never,
    );

    const result = await service.runExpiryWatchdog();
    expect(result.expired).toBe(1);
    expect(result.suspendedVehicles).toBe(2);
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({
      where: { companyId: 'co-1', status: VehicleStatus.ACTIVE },
      data: { status: VehicleStatus.SUSPENDED },
    });
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { status: CompanyStatus.SUSPENDED },
    });
  });
});

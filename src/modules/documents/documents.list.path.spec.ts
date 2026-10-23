import { ForbiddenException } from '@nestjs/common';
import { ComplianceDocStatus } from '@prisma/client';
import { DocumentsService } from './documents.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ComplianceDocType } from '../../shared/types';

describe('DocumentsService.listDocuments', () => {
  const driver: AuthenticatedPrincipal = {
    id: 'user-d1',
    email: 'driver@yopmail.com',
    role: 'DRIVER',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  const carrier: AuthenticatedPrincipal = {
    id: 'user-c1',
    email: 'carrier@yopmail.com',
    role: 'TRANSPORT_COMPANY',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  function makeService(prisma: Record<string, unknown>) {
    return new DocumentsService(
      prisma as never,
      { get: () => 'v1' } as never,
      { recordPlatform: jest.fn() } as never,
      {
        assertRegionAccess: jest.fn(),
        allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      } as never,
      { assertLocalOwnsCompany: jest.fn() } as never,
    );
  }

  it('scopes driver list to self and forbids other driverId', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-d1', companyId: 'co-1' }),
      },
      driver: {
        findUnique: jest.fn().mockResolvedValue({ id: 'drv-1', companyId: 'co-1' }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'drv-1',
            user: { name: 'Alex Driver', email: 'driver@yopmail.com' },
          },
        ]),
      },
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-1',
            companyId: 'co-1',
            driverId: 'drv-1',
            vehicleId: null,
            docType: ComplianceDocType.DRIVER_LICENCE,
            status: ComplianceDocStatus.UPLOADED,
            mimeType: 'application/pdf',
            sizeBytes: 10,
            originalFilename: 'licence.pdf',
            contentHash: 'abc',
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      },
    };

    const service = makeService(prisma);
    const result = await service.listDocuments(driver, { companyId: 'co-1' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      ownerKind: 'driver',
      driverName: 'Alex Driver',
      driverEmail: 'driver@yopmail.com',
    });
    expect(prisma.complianceDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ driverId: 'drv-1' }),
      }),
    );

    await expect(
      service.listDocuments(driver, { companyId: 'co-1', driverId: 'drv-other' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lists company docs for carrier and filters by driverId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-c1', companyId: 'co-1' }),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({ id: 'drv-1' }),
      },
      complianceDocument: { findMany },
    };

    const service = makeService(prisma);
    await service.listDocuments(carrier, { companyId: 'co-1' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          status: { not: ComplianceDocStatus.UPLOAD_PENDING },
        }),
        orderBy: { updatedAt: 'desc' },
      }),
    );
    expect(findMany.mock.calls[0][0].where.driverId).toBeUndefined();

    await service.listDocuments(carrier, { companyId: 'co-1', driverId: 'drv-1' });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ driverId: 'drv-1' }),
      }),
    );
  });
});

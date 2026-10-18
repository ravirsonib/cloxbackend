import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ComplianceDocStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminRole, ComplianceDocType } from '../../shared/types';
import { DocumentsService } from './documents.service';

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const driver: AuthenticatedPrincipal = {
  id: 'user-driver',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
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

describe('DocumentsService ACL / mime leftover paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertRegionAccess: jest.fn(),
    assertTerritoryAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new DocumentsService(
      prisma as never,
      {
        get: (key: string) => {
          if (key === 'STORAGE_LOCAL_DIR') return 'D:/tmp/clox-docs';
          if (key === 'API_PREFIX') return 'v1';
          return undefined;
        },
      } as never,
      audit as never,
      scope as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('404 when company missing on upload intent', async () => {
    const prisma = {
      isConnected: () => true,
      company: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).createUploadIntent(carrier, {
        companyId: 'missing',
        docType: ComplianceDocType.PUBLIC_LIABILITY,
        originalFilename: 'pl.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forbids non-Super when company has no region', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: null,
          homeRegionId: null,
        }),
      },
    };
    await expect(
      makeService(prisma).createUploadIntent(stateMaster, {
        companyId: 'co-c',
        docType: ComplianceDocType.PUBLIC_LIABILITY,
        originalFilename: 'pl.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({ message: 'Company has no region — Super only' });
  });

  it('rejects insufficient upload role', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-x',
          companyId: 'co-c',
        }),
      },
    };
    await expect(
      makeService(prisma).createUploadIntent(
        { ...carrier, role: 'RECEIVER' as never, id: 'user-x' },
        {
          companyId: 'co-c',
          docType: ComplianceDocType.PUBLIC_LIABILITY,
          originalFilename: 'pl.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 100,
        },
      ),
    ).rejects.toMatchObject({ message: 'Insufficient role for document upload' });
  });

  it('rejects vehicleId / driverId outside company', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          companyId: 'co-c',
        }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'veh-other',
          companyId: 'co-other',
        }),
      },
      driver: { findUnique: jest.fn() },
    };
    await expect(
      makeService(prisma).createUploadIntent(carrier, {
        companyId: 'co-c',
        docType: ComplianceDocType.RWC,
        originalFilename: 'rwc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        vehicleId: 'veh-other',
      }),
    ).rejects.toMatchObject({ message: 'vehicleId must belong to companyId' });

    prisma.vehicle.findUnique.mockResolvedValue(null);
    prisma.driver.findUnique.mockResolvedValue({
      id: 'drv-other',
      companyId: 'co-other',
    });
    await expect(
      makeService(prisma).createUploadIntent(carrier, {
        companyId: 'co-c',
        docType: ComplianceDocType.DRIVER_LICENCE,
        originalFilename: 'lic.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        driverId: 'drv-other',
      }),
    ).rejects.toMatchObject({ message: 'driverId must belong to companyId' });
  });

  it('driver cannot attach vehicleId; forces self driverId', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          companyId: 'co-c',
        }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'veh-1',
          companyId: 'co-c',
        }),
      },
      driver: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'drv-1',
          companyId: 'co-c',
        }),
      },
    };
    await expect(
      makeService(prisma).createUploadIntent(driver, {
        companyId: 'co-c',
        docType: ComplianceDocType.DRIVER_LICENCE,
        originalFilename: 'lic.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        vehicleId: 'veh-1',
      }),
    ).rejects.toMatchObject({ message: 'Drivers cannot attach vehicleId' });
  });

  it('driver not in company / other driverId forbidden', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          companyId: 'co-c',
        }),
      },
      driver: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'drv-1', companyId: 'co-other' }),
      },
    };
    await expect(
      makeService(prisma).createUploadIntent(driver, {
        companyId: 'co-c',
        docType: ComplianceDocType.DRIVER_LICENCE,
        originalFilename: 'lic.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({ message: 'Driver not in company' });
  });

  it.each([
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/jpeg', '.jpg'],
  ] as const)('maps %s → %s storage key', async (mime, ext) => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          companyId: 'co-c',
        }),
      },
      complianceDocument: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          ...data,
          status: ComplianceDocStatus.UPLOAD_PENDING,
        })),
      },
    };
    const result = await makeService(prisma).createUploadIntent(carrier, {
      companyId: 'co-c',
      docType: ComplianceDocType.PUBLIC_LIABILITY,
      originalFilename: `doc${ext}`,
      mimeType: mime,
      sizeBytes: 50,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(result.storageKey?.endsWith(ext)).toBe(true);
    expect(prisma.complianceDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: mime,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('getMetadata forbids other driver document', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-c',
          docType: ComplianceDocType.DRIVER_LICENCE,
          driverId: 'drv-other',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          originalFilename: 'x.pdf',
          contentHash: 'abc',
          expiresAt: null,
          createdAt: new Date(),
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          companyId: 'co-c',
        }),
      },
      driver: {
        findUnique: jest.fn().mockResolvedValue({ id: 'drv-1' }),
      },
    };
    await expect(
      makeService(prisma).getMetadata(driver, 'doc-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

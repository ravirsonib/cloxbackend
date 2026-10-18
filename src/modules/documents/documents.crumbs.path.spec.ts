jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  access: jest.fn().mockResolvedValue(undefined),
}));

import { createHash } from 'crypto';
import { ComplianceDocStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const localBde: AuthenticatedPrincipal = {
  id: 'admin-bde',
  email: 'bde@yopmail.com',
  role: 'LOCAL_BDE',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('DocumentsService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertRegionAccess: jest.fn(),
    assertTerritoryAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
  };

  function configGet(key: string) {
    if (key === 'STORAGE_LOCAL_DIR') return 'D:/tmp/clox-docs-test';
    if (key === 'API_PREFIX') return 'v1';
    return undefined;
  }

  function makeService(prisma: Record<string, unknown>) {
    return new DocumentsService(
      prisma as never,
      { get: configGet } as never,
      audit as never,
      scope as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    scope.allowedTerritoryCodes.mockReturnValue(null);
  });

  it('LOCAL_BDE with null territory scope returns early', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
      complianceDocument: {
        create: jest.fn().mockResolvedValue({
          id: 'doc-1',
          status: ComplianceDocStatus.UPLOAD_PENDING,
          storageKey: 'co-c/doc-1.pdf',
          docType: 'PUBLIC_LIABILITY',
          mimeType: 'application/pdf',
        }),
      },
    };
    scope.allowedTerritoryCodes.mockReturnValue(null);
    await makeService(prisma).createUploadIntent(localBde, {
      companyId: 'co-c',
      docType: 'PUBLIC_LIABILITY',
      originalFilename: 'pl.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    expect(prisma.complianceDocument.create).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-bde',
        actorUserId: undefined,
      }),
    );
  });

  it('company-level RWC without vehicleId; admin intent without expiresAt', async () => {
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
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-c' }),
      },
      vehicle: { findUnique: jest.fn() },
      driver: { findUnique: jest.fn() },
      complianceDocument: {
        create: jest.fn().mockResolvedValue({
          id: 'doc-rwc',
          status: ComplianceDocStatus.UPLOAD_PENDING,
          storageKey: 'co-c/rwc.pdf',
          docType: 'RWC',
          mimeType: 'application/pdf',
        }),
      },
    };
    await makeService(prisma).createUploadIntent(carrier, {
      companyId: 'co-c',
      docType: 'RWC',
      originalFilename: 'rwc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 200,
    });
    expect(prisma.complianceDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: null,
          driverId: null,
          expiresAt: null,
          uploadedByUserId: 'user-carrier',
        }),
      }),
    );

    await makeService(prisma).createUploadIntent(superAdmin, {
      companyId: 'co-c',
      docType: 'PUBLIC_LIABILITY',
      originalFilename: 'pl.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
      }),
    );
  });

  it('admin putContent: null sizeBytes default + empty originalname fallback', async () => {
    const buffer = Buffer.from('admin-doc');
    const expectedHash = createHash('sha256').update(buffer).digest('hex');
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-c',
          storageKey: 'co-c/doc-1.pdf',
          status: ComplianceDocStatus.UPLOAD_PENDING,
          mimeType: 'application/pdf',
          sizeBytes: null,
          originalFilename: 'kept.pdf',
          driverId: null,
          docType: 'PUBLIC_LIABILITY',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'doc-1',
          status: ComplianceDocStatus.UPLOADED,
          contentHash: expectedHash,
          sizeBytes: buffer.length,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
    };
    await makeService(prisma).putContent(superAdmin, 'doc-1', {
      buffer,
      mimetype: 'application/pdf',
      size: buffer.length,
      originalname: '',
    });
    expect(prisma.complianceDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originalFilename: 'kept.pdf',
          contentHash: expectedHash,
        }),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
      }),
    );
  });

  it('admin confirm records actorAdminId', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-c',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
          contentHash: 'abc123',
          driverId: null,
        }),
        update: jest.fn().mockResolvedValue({
          id: 'doc-1',
          status: ComplianceDocStatus.UPLOADED,
          contentHash: 'abc123',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-vic',
        }),
      },
    };
    await makeService(prisma).confirm(superAdmin, 'doc-1', { contentHash: 'abc123' });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
      }),
    );
  });
});

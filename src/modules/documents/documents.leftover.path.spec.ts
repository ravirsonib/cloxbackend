jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  access: jest.fn().mockResolvedValue(undefined),
}));

import { existsSync, mkdirSync } from 'fs';
import { access } from 'fs/promises';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

describe('DocumentsService leftover ACL / storage paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertRegionAccess: jest.fn(),
    assertTerritoryAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
  };

  function configGet(key: string) {
    if (key === 'STORAGE_LOCAL_DIR') return 'D:/tmp/clox-docs-test';
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

  it('ensureDatabase throws when prisma disconnected', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(service.getMetadata(carrier, 'doc-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('absolutePath rejects traversal outside storage root', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.openExists('../etc/passwd')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('assertCompanyAccess: company missing → 404', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'missing',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
        }),
      },
      company: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(carrier, 'doc-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('admin with regionless company: non-Super forbidden', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegionId: null,
          homeRegion: null,
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.getMetadata(
        { ...localBde, role: 'STATE_MASTER' as never },
        'doc-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Super admin can read regionless company metadata', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          originalFilename: 'a.pdf',
          contentHash: 'abc',
          expiresAt: null,
          createdAt: new Date(),
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegionId: null,
          homeRegion: null,
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(superAdmin, 'doc-1')).resolves.toMatchObject({
      id: 'doc-1',
      companyId: 'co-1',
    });
  });

  it('Local BDE denied when no territory scope', async () => {
    scope.allowedTerritoryCodes.mockReturnValue([]);
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegionId: 'reg-1',
          homeRegion: { code: 'VIC' },
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(localBde, 'doc-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('Local BDE allowed via linked job origin territory', async () => {
    scope.allowedTerritoryCodes.mockReturnValue(['MEL']);
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          originalFilename: 'a.pdf',
          contentHash: 'abc',
          expiresAt: null,
          createdAt: new Date(),
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegionId: 'reg-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          originTerritory: { code: 'MEL' },
        }),
      },
      localTerritory: { findFirst: jest.fn() },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(localBde, 'doc-1')).resolves.toMatchObject({
      id: 'doc-1',
    });
    expect(scope.assertTerritoryAccess).toHaveBeenCalledWith(localBde, 'MEL');
  });

  it('Local BDE falls back to home-region territory match', async () => {
    scope.allowedTerritoryCodes.mockReturnValue(['MEL']);
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          originalFilename: 'a.pdf',
          contentHash: 'abc',
          expiresAt: null,
          createdAt: new Date(),
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegionId: 'reg-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      localTerritory: {
        findFirst: jest.fn().mockResolvedValue({ code: 'MEL', enabled: true }),
      },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(localBde, 'doc-1')).resolves.toMatchObject({
      id: 'doc-1',
    });
  });

  it('Local BDE forbidden when no job and no territory match', async () => {
    scope.allowedTerritoryCodes.mockReturnValue(['MEL']);
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegionId: 'reg-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      localTerritory: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(localBde, 'doc-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('putContent rejects non-UPLOAD_PENDING and size overrun', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          storageKey: 'co-1/a.pdf',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 100,
          docType: 'PUBLIC_LIABILITY',
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', companyId: 'co-1' }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.putContent(carrier, 'doc-1', {
        buffer: Buffer.from('x'),
        mimetype: 'application/pdf',
        size: 1,
        originalname: 'a.pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.complianceDocument.findUnique.mockResolvedValue({
      id: 'doc-1',
      companyId: 'co-1',
      storageKey: 'co-1/a.pdf',
      status: ComplianceDocStatus.UPLOAD_PENDING,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      docType: 'PUBLIC_LIABILITY',
    });
    await expect(
      service.putContent(carrier, 'doc-1', {
        buffer: Buffer.from('too-big-content'),
        mimetype: 'application/pdf',
        size: 99,
        originalname: 'a.pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('confirm 404 when document missing company', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({ id: 'doc-1', companyId: null }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.confirm(carrier, 'doc-1', { contentHash: 'abc' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ensureStorageDir creates root when missing', () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    const service = makeService({ isConnected: () => true });
    service.ensureStorageDir();
    expect(mkdirSync).toHaveBeenCalled();
  });

  it('ensureStorageDir skips mkdir when root exists', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    const service = makeService({ isConnected: () => true });
    service.ensureStorageDir();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('openExists resolves absolute path after access', async () => {
    (access as jest.Mock).mockResolvedValue(undefined);
    const service = makeService({ isConnected: () => true });
    const full = await service.openExists('co-1/file.pdf');
    expect(full.replace(/\\/g, '/')).toContain('clox-docs-test');
    expect(full.replace(/\\/g, '/')).toContain('co-1/file.pdf');
  });
});

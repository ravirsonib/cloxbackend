import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ComplianceDocStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';

const carrier: AuthenticatedPrincipal = {
  id: 'u1',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('DocumentsService confirm success + getMetadata', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertRegionAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new DocumentsService(
      prisma as never,
      { get: () => 'v1' } as never,
      audit as never,
      scope as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('confirm succeeds on hash match for UPLOADED doc', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
          contentHash: 'AbC123',
          mimeType: 'application/pdf',
          sizeBytes: 100,
          driverId: null,
        }),
        update: jest.fn().mockResolvedValue({
          id: 'doc-1',
          status: ComplianceDocStatus.UPLOADED,
          contentHash: 'AbC123',
          mimeType: 'application/pdf',
          sizeBytes: 100,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', companyId: 'co-1' }),
      },
    };
    const service = makeService(prisma);
    const result = await service.confirm(carrier, 'doc-1', { contentHash: 'abc123' });
    expect(result).toMatchObject({
      id: 'doc-1',
      status: ComplianceDocStatus.UPLOADED,
      contentHash: 'AbC123',
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('confirm rejects hash mismatch', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UPLOADED,
          contentHash: 'expected',
          driverId: null,
        }),
        update: jest.fn(),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', companyId: 'co-1' }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.confirm(carrier, 'doc-1', { contentHash: 'wrong' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.complianceDocument.update).not.toHaveBeenCalled();
  });

  it('getMetadata returns fields for company member', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'RWC',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 50,
          originalFilename: 'rwc.pdf',
          contentHash: 'h1',
          expiresAt: null,
          createdAt: new Date('2026-01-01'),
          driverId: null,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', companyId: 'co-1' }),
      },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(carrier, 'doc-1')).resolves.toMatchObject({
      id: 'doc-1',
      docType: 'RWC',
      originalFilename: 'rwc.pdf',
    });
  });

  it('getMetadata throws when document missing', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(service.getMetadata(carrier, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getContent streams uploaded file for company member', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const root = mkdtempSync(join(tmpdir(), 'clox-doc-'));
    const storageKey = 'co-1/doc-1.pdf';
    mkdirSync(join(root, 'co-1'), { recursive: true });
    writeFileSync(join(root, storageKey), Buffer.from('%PDF-1.4 test'));

    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          storageKey,
          docType: 'RWC',
          status: ComplianceDocStatus.UPLOADED,
          mimeType: 'application/pdf',
          sizeBytes: 14,
          originalFilename: 'rwc.pdf',
          driverId: null,
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', companyId: 'co-1' }),
      },
    };
    const service = new DocumentsService(
      prisma as never,
      { get: (key: string) => (key === 'STORAGE_LOCAL_DIR' ? root : 'v1') } as never,
      audit as never,
      scope as never,
    );
    try {
      const file = await service.getContent(carrier, 'doc-1');
      expect(file.mimeType).toBe('application/pdf');
      expect(file.filename).toBe('rwc.pdf');
      await new Promise<void>((resolve, reject) => {
        file.stream.once('error', reject);
        file.stream.once('open', () => {
          file.stream.once('close', () => resolve());
          file.stream.destroy();
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('getContent rejects UPLOAD_PENDING', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          storageKey: 'co-1/doc-1.pdf',
          status: ComplianceDocStatus.UPLOAD_PENDING,
          mimeType: 'application/pdf',
          driverId: null,
          docType: 'RWC',
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', companyId: 'co-1' }),
      },
    };
    const service = makeService(prisma);
    await expect(service.getContent(carrier, 'doc-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

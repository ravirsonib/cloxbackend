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
});

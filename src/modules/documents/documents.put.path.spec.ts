jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  access: jest.fn().mockResolvedValue(undefined),
}));

import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { BadRequestException } from '@nestjs/common';
import { ComplianceDocStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('DocumentsService upload intent + putContent paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertRegionAccess: jest.fn(),
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
  });

  describe('createUploadIntent', () => {
    it('rejects unsupported mime at service gate', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.createUploadIntent(carrier, {
          companyId: 'co-c',
          docType: 'PUBLIC_LIABILITY',
          originalFilename: 'x.exe',
          mimeType: 'application/octet-stream',
          sizeBytes: 100,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects over 10MB', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.createUploadIntent(carrier, {
          companyId: 'co-c',
          docType: 'PUBLIC_LIABILITY',
          originalFilename: 'big.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 11 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates UPLOAD_PENDING doc and returns uploadUrl', async () => {
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
      const service = makeService(prisma);
      const result = await service.createUploadIntent(carrier, {
        companyId: 'co-c',
        docType: 'PUBLIC_LIABILITY',
        originalFilename: 'pl.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      });
      expect(result.status).toBe(ComplianceDocStatus.UPLOAD_PENDING);
      expect(result.uploadUrl).toMatch(/^\/v1\/documents\/.+\/content$/);
      expect(result.uploadField).toBe('file');
      expect(result.storageKey).toContain('co-c/');
      expect(result.storageKey?.endsWith('.pdf')).toBe(true);
      expect(audit.recordPlatform).toHaveBeenCalled();
    });

    it('rejects DRIVER uploading company KYB doc type', async () => {
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
      };
      const service = makeService(prisma);
      await expect(
        service.createUploadIntent(
          {
            ...carrier,
            id: 'user-driver',
            email: 'driver@yopmail.com',
            role: 'DRIVER',
          },
          {
            companyId: 'co-c',
            docType: 'PUBLIC_LIABILITY',
            originalFilename: 'pl.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 100,
          },
        ),
      ).rejects.toMatchObject({
        message: 'Drivers cannot upload company KYB documents',
      });
    });
  });

  describe('putContent', () => {
    it('rejects missing file', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.putContent(carrier, 'doc-1', undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when not UPLOAD_PENDING', async () => {
      const prisma = {
        isConnected: () => true,
        complianceDocument: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'doc-1',
            companyId: 'co-c',
            storageKey: 'co-c/doc-1.pdf',
            status: ComplianceDocStatus.UPLOADED,
            mimeType: 'application/pdf',
            sizeBytes: 1000,
            driverId: null,
          }),
        },
      };
      const service = makeService(prisma);
      await expect(
        service.putContent(carrier, 'doc-1', {
          buffer: Buffer.from('%PDF'),
          mimetype: 'application/pdf',
          size: 4,
          originalname: 'a.pdf',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('writes file, hashes content, marks UPLOADED', async () => {
      const buffer = Buffer.from('hello-doc-bytes');
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
            sizeBytes: 1000,
            originalFilename: 'pl.pdf',
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
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-carrier',
            companyId: 'co-c',
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.putContent(carrier, 'doc-1', {
        buffer,
        mimetype: 'application/pdf',
        size: buffer.length,
        originalname: 'pl.pdf',
      });
      expect(mkdir).toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalled();
      expect(result).toEqual({
        id: 'doc-1',
        status: ComplianceDocStatus.UPLOADED,
        contentHash: expectedHash,
        sizeBytes: buffer.length,
      });
      expect(audit.recordPlatform).toHaveBeenCalled();
    });

    it('rejects mime mismatch vs intent', async () => {
      const prisma = {
        isConnected: () => true,
        complianceDocument: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'doc-1',
            companyId: 'co-c',
            storageKey: 'co-c/doc-1.pdf',
            status: ComplianceDocStatus.UPLOAD_PENDING,
            mimeType: 'application/pdf',
            sizeBytes: 1000,
            driverId: null,
            docType: 'PUBLIC_LIABILITY',
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
            id: 'user-carrier',
            companyId: 'co-c',
          }),
        },
      };
      const service = makeService(prisma);
      await expect(
        service.putContent(carrier, 'doc-1', {
          buffer: Buffer.from('x'),
          mimetype: 'image/png',
          size: 1,
          originalname: 'x.png',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

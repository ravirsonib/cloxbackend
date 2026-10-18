import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ComplianceDocStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
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

const localBde: AuthenticatedPrincipal = {
  id: 'admin-bde',
  email: 'bde@yopmail.com',
  role: 'LOCAL_BDE',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

describe('DocumentsService ACL leftovers batch 2', () => {
  const audit = { recordPlatform: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('/tmp/uploads') };
  const scope = {
    assertRegionAccess: jest.fn(),
    assertTerritoryAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(['MEL']),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new DocumentsService(
      prisma as never,
      config as never,
      audit as never,
      scope as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('assertCompanyAccess rejects non-member sender', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-1',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'other' }),
      },
    };
    await expect(
      makeService(prisma).createUploadIntent(sender, {
        companyId: 'co-1',
        docType: 'ABN_EXTRACT',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      } as never),
    ).rejects.toThrow('Not a member of this company');
  });

  it('LOCAL_BDE blocked when company has no homeRegionId and no linked job', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
          homeRegionId: null,
        }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).createUploadIntent(localBde, {
        companyId: 'co-1',
        docType: 'ABN_EXTRACT',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      } as never),
    ).rejects.toThrow('Company has no territory assignment — Super/State only');
  });

  it('driver putContent requires driver profile', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          storageKey: 'k',
          status: ComplianceDocStatus.UPLOAD_PENDING,
          mimeType: 'image/jpeg',
          sizeBytes: 1000,
          docType: 'GOVERNMENT_ID',
          driverId: 'drv-1',
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-1',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-driver', companyId: 'co-1' }),
      },
      driver: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).putContent(driver, 'doc-1', {
        buffer: Buffer.from('x'),
        mimetype: 'image/jpeg',
        size: 1,
        originalname: 'a.jpg',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('driver createUploadIntent rejects attaching another driverId', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-1',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-driver', companyId: 'co-1' }),
      },
      driver: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'drv-other', companyId: 'co-1' })
          .mockResolvedValueOnce({ id: 'drv-self', companyId: 'co-1' }),
      },
    };
    await expect(
      makeService(prisma).createUploadIntent(driver, {
        companyId: 'co-1',
        docType: 'GOVERNMENT_ID',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        driverId: 'drv-other',
      } as never),
    ).rejects.toThrow('Drivers may only attach their own driverId');
  });

  it('putContent 404 when document missing storageKey', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          storageKey: null,
          status: ComplianceDocStatus.UPLOAD_PENDING,
        }),
      },
    };
    await expect(
      makeService(prisma).putContent(sender, 'doc-1', {
        buffer: Buffer.from('x'),
        mimetype: 'application/pdf',
        size: 1,
        originalname: 'a.pdf',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { ForbiddenException } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

describe('DocumentsService driver ownership (D2)', () => {
  const driver: AuthenticatedPrincipal = {
    id: 'user-d1',
    email: 'driver@yopmail.com',
    role: 'DRIVER',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  it('rejects metadata when driverId is null', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'DRIVER_LICENCE',
          status: 'UPLOADED',
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
        findUnique: jest.fn().mockResolvedValue({ id: 'user-d1', companyId: 'co-1' }),
      },
      driver: {
        findUnique: jest.fn().mockResolvedValue({ id: 'drv-1' }),
      },
    };
    const service = new DocumentsService(
      prisma as never,
      { get: () => 'v1' } as never,
      { recordPlatform: jest.fn() } as never,
      {
        assertRegionAccess: jest.fn(),
        allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      } as never,
    );

    await expect(service.getMetadata(driver, 'doc-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

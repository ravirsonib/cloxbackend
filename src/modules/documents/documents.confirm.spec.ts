import { BadRequestException } from '@nestjs/common';
import { ComplianceDocStatus } from '@prisma/client';
import { DocumentsService } from './documents.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

describe('DocumentsService.confirm status gate', () => {
  const carrier: AuthenticatedPrincipal = {
    id: 'u1',
    email: 'carrier@yopmail.com',
    role: 'TRANSPORT_COMPANY',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  it('refuses confirm when document is UNDER_REVIEW', async () => {
    const prisma = {
      isConnected: () => true,
      complianceDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          companyId: 'co-1',
          docType: 'PUBLIC_LIABILITY',
          status: ComplianceDocStatus.UNDER_REVIEW,
          contentHash: 'abc',
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
    const service = new DocumentsService(
      prisma as never,
      { get: () => 'v1' } as never,
      { recordPlatform: jest.fn() } as never,
      {
        assertRegionAccess: jest.fn(),
        allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      } as never,
    );

    await expect(
      service.confirm(carrier, 'doc-1', { contentHash: 'abc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.complianceDocument.update).not.toHaveBeenCalled();
  });
});

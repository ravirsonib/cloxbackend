import { BadRequestException } from '@nestjs/common';
import { DocumentsService } from './documents.service';

describe('DocumentsService.createUploadIntent linked IDs', () => {
  const carrier = {
    id: 'u1',
    email: 'carrier.clox@yopmail.com',
    role: 'TRANSPORT_COMPANY' as const,
    kind: 'user' as const,
    regionCodes: [] as string[],
    territoryCodes: [] as string[],
  };

  it('rejects vehicleId not belonging to company', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          homeRegion: { code: 'VIC' },
          homeRegionId: 'r1',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', companyId: 'co-1' }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ id: 'v-other', companyId: 'co-OTHER' }),
      },
      driver: { findUnique: jest.fn() },
      complianceDocument: { create: jest.fn() },
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
      service.createUploadIntent(carrier, {
        companyId: 'co-1',
        docType: 'RWC',
        originalFilename: 'rwc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        vehicleId: 'v-other',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.complianceDocument.create).not.toHaveBeenCalled();
  });
});

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuditAction } from '../../shared/types';

describe('AdminService — Vehicle Classes CRUD', () => {
  let service: AdminService;
  let prisma: any;
  let audit: any;

  beforeEach(() => {
    prisma = {
      isConnected: jest.fn().mockReturnValue(true),
      vehicleClassConfig: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
        count: jest.fn(),
      },
      vehicle: {
        count: jest.fn().mockResolvedValue(0),
      },
      job: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    audit = {
      recordPlatform: jest.fn().mockResolvedValue(undefined),
    };
    service = new AdminService(prisma as never, audit as never, {} as never);
  });

  it('listVehicleClasses returns existing classes', async () => {
    prisma.vehicleClassConfig.findMany.mockResolvedValueOnce([
      {
        id: 'vc-1',
        code: 'UTE',
        name: 'Ute',
        rank: 1,
        maxChargeableWeightKg: 1000,
        maxLengthCm: 240,
        maxWidthCm: 180,
        maxHeightCm: 150,
        minLicenceClass: 'C',
        suggestedGvmKg: 3500,
        suggestedTareKg: 2000,
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const res = await service.listVehicleClasses();
    expect(res).toHaveLength(1);
    expect(res[0].code).toBe('UTE');
    expect(res[0].rank).toBe(1);
  });

  it('createVehicleClass creates class and records audit', async () => {
    prisma.vehicleClassConfig.findUnique.mockResolvedValueOnce(null);
    prisma.vehicleClassConfig.create.mockResolvedValueOnce({
      id: 'vc-new',
      code: 'RIGID_8T',
      name: 'Rigid 8T',
      rank: 5,
      maxChargeableWeightKg: 8000,
      maxLengthCm: 800,
      maxWidthCm: 250,
      maxHeightCm: 260,
      minLicenceClass: 'MR',
      suggestedGvmKg: 18000,
      suggestedTareKg: 8000,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await service.createVehicleClass(
      {
        code: 'RIGID_8T',
        name: 'Rigid 8T',
        rank: 5,
        maxChargeableWeightKg: 8000,
        maxLengthCm: 800,
        maxWidthCm: 250,
        maxHeightCm: 260,
        minLicenceClass: 'MR',
        suggestedGvmKg: 18000,
        suggestedTareKg: 8000,
        isActive: true,
      },
      'admin-1',
    );

    expect(res.code).toBe('RIGID_8T');
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.VEHICLE_CLASS_CREATED,
        actorAdminId: 'admin-1',
        entityType: 'VehicleClassConfig',
      }),
    );
  });

  it('createVehicleClass throws ConflictException on duplicate code', async () => {
    prisma.vehicleClassConfig.findUnique.mockResolvedValueOnce({ id: 'existing', code: 'UTE' });

    await expect(
      service.createVehicleClass(
        {
          code: 'UTE',
          name: 'Ute Duplicate',
          rank: 1,
          maxChargeableWeightKg: 1000,
          maxLengthCm: 240,
          maxWidthCm: 180,
          maxHeightCm: 150,
          minLicenceClass: 'C',
          suggestedGvmKg: 3500,
          suggestedTareKg: 2000,
          isActive: true,
        },
        'admin-1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('updateVehicleClass updates attributes and records audit', async () => {
    prisma.vehicleClassConfig.findUnique.mockResolvedValueOnce({
      id: 'vc-1',
      code: 'UTE',
      name: 'Old Ute',
      rank: 1,
    });
    prisma.vehicleClassConfig.update.mockResolvedValueOnce({
      id: 'vc-1',
      code: 'UTE',
      name: 'Updated Ute (up to 1.2t)',
      rank: 1,
      maxChargeableWeightKg: 1200,
      maxLengthCm: 250,
      maxWidthCm: 180,
      maxHeightCm: 150,
      minLicenceClass: 'C',
      suggestedGvmKg: 3500,
      suggestedTareKg: 2000,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await service.updateVehicleClass(
      'vc-1',
      { name: 'Updated Ute (up to 1.2t)', maxChargeableWeightKg: 1200 },
      'admin-1',
    );

    expect(res.name).toBe('Updated Ute (up to 1.2t)');
    expect(res.maxChargeableWeightKg).toBe(1200);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.VEHICLE_CLASS_UPDATED,
        actorAdminId: 'admin-1',
        entityId: 'vc-1',
      }),
    );
  });

  it('deleteVehicleClass throws BadRequestException if vehicles reference it', async () => {
    prisma.vehicleClassConfig.findUnique.mockResolvedValueOnce({
      id: 'vc-1',
      code: 'UTE',
      name: 'Ute',
    });
    prisma.vehicle.count.mockResolvedValueOnce(3);

    await expect(service.deleteVehicleClass('vc-1', 'admin-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.vehicleClassConfig.delete).not.toHaveBeenCalled();
  });

  it('deleteVehicleClass deletes and logs audit if unused', async () => {
    prisma.vehicleClassConfig.findUnique.mockResolvedValueOnce({
      id: 'vc-del',
      code: 'TEST_CLASS',
      name: 'Test Class',
    });
    prisma.vehicle.count.mockResolvedValueOnce(0);
    prisma.job.count.mockResolvedValueOnce(0);
    prisma.vehicleClassConfig.delete.mockResolvedValueOnce({});

    const res = await service.deleteVehicleClass('vc-del', 'admin-1');
    expect(res.success).toBe(true);
    expect(res.deletedCode).toBe('TEST_CLASS');
    expect(prisma.vehicleClassConfig.delete).toHaveBeenCalledWith({ where: { id: 'vc-del' } });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.VEHICLE_CLASS_DELETED,
        actorAdminId: 'admin-1',
      }),
    );
  });
});

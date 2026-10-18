import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('recordPlatform returns null when DB disconnected', async () => {
    const service = new AuditService({ isConnected: () => false } as never);
    await expect(
      service.recordPlatform({ action: 'test.action', entityType: 'X', entityId: '1' }),
    ).resolves.toBeNull();
  });

  it('recordPlatform creates AuditEvent when connected', async () => {
    const prisma = {
      isConnected: () => true,
      auditEvent: {
        create: jest.fn().mockResolvedValue({ id: 'ae-1' }),
      },
    };
    const service = new AuditService(prisma as never);
    await service.recordPlatform({
      action: 'job.created',
      actorUserId: 'u1',
      entityType: 'Job',
      entityId: 'j1',
    });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'job.created',
          actorUserId: 'u1',
          entityType: 'Job',
          entityId: 'j1',
        }),
      }),
    );
  });
});

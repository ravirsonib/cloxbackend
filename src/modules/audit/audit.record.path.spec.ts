import { AuditService } from './audit.service';

describe('AuditService record leftovers', () => {
  it('record returns null when DB disconnected', async () => {
    const service = new AuditService({ isConnected: () => false } as never);
    await expect(
      service.record({ action: 'lead.created', leadId: 'lead-1' }),
    ).resolves.toBeNull();
  });

  it('record creates LeadEvent when connected', async () => {
    const prisma = {
      isConnected: () => true,
      leadEvent: {
        create: jest.fn().mockResolvedValue({ id: 'le-1' }),
      },
    };
    const service = new AuditService(prisma as never);
    await service.record({
      action: 'lead.submitted',
      leadId: 'lead-1',
      actorId: 'user-1',
      metadata: { source: 'web' },
    });
    expect(prisma.leadEvent.create).toHaveBeenCalledWith({
      data: {
        action: 'lead.submitted',
        leadId: 'lead-1',
        actorId: 'user-1',
        metadata: { source: 'web' },
      },
    });
  });
});

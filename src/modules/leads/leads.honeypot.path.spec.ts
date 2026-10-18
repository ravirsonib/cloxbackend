import { LeadsService } from './leads.service';

describe('LeadsService leftover honeypot paths', () => {
  const audit = { record: jest.fn(), recordPlatform: jest.fn() };
  const notifications = {
    notifyLeadSubmitted: jest.fn().mockResolvedValue({ skipped: true }),
  };

  function makeService(prisma: Record<string, unknown> = { isConnected: () => true }) {
    return new LeadsService(prisma as never, audit as never, notifications as never);
  }

  it('honeypot on registry returns fake success without DB write', async () => {
    const prisma = {
      isConnected: () => true,
      lead: { create: jest.fn(), findFirst: jest.fn() },
    };
    const service = makeService(prisma);
    const result = await service.createRegistryLead(
      {
        userType: 'sender',
        email: 'bot@yopmail.com',
        phone: '0400000000',
        abn: '51824753556',
        companyLegalName: 'Bot Co',
        locale: 'en',
        source: 'web',
        honeypot: 'filled',
      } as never,
      { ip: '1.1.1.1' },
    );
    expect(result.id).toBeTruthy();
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('honeypot on eoi + investor returns fake success', async () => {
    const prisma = {
      isConnected: () => true,
      lead: { create: jest.fn() },
    };
    const service = makeService(prisma);
    await expect(
      service.createEoiLead(
        {
          email: 'bot@yopmail.com',
          phone: '0400000000',
          fullName: 'Bot',
          eoiType: 'EOI_STATE_MASTER',
          state: 'VIC',
          locale: 'en',
          source: 'web',
          honeypot: 'x',
        } as never,
        {},
      ),
    ).resolves.toMatchObject({ status: expect.any(String) });
    await expect(
      service.createInvestorLead(
        {
          email: 'bot@yopmail.com',
          phone: '0400000000',
          fullName: 'Bot',
          chequeSizeBand: 'UNDER_250K',
          locale: 'en',
          source: 'web',
          honeypot: 'x',
        } as never,
        {},
      ),
    ).resolves.toMatchObject({ id: expect.any(String) });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });
});

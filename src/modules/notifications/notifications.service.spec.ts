import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  it('sendMail skips when SMTP_USER/PASS missing', async () => {
    const service = new NotificationsService({
      get: () => undefined,
    } as never);
    await expect(
      service.sendMail({ to: 'clox.mail@yopmail.com', subject: 'Hi', text: 'body' }),
    ).resolves.toEqual({ skipped: true });
  });

  it('sendOtpEmail delegates to sendMail skip path', async () => {
    const service = new NotificationsService({
      get: () => undefined,
    } as never);
    await expect(
      service.sendOtpEmail({ to: 'clox.mail@yopmail.com', code: '123456', ttlMinutes: 10 }),
    ).resolves.toEqual({ skipped: true });
  });

  it('notifyLeadSubmitted CCs INVEST_NOTIFY_EMAIL for INVESTOR when distinct', async () => {
    const get = jest.fn((key: string) => {
      if (key === 'INVEST_NOTIFY_EMAIL') return 'invest@clox.com';
      return undefined;
    });
    const service = new NotificationsService({ get } as never);
    const result = await service.notifyLeadSubmitted({
      type: 'INVESTOR',
      leadId: 'lead-1',
      email: 'founder.clox@yopmail.com',
      companyName: 'X Co',
    });
    expect(result).toEqual({ skipped: true });
    expect(get).toHaveBeenCalledWith('INVEST_NOTIFY_EMAIL', { infer: true });
  });

  it('sendDriverInviteEmail skips without SMTP', async () => {
    const service = new NotificationsService({
      get: () => undefined,
    } as never);
    await expect(
      service.sendDriverInviteEmail({
        to: 'driver.invite@yopmail.com',
        driverName: 'Sam',
        companyName: 'Carrier',
        inviteUrl: 'https://example/invite',
        expiresHours: 48,
      }),
    ).resolves.toEqual({ skipped: true });
  });
});

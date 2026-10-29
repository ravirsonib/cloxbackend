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
      get: (key: string) => (key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
    } as never);
    await expect(
      service.sendDriverInviteEmail({
        to: 'driver.invite@yopmail.com',
        driverName: 'Sam',
        companyName: 'Carrier',
        inviteUrl: 'http://localhost:5174/driver/invite/token',
        expiresHours: 48,
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('sendRegistrationConfirmation skips without SMTP and includes account type', async () => {
    const service = new NotificationsService({
      get: (key: string) => (key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
    } as never);
    await expect(
      service.sendRegistrationConfirmation({
        to: 'carrier@yopmail.com',
        name: 'Acme Haulage',
        accountType: 'TRANSPORT_COMPANY',
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('sendComplianceApprovedEmail skips without SMTP', async () => {
    const service = new NotificationsService({
      get: (key: string) => (key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
    } as never);
    await expect(
      service.sendComplianceApprovedEmail({
        to: 'carrier@yopmail.com',
        companyName: 'Acme Haulage',
        companyType: 'CARRIER',
        companyStatus: 'BID_ELIGIBLE',
        caseType: 'CARRIER_KYB',
        decisionNote: 'Looks good',
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('sendComplianceInfoRequestedEmail skips without SMTP', async () => {
    const service = new NotificationsService({
      get: (key: string) => (key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
    } as never);
    await expect(
      service.sendComplianceInfoRequestedEmail({
        to: 'carrier@yopmail.com',
        companyName: 'Acme Haulage',
        companyType: 'CARRIER',
        caseType: 'CARRIER_KYB',
        decisionNote: 'Please upload a clearer RWC PDF',
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('sendComplianceInfoRequestedEmail CTA goes through login with switch', async () => {
    const service = new NotificationsService({
      get: (key: string) => (key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
    } as never);
    const branded = jest
      .spyOn(service as never, 'sendBranded' as never)
      .mockResolvedValue({ skipped: false } as never);
    await service.sendComplianceInfoRequestedEmail({
      to: 'Carrier@Yopmail.com',
      companyName: 'Acme Haulage',
      companyType: 'CARRIER',
      caseType: 'CARRIER_KYB',
      decisionNote: 'Need clearer RWC',
    });
    const href = (branded.mock.calls[0]?.[0] as { cta?: { href?: string } } | undefined)?.cta
      ?.href;
    expect(href).toContain('http://localhost:5174/login?');
    expect(href).toContain('email=carrier%40yopmail.com');
    expect(href).toContain('next=%2Fdocuments%2Fupload');
    expect(href).toContain('switch=1');
    branded.mockRestore();
  });

  it('notifyJobPublishedToCarriers deep-links market board via login', async () => {
    const service = new NotificationsService({
      get: (key: string) => (key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
    } as never);
    const branded = jest
      .spyOn(service as never, 'sendBranded' as never)
      .mockResolvedValue({ skipped: true } as never);
    const result = await service.notifyJobPublishedToCarriers({
      carrierEmails: ['carrier@yopmail.com', 'carrier@yopmail.com'],
      jobId: 'job-1',
      jobTitle: 'VIC van run',
      minVehicleClass: 'VAN',
      originRegionCode: 'VIC',
      pickupAt: new Date('2026-11-01T09:00:00.000Z'),
      estimateIncGstCents: 12_000,
      requiresDg: false,
    });
    expect(result.notified).toBe(1);
    const href = (branded.mock.calls[0]?.[0] as { cta?: { href?: string } } | undefined)?.cta
      ?.href;
    expect(href).toContain('next=%2Fmarket');
    branded.mockRestore();
  });
});

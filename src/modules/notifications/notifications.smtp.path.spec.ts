jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(),
  },
}));

import nodemailer from 'nodemailer';
import { NotificationsService } from './notifications.service';

describe('NotificationsService SMTP leftovers', () => {
  const sendMail = jest.fn().mockResolvedValue({ response: '250 OK' });

  beforeEach(() => {
    jest.clearAllMocks();
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
  });

  function configGet(map: Record<string, unknown>) {
    return jest.fn((key: string) => map[key]);
  }

  it('sendMail delivers when SMTP configured and reuses transporter', async () => {
    const get = configGet({
      SMTP_USER: 'smtp@yopmail.com',
      SMTP_PASS: 'secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      MAIL_FROM: 'CLOX <noreply@clox.com.au>',
    });
    const service = new NotificationsService({ get } as never);

    const first = await service.sendMail({
      to: 'dest.clox@yopmail.com',
      subject: 'Hello',
      text: 'body',
      html: '<p>body</p>',
      cc: 'cc.clox@yopmail.com',
    });
    const second = await service.sendOtpEmail({
      to: 'dest.clox@yopmail.com',
      code: '424242',
      ttlMinutes: 5,
    });

    expect(first).toEqual({ skipped: false });
    expect(second).toEqual({ skipped: false });
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'CLOX <noreply@clox.com.au>',
        to: 'dest.clox@yopmail.com',
        cc: 'cc.clox@yopmail.com',
        subject: 'Hello',
      }),
    );
  });

  it('fromAddress falls back to SMTP_USER then default', async () => {
    const get = configGet({
      SMTP_USER: 'smtp@yopmail.com',
      SMTP_PASS: 'secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      MAIL_FROM: undefined,
    });
    const service = new NotificationsService({ get } as never);
    await service.sendMail({
      to: 'dest.clox@yopmail.com',
      subject: 'No from',
      text: 'x',
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'smtp@yopmail.com' }),
    );
  });

  it('notifyLeadSubmitted omits CC when notify email matches submitter', async () => {
    const get = configGet({
      SMTP_USER: 'smtp@yopmail.com',
      SMTP_PASS: 'secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      MAIL_FROM: 'CLOX <noreply@clox.com.au>',
      INVEST_NOTIFY_EMAIL: 'founder.clox@yopmail.com',
    });
    const service = new NotificationsService({ get } as never);
    await service.notifyLeadSubmitted({
      type: 'INVESTOR',
      leadId: 'lead-9',
      email: 'founder.clox@yopmail.com',
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'founder.clox@yopmail.com',
        cc: undefined,
        subject: 'CLOX submission received (INVESTOR)',
      }),
    );
  });

  it('notifyLeadSubmitted without companyName still sends', async () => {
    const get = configGet({
      SMTP_USER: 'smtp@yopmail.com',
      SMTP_PASS: 'secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      MAIL_FROM: 'CLOX <noreply@clox.com.au>',
      INVEST_NOTIFY_EMAIL: undefined,
    });
    const service = new NotificationsService({ get } as never);
    await service.notifyLeadSubmitted({
      type: 'REGISTRY',
      leadId: 'lead-2',
      email: 'reg.clox@yopmail.com',
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'reg.clox@yopmail.com',
        subject: 'CLOX submission received (REGISTRY)',
      }),
    );
    const html = (sendMail.mock.calls[0][0] as { html: string }).html;
    expect(html).not.toContain('Company:');
  });
});

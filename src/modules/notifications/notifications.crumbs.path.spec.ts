jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(),
  },
}));

import nodemailer from 'nodemailer';
import { NotificationsService } from './notifications.service';

describe('NotificationsService crumb branch leftovers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fromAddress default when MAIL_FROM and SMTP_USER missing; response ok fallback', async () => {
    const sendMail = jest.fn().mockResolvedValue({ response: undefined });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

    const mutable: Record<string, unknown> = {
      SMTP_USER: 'smtp@yopmail.com',
      SMTP_PASS: 'secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      MAIL_FROM: 'from@yopmail.com',
    };
    const service = new NotificationsService({
      get: (k: string) => mutable[k],
    } as never);

    // Warm transporter while SMTP is configured
    await service.sendMail({ to: 'a@yopmail.com', subject: 'warm', text: 'x' });

    mutable.MAIL_FROM = undefined;
    mutable.SMTP_USER = undefined;
    await service.sendMail({ to: 'b@yopmail.com', subject: 'default-from', text: 'y' });
    expect(sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: 'CLOX <noreply@clox.com.au>' }),
    );
  });
});

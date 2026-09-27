import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppEnv } from '../../config/env.validation';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private getTransporter(): Transporter | null {
    const user = this.config.get('SMTP_USER', { infer: true });
    const pass = this.config.get('SMTP_PASS', { infer: true });

    if (!user || !pass) {
      return null;
    }

    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.get('SMTP_HOST', { infer: true }),
        port: this.config.get('SMTP_PORT', { infer: true }),
        secure: this.config.get('SMTP_SECURE', { infer: true }),
        auth: { user, pass },
      });
    }

    return this.transporter;
  }

  private fromAddress(): string {
    return (
      this.config.get('MAIL_FROM', { infer: true }) ||
      this.config.get('SMTP_USER', { infer: true }) ||
      'CLOX <noreply@clox.com.au>'
    );
  }

  async sendMail(params: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    cc?: string;
  }) {
    const transporter = this.getTransporter();
    if (!transporter) {
      this.logger.warn(
        `SMTP not configured — skipped email to ${params.to}: ${params.subject}`,
      );
      return { skipped: true as const };
    }

    const info = await transporter.sendMail({
      from: this.fromAddress(),
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });

    this.logger.log(
      `Email sent to ${params.to}: ${params.subject} (${info.response ?? 'ok'})`,
    );

    return { skipped: false as const };
  }

  async sendOtpEmail(params: { to: string; code: string; ttlMinutes: number }) {
    const subject = 'CLOX Super Admin login code';
    const text = `Your CLOX login code is ${params.code}. It expires in ${params.ttlMinutes} minutes.`;
    const html = `<p>Your CLOX login code is <strong>${params.code}</strong>.</p><p>It expires in ${params.ttlMinutes} minutes.</p>`;
    return this.sendMail({ to: params.to, subject, text, html });
  }

  async notifyLeadSubmitted(params: {
    type: string;
    leadId: string;
    email: string;
    companyName?: string | null;
  }) {
    const investNotify = this.config.get('INVEST_NOTIFY_EMAIL', { infer: true });
    const submitter = params.email.trim().toLowerCase();
    const cc =
      params.type === 'INVESTOR' &&
      investNotify &&
      investNotify.toLowerCase() !== submitter
        ? investNotify
        : undefined;

    const subject = `CLOX submission received (${params.type})`;
    const text = [
      `Thanks — we received your CLOX pre-launch submission.`,
      `Type: ${params.type}`,
      `Reference: ${params.leadId}`,
      `Email: ${params.email}`,
      params.companyName ? `Company: ${params.companyName}` : undefined,
      '',
      'Our team will review your details and follow up if needed.',
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    const html = [
      `<p>Thanks — we received your CLOX pre-launch submission.</p>`,
      `<p><strong>Type:</strong> ${params.type}<br/>`,
      `<strong>Reference:</strong> ${params.leadId}<br/>`,
      `<strong>Email:</strong> ${params.email}`,
      params.companyName ? `<br/><strong>Company:</strong> ${params.companyName}` : '',
      `</p>`,
      `<p>Our team will review your details and follow up if needed.</p>`,
    ].join('');

    return this.sendMail({ to: params.email, cc, subject, text, html });
  }
}

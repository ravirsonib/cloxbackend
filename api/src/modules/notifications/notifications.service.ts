import { existsSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppEnv } from '../../config/env.validation';

const SUPPORT_EMAIL = 'info@clox.com.au';
const COMPANY_LINE =
  'Achieve Global Enterprises Pty Ltd trading as CLOX Freight Forwarding';
const ABN_LINE = 'ABN 48 626 269 387';

type LeadEmailKind =
  | 'REGISTRY_SENDER'
  | 'REGISTRY_CARRIER'
  | 'EOI_STATE_MASTER'
  | 'EOI_LOCAL_BDE'
  | 'INVESTOR'
  | string;

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

  private logoPath(): string | null {
    const candidates = [
      // nest start / prod (compiled next to dist/assets or src/assets)
      join(__dirname, '..', '..', 'assets', 'email', 'logo-clox-light.png'),
      join(__dirname, '..', '..', 'assets', 'email', 'logo-clox.png'),
      // repo root when running from api/api
      join(process.cwd(), 'assets', 'email', 'logo-clox-light.png'),
      join(process.cwd(), 'assets', 'email', 'logo-clox.png'),
      join(process.cwd(), 'src', 'assets', 'email', 'logo-clox-light.png'),
      join(process.cwd(), 'src', 'assets', 'email', 'logo-clox.png'),
    ];
    return candidates.find((path) => existsSync(path)) ?? null;
  }

  private leadLabel(type: LeadEmailKind): string {
    switch (type) {
      case 'REGISTRY_SENDER':
        return 'Sender / Shipper Registry';
      case 'REGISTRY_CARRIER':
        return 'Carrier / Transport Registry';
      case 'EOI_STATE_MASTER':
        return 'Partner EOI (State Master)';
      case 'EOI_LOCAL_BDE':
        return 'Partner EOI (Territory Partner)';
      case 'INVESTOR':
        return 'Investor Pre-qualification';
      default:
        return type.replace(/_/g, ' ');
    }
  }

  private welcomeCopy(type: LeadEmailKind): {
    headline: string;
    intro: string;
    nextStep: string;
  } {
    switch (type) {
      case 'REGISTRY_SENDER':
        return {
          headline: 'Welcome to the CLOX pre-launch community',
          intro:
            'Thank you for registering as a corporate sender. You’re on the early-access list for Australia’s digital full-load freight marketplace.',
          nextStep:
            'Our team will review your details. When live bidding opens, early registrants are prioritised for onboarding.',
        };
      case 'REGISTRY_CARRIER':
        return {
          headline: 'Welcome to the CLOX pre-launch community',
          intro:
            'Thank you for registering as a carrier / transport operator. You’re on the early-access list for vetted fleet partners on CLOX.',
          nextStep:
            'Our team will review your details. Have your ABN, Public Liability evidence, and vehicle compliance ready for when onboarding begins.',
        };
      case 'EOI_STATE_MASTER':
      case 'EOI_LOCAL_BDE':
        return {
          headline: 'Welcome — we received your Partner EOI',
          intro:
            'Thank you for your interest in becoming a CLOX Territory / Independent Territory Partner. Your expression of interest is now with our team.',
          nextStep:
            'Selection involves KYB and executive review. Commercial terms are discussed under NDA after application — submitting an EOI is not admission.',
        };
      case 'INVESTOR':
        return {
          headline: 'Welcome — investor enquiry received',
          intro:
            'Thank you for your interest in the CLOX early-access equity round. Your pre-qualification details have been received securely.',
          nextStep:
            'Our team will review your accreditation information and follow up if needed.',
        };
      default:
        return {
          headline: 'Welcome — we received your CLOX submission',
          intro:
            'Thank you for your interest in CLOX. Your pre-launch submission has been received.',
          nextStep: 'Our team will review your details and follow up if needed.',
        };
    }
  }

  private buildLeadEmail(params: {
    type: LeadEmailKind;
    leadId: string;
    email: string;
    companyName?: string | null;
    includeLogo: boolean;
  }) {
    const label = this.leadLabel(params.type);
    const welcome = this.welcomeCopy(params.type);
    const company = params.companyName?.trim() || '—';
    const logoHtml = params.includeLogo
      ? `<img src="cid:clox-logo" width="160" height="45" alt="CLOX" style="display:block;border:0;outline:none;height:auto;max-width:160px;" />`
      : `<div style="font-size:28px;font-weight:800;letter-spacing:0.04em;color:#ffffff;">CLOX</div>`;

    const subject = `Welcome to CLOX — ${label} received`;

    const text = [
      welcome.headline,
      '',
      welcome.intro,
      '',
      `Submission type: ${label}`,
      `Reference: ${params.leadId}`,
      `Email: ${params.email}`,
      `Company / name: ${company}`,
      '',
      welcome.nextStep,
      '',
      `Questions? Contact us at ${SUPPORT_EMAIL}`,
      '',
      '—',
      'CLOX Freight Forwarding',
      COMPANY_LINE,
      ABN_LINE,
      SUPPORT_EMAIL,
      'www.clox.com.au',
    ].join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:#0a1f3c;padding:28px 32px;">
              ${logoHtml}
              <p style="margin:14px 0 0;font-size:13px;color:#94a3b8;letter-spacing:0.04em;text-transform:uppercase;">
                Australia’s digital full-load freight marketplace
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#f97316;text-transform:uppercase;letter-spacing:0.06em;">
                Pre-launch confirmation
              </p>
              <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#0a1f3c;">
                ${welcome.headline}
              </h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#334155;">
                ${welcome.intro}
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 22px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Submission summary</p>
                    <p style="margin:0 0 8px;font-size:14px;color:#0f172a;"><strong>Type:</strong> ${label}</p>
                    <p style="margin:0 0 8px;font-size:14px;color:#0f172a;"><strong>Reference:</strong> ${params.leadId}</p>
                    <p style="margin:0 0 8px;font-size:14px;color:#0f172a;"><strong>Email:</strong> ${params.email}</p>
                    <p style="margin:0;font-size:14px;color:#0f172a;"><strong>Company / name:</strong> ${company}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#334155;">
                ${welcome.nextStep}
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
                <tr>
                  <td style="background:#f97316;border-radius:999px;">
                    <a href="mailto:${SUPPORT_EMAIL}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">
                      Contact ${SUPPORT_EMAIL}
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#64748b;">
                For any questions about your submission, email
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#0a1f3c;font-weight:700;">${SUPPORT_EMAIL}</a>
                and include your reference number.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#0a1f3c;padding:24px 32px;border-top:4px solid #f97316;">
              <p style="margin:0 0 6px;font-size:16px;font-weight:800;color:#ffffff;">CLOX</p>
              <p style="margin:0 0 10px;font-size:12px;line-height:1.55;color:#cbd5e1;">
                ${COMPANY_LINE}<br/>
                ${ABN_LINE}
              </p>
              <p style="margin:0 0 10px;font-size:12px;line-height:1.55;color:#94a3b8;">
                Enquiries:
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#fdba74;text-decoration:none;">${SUPPORT_EMAIL}</a>
                &nbsp;·&nbsp;
                <a href="https://www.clox.com.au" style="color:#fdba74;text-decoration:none;">www.clox.com.au</a>
              </p>
              <p style="margin:0;font-size:11px;line-height:1.5;color:#64748b;">
                This email confirms a pre-launch expression of interest only. It is not a binding service contract and does not grant live marketplace access.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    return { subject, text, html };
  }

  async sendMail(params: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    cc?: string;
    attachments?: {
      filename: string;
      path: string;
      cid: string;
    }[];
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
      attachments: params.attachments,
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

    const logo = this.logoPath();
    const content = this.buildLeadEmail({
      type: params.type,
      leadId: params.leadId,
      email: params.email,
      companyName: params.companyName,
      includeLogo: Boolean(logo),
    });

    return this.sendMail({
      to: params.email,
      cc,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments: logo
        ? [
            {
              filename: 'logo-clox.png',
              path: logo,
              cid: 'clox-logo',
            },
          ]
        : undefined,
    });
  }
}

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

  /**
   * Gmail web (and many mobile clients) do not render cid: embeds — they show
   * as downloadable attachments with broken &lt;img&gt; placeholders.
   * Images must be absolute HTTPS URLs on a public host.
   */
  private emailAssetBaseUrl(): string {
    return this.config
      .get('EMAIL_ASSET_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  private assetUrl(...parts: string[]): string {
    const path = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).join('/');
    return `${this.emailAssetBaseUrl()}/${path}`;
  }

  /** White/light logo for dark Halloween hero (transparent PNG). */
  private logoUrl(): string {
    return this.assetUrl('logo-clox-halloween.png');
  }

  private halloweenBgUrl(): string {
    return this.assetUrl('halloween.png');
  }

  private stepCircleUrl(name: 'document' | 'shield' | 'bell'): string {
    return this.assetUrl('icons', `icon-${name}-circle.png`);
  }

  private stepCircleImg(name: 'document' | 'shield' | 'bell'): string {
    return `<img src="${this.stepCircleUrl(name)}" width="40" height="40" alt="" style="display:block;border:0;outline:none;width:40px;height:40px;" />`;
  }

  private leadLabel(type: LeadEmailKind): string {
    switch (type) {
      case 'REGISTRY_SENDER':
        return 'Sender / Shipper';
      case 'REGISTRY_CARRIER':
        return 'Carrier / Transport Operator';
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
    nextSteps: { title: string; body: string }[];
  } {
    switch (type) {
      case 'REGISTRY_SENDER':
        return {
          headline: 'Welcome to CLOX!',
          intro:
            'Thank you for registering as a corporate sender. Your details have been received and our team will review them.',
          nextSteps: [
            {
              title: 'Team Review',
              body: 'Our team will review your details and get back to you with the sign up link soon.',
            },
            {
              title: 'Be Ready',
              body: 'Keep your company details, shipping volume, and preferred corridors ready for onboarding.',
            },
            {
              title: 'Stay Updated',
              body: "We'll keep you informed about important updates and the upcoming launch.",
            },
          ],
        };
      case 'REGISTRY_CARRIER':
        return {
          headline: 'Welcome to CLOX!',
          intro:
            'Thank you for registering as a carrier / transport operator. Your details have been received and our team will review them.',
          nextSteps: [
            {
              title: 'Team Review',
              body: 'Our team will review your details and get back to you with the sign up link soon.',
            },
            {
              title: 'Be Ready',
              body: 'Keep your ABN, Public Liability insurance evidence, and vehicle compliance documents ready for onboarding.',
            },
            {
              title: 'Stay Updated',
              body: "We'll keep you informed about important updates and the upcoming launch.",
            },
          ],
        };
      case 'EOI_STATE_MASTER':
      case 'EOI_LOCAL_BDE':
        return {
          headline: 'Welcome to CLOX!',
          intro:
            'Thank you for your interest in becoming a CLOX Territory / Independent Territory Partner. Your expression of interest has been received and our team will review it.',
          nextSteps: [
            {
              title: 'Team Review',
              body: 'Selection involves KYB and executive review. Our team will follow up with next steps.',
            },
            {
              title: 'Be Ready',
              body: 'Commercial terms are discussed under NDA after application — submitting an EOI is not admission.',
            },
            {
              title: 'Stay Updated',
              body: "We'll keep you informed about important updates and the upcoming launch.",
            },
          ],
        };
      case 'INVESTOR':
        return {
          headline: 'Welcome to CLOX!',
          intro:
            'Thank you for your interest in the CLOX early-access equity round. Your pre-qualification details have been received securely.',
          nextSteps: [
            {
              title: 'Team Review',
              body: 'Our team will review your accreditation information and follow up if needed.',
            },
            {
              title: 'Be Ready',
              body: 'Have your investor classification and capital allocation details ready for any follow-up discussion.',
            },
            {
              title: 'Stay Updated',
              body: "We'll keep you informed about important updates and the upcoming launch.",
            },
          ],
        };
      default:
        return {
          headline: 'Welcome to CLOX!',
          intro:
            'Thank you for your interest in CLOX. Your pre-launch submission has been received and our team will review it.',
          nextSteps: [
            {
              title: 'Team Review',
              body: 'Our team will review your details and follow up if needed.',
            },
            {
              title: 'Be Ready',
              body: 'Keep your supporting documents ready for onboarding.',
            },
            {
              title: 'Stay Updated',
              body: "We'll keep you informed about important updates and the upcoming launch.",
            },
          ],
        };
    }
  }

  /** Friendly ABN: 11 digits → "XX XXX XXX XXX" */
  private formatAbn(abn?: string | null): string | null {
    if (!abn) return null;
    const digits = abn.replace(/\s+/g, '');
    if (!/^\d{11}$/.test(digits)) return abn.trim() || null;
    return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }

  private locationLabel(type: LeadEmailKind): string {
    switch (type) {
      case 'REGISTRY_SENDER':
        return 'Shipping origin';
      case 'REGISTRY_CARRIER':
        return 'Depot state';
      case 'EOI_STATE_MASTER':
      case 'EOI_LOCAL_BDE':
        return 'Target state / region';
      case 'INVESTOR':
        return 'Country / residence';
      default:
        return 'Location';
    }
  }

  private companyLabel(type: LeadEmailKind): string {
    switch (type) {
      case 'REGISTRY_CARRIER':
        return 'Fleet / company';
      case 'INVESTOR':
        return 'Name / entity';
      default:
        return 'Company';
    }
  }

  /**
   * Clean stacked label + value for non-tech readers.
   * Empty values are omitted so the box stays short.
   */
  private detailItem(label: string, value: string | null | undefined, isLast: boolean) {
    const trimmed = value?.trim();
    if (!trimmed) return '';
    return `
      <tr>
        <td style="padding:0 0 ${isLast ? '4px' : '14px'} 0;">
          <p style="margin:0 0 3px;font-size:12px;line-height:1.3;font-weight:600;color:#667085;letter-spacing:0.02em;font-family:Arial,Helvetica,sans-serif;">${label}</p>
          <p style="margin:0;font-size:15px;line-height:1.4;font-weight:600;color:#101828;font-family:Arial,Helvetica,sans-serif;">${trimmed}</p>
        </td>
      </tr>`;
  }

  private buildDetailRows(params: {
    type: LeadEmailKind;
    label: string;
    companyName?: string | null;
    email: string;
    phone?: string | null;
    abn?: string | null;
    state?: string | null;
    territory?: string | null;
  }): { html: string; textLines: string[] } {
    const location =
      [params.state?.trim(), params.territory?.trim()].filter(Boolean).join(' · ') ||
      null;

    const items: { label: string; value: string | null }[] = [
      { label: 'Application type', value: params.label },
      { label: this.companyLabel(params.type), value: params.companyName ?? null },
      { label: 'Email', value: params.email },
      { label: 'Phone', value: params.phone ?? null },
      { label: 'ABN', value: this.formatAbn(params.abn) },
      { label: this.locationLabel(params.type), value: location },
    ].filter((item) => Boolean(item.value?.trim()));

    const html = items
      .map((item, index) =>
        this.detailItem(item.label, item.value, index === items.length - 1),
      )
      .join('');

    const textLines = items.map((item) => `${item.label}: ${item.value}`);
    return { html, textLines };
  }

  private nextStepRow(
    icon: 'document' | 'shield' | 'bell',
    title: string,
    body: string,
    isLast: boolean,
  ) {
    // Circle art is pre-baked into the PNG (icon centered on peach). Do not
    // rely on email-client table/CSS centering — that is what left-shifted icons.
    return `
      <tr>
        <td style="padding:0 0 ${isLast ? '0' : '22px'} 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td width="56" valign="top" align="left" style="width:56px;padding:0 14px 0 0;vertical-align:top;">
                ${this.stepCircleImg(icon)}
              </td>
              <td valign="top" style="padding:0;vertical-align:top;">
                <p style="margin:0 0 4px;font-size:15px;line-height:20px;font-weight:700;color:#101828;font-family:Arial,Helvetica,sans-serif;">${title}</p>
                <p style="margin:0;font-size:14px;line-height:1.55;color:#475467;font-family:Arial,Helvetica,sans-serif;">${body}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  private buildLeadEmail(params: {
    type: LeadEmailKind;
    leadId: string;
    email: string;
    companyName?: string | null;
    phone?: string | null;
    abn?: string | null;
    state?: string | null;
    territory?: string | null;
  }) {
    const label = this.leadLabel(params.type);
    const welcome = this.welcomeCopy(params.type);
    const siteUrl = 'https://clox.com.au';
    const halloweenBg = this.halloweenBgUrl();
    const logoSrc = this.logoUrl();
    const details = this.buildDetailRows({
      type: params.type,
      label,
      companyName: params.companyName,
      email: params.email,
      phone: params.phone,
      abn: params.abn,
      state: params.state,
      territory: params.territory,
    });

    const nextStepIcons = ['document', 'shield', 'bell'] as const;
    const nextStepsHtml = welcome.nextSteps
      .map((step, index) =>
        this.nextStepRow(
          nextStepIcons[index] ?? 'document',
          step.title,
          step.body,
          index === welcome.nextSteps.length - 1,
        ),
      )
      .join('');

    const subject = `Happy Halloween from CLOX — ${label} received`;

    const text = [
      'Happy Halloween from CLOX!',
      '',
      welcome.intro,
      '',
      'This Halloween, the team at CLOX Freight Forwarding wishes you a fun and safe celebration — and no freight scares ahead.',
      '',
      'Your details',
      ...details.textLines,
      '',
      'What happens next?',
      ...welcome.nextSteps.map((step) => `${step.title}: ${step.body}`),
      '',
      `Explore CLOX: ${siteUrl}`,
      '',
      `If you have any questions, please email ${SUPPORT_EMAIL}.`,
      '',
      'Warm regards,',
      'CLOX Freight Forwarding Team',
      '',
      '—',
      'CLOX Freight Forwarding',
      COMPANY_LINE,
      ABN_LINE,
      `Enquiries: ${SUPPORT_EMAIL} | clox.com.au`,
    ].join('\n');

    const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>${subject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style type="text/css">
    :root { color-scheme: light only; supported-color-schemes: light; }
    html, body { margin: 0 !important; padding: 0 !important; background-color: #F3F4F6; }
    body, table, td, p, a { color-scheme: light only; }
    table, td { border-collapse: collapse !important; }
    img { border: 0; outline: none; text-decoration: none; display: block; max-width: 100%; }
    a { color: #FF4B0B; }
    @media screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
      .hero-bg { padding: 36px 15px 34px 15px !important; }
      .hero-logo { width: 175px !important; }
      .content-padding { padding: 32px 20px !important; }
      .footer-padding { padding: 28px 18px !important; }
      .mobile-heading { font-size: 22px !important; line-height: 28px !important; }
      .mobile-btn { display: block !important; width: 100% !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#F3F4F6;opacity:0;mso-hide:all;">
    Happy Halloween from CLOX — your ${label} submission is in. No freight scares ahead.
  </div>

  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#F3F4F6" style="background-color:#F3F4F6;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <!--[if (gte mso 9)|(IE)]>
        <table role="presentation" align="center" border="0" cellpadding="0" cellspacing="0" width="600"><tr><td>
        <![endif]-->
        <table role="presentation" class="email-container" width="600" border="0" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;border:1px solid #E4E7EC;border-radius:8px;overflow:hidden;margin:0 auto;">

          <tr>
            <td class="hero-bg" align="center" valign="middle" background="${halloweenBg}" bgcolor="#101828" style="background-image:url('${halloweenBg}');background-repeat:no-repeat;background-position:center top;background-size:cover;background-color:#101828;text-align:center;border-bottom:3px solid #FF4B0B;padding:46px 20px 44px 20px;">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:205px;">
                <v:fill type="frame" src="${halloweenBg}" color="#101828" />
                <v:textbox inset="0,40px,0,0">
              <![endif]-->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 auto;max-width:520px;">
                <tr>
                  <td align="center">
                    <a href="${siteUrl}" target="_blank" style="text-decoration:none;display:inline-block;">
                      <img src="${logoSrc}" alt="CLOX Freight Forwarding" width="220" class="hero-logo" style="width:220px;max-width:100%;height:auto;display:block;margin:0 auto;border:0;" />
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:14px;">
                    <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:800;color:#FFFFFF;letter-spacing:1.5px;text-transform:uppercase;line-height:16px;">
                      AUSTRALIA'S DIGITAL FULL-LOAD FREIGHT MARKETPLACE
                    </p>
                  </td>
                </tr>
              </table>
              <!--[if gte mso 9]>
                </v:textbox>
              </v:rect>
              <![endif]-->
            </td>
          </tr>

          <tr>
            <td class="content-padding" style="background-color:#FFFFFF;padding:44px 40px;text-align:left;">
              <p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;color:#FF4B0B;text-transform:uppercase;letter-spacing:0.08em;">
                Happy Halloween · Pre-launch confirmation
              </p>
              <h1 class="mobile-heading" style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;line-height:1.3;color:#101828;letter-spacing:-0.3px;">
                ${welcome.headline}
              </h1>
              <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#475467;">
                ${welcome.intro}
              </p>
              <p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#475467;">
                This Halloween, the CLOX team wishes you a fun, safe celebration — and no freight scares ahead. Transparent bidding, vetted carriers, and planned Protected Upfront Payments are how we take the fright out of full-load freight.
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F8FAFC" style="background-color:#F8FAFC;border:1px solid #E4E7EC;border-radius:8px;margin:0 0 28px;">
                <tr>
                  <td bgcolor="#F8FAFC" style="background-color:#F8FAFC;padding:22px 22px 12px;">
                    <p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;color:#101828;text-transform:uppercase;letter-spacing:0.08em;">Your details</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${details.html}
                    </table>
                  </td>
                </tr>
              </table>

              <h2 style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:#101828;">What Happens Next?</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                ${nextStepsHtml}
              </table>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td align="center" bgcolor="#FF4B0B" style="border-radius:6px;background-color:#FF4B0B;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${siteUrl}" style="height:46px;v-text-anchor:middle;width:230px;" arcsize="13%" strokecolor="#FF4B0B" fillcolor="#FF4B0B">
                      <w:anchorlock/>
                      <center style="color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;">Explore CLOX</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <a href="${siteUrl}" class="mobile-btn" target="_blank" style="background-color:#FF4B0B;border:1px solid #FF4B0B;border-radius:6px;color:#FFFFFF;display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:46px;text-align:center;text-decoration:none;padding:0 28px;">Explore CLOX &rarr;</a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#667085;">
                Questions? Email
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#FF4B0B;font-weight:700;text-decoration:underline;">${SUPPORT_EMAIL}</a>.
              </p>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-top:1px solid #E4E7EC;width:100%;">
                <tr>
                  <td style="padding-top:20px;">
                    <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#475467;">
                      Warm regards,<br />
                      <strong style="color:#101828;">CLOX Freight Forwarding Team</strong><br />
                      <span style="font-size:13px;color:#667085;">Australia's Digital Full-Load Freight Marketplace</span>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td class="footer-padding" bgcolor="#F8FAFC" style="background-color:#F8FAFC;padding:32px 36px;text-align:center;border-top:1px solid #E4E7EC;">
              <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#101828;">
                CLOX Freight Forwarding
              </p>
              <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#667085;">
                ${COMPANY_LINE}<br />
                ${ABN_LINE}
              </p>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#667085;">
                Enquiries:
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#FF4B0B;text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a>
                &bull;
                <a href="${siteUrl}" target="_blank" style="color:#FF4B0B;text-decoration:none;">clox.com.au</a>
              </p>
            </td>
          </tr>

        </table>
        <!--[if (gte mso 9)|(IE)]>
        </td></tr></table>
        <![endif]-->
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
    bcc?: string;
    attachments?: {
      filename: string;
      path: string;
      cid: string;
      contentType?: string;
      contentDisposition?: 'inline' | 'attachment';
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
      bcc: params.bcc,
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
    phone?: string | null;
    abn?: string | null;
    state?: string | null;
    territory?: string | null;
  }) {
    const investNotify = this.config.get('INVEST_NOTIFY_EMAIL', { infer: true });
    const submitter = params.email.trim().toLowerCase();
    const support = SUPPORT_EMAIL.toLowerCase();
    const cc =
      params.type === 'INVESTOR' &&
      investNotify &&
      investNotify.toLowerCase() !== submitter
        ? investNotify
        : undefined;
    const bcc = submitter !== support ? SUPPORT_EMAIL : undefined;

    const content = this.buildLeadEmail({
      type: params.type,
      leadId: params.leadId,
      email: params.email,
      companyName: params.companyName,
      phone: params.phone,
      abn: params.abn,
      state: params.state,
      territory: params.territory,
    });

    this.logger.log(
      `Lead email image base: ${this.emailAssetBaseUrl()}`,
    );

    // No image attachments — Gmail treats cid: parts as downloadable files
    // and does not render them in the HTML body.
    return this.sendMail({
      to: params.email,
      cc,
      bcc,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppEnv } from '../../config/env.validation';
import {
  accountTypeLabel,
  EMAIL_BRAND,
  renderBrandedEmailHtml,
  type EmailDetailRow,
  type EmailNextStep,
} from './email-layout';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private getTransporter(): Transporter | null {
    if (this.transporter) {
      return this.transporter;
    }
    const user = this.config.get('SMTP_USER', { infer: true });
    const pass = this.config.get('SMTP_PASS', { infer: true });

    if (!user || !pass) {
      return null;
    }

    this.transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: this.config.get('SMTP_SECURE', { infer: true }),
      auth: { user, pass },
    });

    return this.transporter;
  }

  private fromAddress(): string {
    return (
      this.config.get('MAIL_FROM', { infer: true }) ||
      this.config.get('SMTP_USER', { infer: true }) ||
      'CLOX <noreply@clox.com.au>'
    );
  }

  /** App UI base (login, invites, onboarding). Trailing slash stripped. */
  private adminAppUrl(): string {
    const raw = this.config.get('ADMIN_APP_URL', { infer: true });
    return String(raw ?? 'http://localhost:5174').replace(/\/$/, '');
  }

  /** Marketing / public site — optional; never hardcode production hosts in templates. */
  private publicSiteUrl(): string | null {
    const raw = this.config.get('PUBLIC_SITE_URL', { infer: true });
    if (!raw?.trim()) return null;
    return raw.replace(/\/$/, '');
  }

  private exploreCta(): { label: string; href: string } {
    const publicUrl = this.publicSiteUrl();
    if (publicUrl) {
      return { label: 'Explore CLOX →', href: publicUrl };
    }
    return { label: 'Open CLOX →', href: `${this.adminAppUrl()}/login` };
  }

  private loginCta(): { label: string; href: string } {
    return { label: 'Sign in to CLOX →', href: `${this.adminAppUrl()}/login` };
  }

  /**
   * Deep-link via login with intended mailbox + return path.
   * `switch=1` clears a wrong-role browser session (e.g. Super Admin testing).
   */
  private signInContinueUrl(email: string, nextPath: string): string {
    const params = new URLSearchParams({
      email: email.trim().toLowerCase(),
      next: nextPath.startsWith('/') ? nextPath : `/${nextPath}`,
      switch: '1',
    });
    return `${this.adminAppUrl()}/login?${params.toString()}`;
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
      // Prevent clients treating inline parts oddly; we never attach images.
      attachments: [],
    });

    this.logger.log(
      `Email sent to ${params.to}: ${params.subject} (${info.response ?? 'ok'})`,
    );

    return { skipped: false as const };
  }

  private sendBranded(params: {
    to: string;
    subject: string;
    text: string;
    eyebrow: string;
    title: string;
    intro: string;
    details?: EmailDetailRow[];
    nextSteps?: EmailNextStep[];
    cta?: { label: string; href: string };
    cc?: string;
  }) {
    const html = renderBrandedEmailHtml({
      eyebrow: params.eyebrow,
      title: params.title,
      intro: params.intro,
      details: params.details,
      nextSteps: params.nextSteps,
      cta: params.cta,
      publicSiteUrl: this.publicSiteUrl(),
      supportEmail: EMAIL_BRAND.supportEmail,
    });
    return this.sendMail({
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      text: params.text,
      html,
    });
  }

  async sendOtpEmail(params: {
    to: string;
    code: string;
    ttlMinutes: number;
    /** Platform or admin role for account-type line. */
    accountType?: string;
  }) {
    const typeLabel = params.accountType
      ? accountTypeLabel(params.accountType)
      : undefined;
    const subject = 'CLOX sign-in code';
    const text = [
      'Your CLOX sign-in code',
      '',
      `Code: ${params.code}`,
      `Expires in ${params.ttlMinutes} minutes.`,
      typeLabel ? `Account type: ${typeLabel}` : undefined,
      `Email: ${params.to}`,
      '',
      `Sign in: ${this.loginCta().href}`,
      '',
      'If you did not request this code, you can ignore this email.',
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Sign-in code',
      title: 'Your CLOX login code',
      intro: `Use this one-time code to sign in. It expires in ${params.ttlMinutes} minutes.`,
      details: [
        { label: 'Code', value: params.code },
        ...(typeLabel ? [{ label: 'Account type', value: typeLabel }] : []),
        { label: 'Email', value: params.to },
        { label: 'Expires', value: `${params.ttlMinutes} minutes` },
      ],
      cta: this.loginCta(),
    });
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

    const typeLabel = accountTypeLabel(params.type);
    const subject = `CLOX — we received your ${typeLabel} submission`;
    const text = [
      'Thanks — we received your CLOX submission.',
      `Account type: ${typeLabel}`,
      `Reference: ${params.leadId}`,
      `Email: ${params.email}`,
      params.companyName ? `Company / Name: ${params.companyName}` : undefined,
      '',
      'Our team will review your details and follow up if needed.',
      this.publicSiteUrl() ? `Explore CLOX: ${this.publicSiteUrl()}` : undefined,
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.email,
      cc,
      subject,
      text,
      eyebrow: 'Submission received',
      title: 'Welcome to CLOX!',
      intro:
        'Thank you for getting in touch. Your details have been received and our team will review them.',
      details: [
        { label: 'Account type', value: typeLabel },
        { label: 'Reference', value: params.leadId },
        ...(params.companyName
          ? [{ label: 'Company / Name', value: params.companyName }]
          : []),
        { label: 'Email', value: params.email },
      ],
      nextSteps: [
        {
          title: 'Team review',
          body: 'Our team will review your details and get back to you shortly.',
        },
        {
          title: 'Be ready',
          body: 'Have your ABN and any relevant compliance documents ready when onboarding begins.',
        },
        {
          title: 'Stay updated',
          body: 'We will email you about important updates and next steps.',
        },
      ],
      cta: this.exploreCta(),
    });
  }

  async sendRegistrationConfirmation(params: {
    to: string;
    name: string;
    accountType: 'SENDER' | 'TRANSPORT_COMPANY';
  }) {
    const typeLabel = accountTypeLabel(params.accountType);
    const subject = `Welcome to CLOX — ${typeLabel}`;
    const login = this.loginCta();
    const text = [
      'Welcome to CLOX!',
      '',
      `Thank you for registering as a ${typeLabel}. Your details have been received.`,
      `Account type: ${typeLabel}`,
      `Company / Name: ${params.name}`,
      `Email: ${params.to}`,
      '',
      'Sign in with a one-time code (OTP) to continue onboarding:',
      login.href,
      '',
      `Questions: ${EMAIL_BRAND.supportEmail}`,
    ].join('\n');

    const nextSteps: EmailNextStep[] =
      params.accountType === 'TRANSPORT_COMPANY'
        ? [
            {
              title: 'Sign in',
              body: 'Request a one-time code with this email and continue carrier onboarding.',
            },
            {
              title: 'Be ready',
              body: 'Keep your ABN, Public Liability insurance evidence, and vehicle compliance documents ready.',
            },
            {
              title: 'Ops review',
              body: 'After you submit for review, our team verifies documents before you can bid.',
            },
          ]
        : [
            {
              title: 'Sign in',
              body: 'Request a one-time code with this email and continue sender onboarding.',
            },
            {
              title: 'Complete profile',
              body: 'Choose account type, invoice details, and upload verification documents.',
            },
            {
              title: 'Ops review',
              body: 'Our team reviews your case before payment and booking access.',
            },
          ];

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Registration confirmation',
      title: 'Welcome to CLOX!',
      intro: `Thank you for registering as a ${typeLabel}. Your details have been received — sign in to continue onboarding.`,
      details: [
        { label: 'Account type', value: typeLabel },
        { label: 'Company / Name', value: params.name },
        { label: 'Email', value: params.to },
      ],
      nextSteps,
      cta: login,
    });
  }

  async sendDriverInviteEmail(params: {
    to: string;
    driverName: string;
    companyName: string;
    inviteUrl: string;
    expiresHours: number;
  }) {
    const subject = `CLOX driver invite — ${params.companyName}`;
    const text = [
      `Hi ${params.driverName},`,
      '',
      `${params.companyName} invited you to join CLOX as a Driver.`,
      `Account type: Driver`,
      `Accept invite: ${params.inviteUrl}`,
      `This link expires in ${params.expiresHours} hours.`,
      '',
      'After accepting, sign in with a one-time code (OTP) emailed to you.',
    ].join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Driver invite',
      title: 'You are invited to CLOX',
      intro: `${params.companyName} invited you to join CLOX as a driver. Accept the invite to create your account.`,
      details: [
        { label: 'Account type', value: accountTypeLabel('DRIVER') },
        { label: 'Carrier', value: params.companyName },
        { label: 'Driver name', value: params.driverName },
        { label: 'Email', value: params.to },
        { label: 'Link expires', value: `${params.expiresHours} hours` },
      ],
      nextSteps: [
        {
          title: 'Accept invite',
          body: 'Open the secure link below to accept (single-use).',
        },
        {
          title: 'Sign in with OTP',
          body: 'After accepting, request a one-time code sent to this email.',
        },
        {
          title: 'Complete documents',
          body: 'Upload licence / ID documents so your carrier can activate you for trips.',
        },
      ],
      cta: { label: 'Accept invite →', href: params.inviteUrl },
    });
  }

  /**
   * Ops approved KYB/KYC — notify company contact(s).
   * Carrier → bid-eligible; Sender → pending payment setup.
   */
  async sendComplianceApprovedEmail(params: {
    to: string;
    companyName: string;
    companyType: 'CARRIER' | 'SENDER';
    companyStatus: string;
    caseType: string;
    decisionNote?: string | null;
  }) {
    const accountType =
      params.companyType === 'CARRIER'
        ? accountTypeLabel('TRANSPORT_COMPANY')
        : accountTypeLabel('SENDER');
    const isCarrier = params.companyType === 'CARRIER';
    const continueHref = this.signInContinueUrl(
      params.to,
      isCarrier ? '/market' : '/sender/onboarding',
    );
    const cta = {
      label: isCarrier ? 'Open job board →' : 'Continue onboarding →',
      href: continueHref,
    };
    const subject = isCarrier
      ? 'CLOX — your carrier account is approved'
      : 'CLOX — your sender account is approved';
    const intro = isCarrier
      ? 'Good news — our team has approved your compliance documents. Your carrier company is now bid-eligible on CLOX.'
      : 'Good news — our team has approved your compliance documents. Complete payment setup to unlock booking.';

    const details: EmailDetailRow[] = [
      { label: 'Account type', value: accountType },
      { label: 'Company / Name', value: params.companyName },
      { label: 'Email', value: params.to },
      { label: 'Case type', value: params.caseType },
      { label: 'Company status', value: params.companyStatus },
    ];
    if (params.decisionNote?.trim()) {
      details.push({ label: 'Ops note', value: params.decisionNote.trim() });
    }

    const nextSteps: EmailNextStep[] = isCarrier
      ? [
          {
            title: 'Sign in',
            body: 'Sign in with a one-time code using this email.',
          },
          {
            title: 'Browse jobs',
            body: 'You can now view the market board and submit bids on open loads.',
          },
          {
            title: 'Keep docs current',
            body: 'Maintain insurance and RWC validity — expired documents can suspend bidding.',
          },
        ]
      : [
          {
            title: 'Sign in',
            body: 'Sign in with a one-time code using this email.',
          },
          {
            title: 'Payment setup',
            body: 'Finish Stripe payment setup in sender onboarding to become booking-ready.',
          },
          {
            title: 'Create jobs',
            body: 'Once active, you can create and publish loads on the marketplace.',
          },
        ];

    const text = [
      subject,
      '',
      intro,
      `Account type: ${accountType}`,
      `Company / Name: ${params.companyName}`,
      `Email: ${params.to}`,
      `Case type: ${params.caseType}`,
      `Company status: ${params.companyStatus}`,
      params.decisionNote?.trim() ? `Ops note: ${params.decisionNote.trim()}` : undefined,
      '',
      `${cta.label.replace(/→/g, '').trim()}: ${cta.href}`,
      '',
      `Questions: ${EMAIL_BRAND.supportEmail}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Compliance approved',
      title: 'You are approved on CLOX',
      intro,
      details,
      nextSteps,
      cta,
    });
  }

  /** Ops requested more documents / clarification (INFO_REQUESTED). */
  async sendComplianceInfoRequestedEmail(params: {
    to: string;
    companyName: string;
    companyType: 'CARRIER' | 'SENDER';
    caseType: string;
    decisionNote?: string | null;
  }) {
    const accountType =
      params.companyType === 'CARRIER'
        ? accountTypeLabel('TRANSPORT_COMPANY')
        : accountTypeLabel('SENDER');
    const isCarrier = params.companyType === 'CARRIER';
    const continueHref = this.signInContinueUrl(
      params.to,
      isCarrier ? '/carrier/onboarding' : '/sender/onboarding',
    );
    const docsHref = this.signInContinueUrl(params.to, '/documents/upload');
    const note = params.decisionNote?.trim();
    const subject = 'CLOX — more information needed for your compliance review';
    const intro = note
      ? 'Our compliance team reviewed your submission and needs additional information before we can approve your account. Please see the Ops note below and upload the requested documents.'
      : 'Our compliance team reviewed your submission and needs additional information before we can approve your account. Please sign in, upload the requested documents, and re-submit for review.';

    const details: EmailDetailRow[] = [
      { label: 'Account type', value: accountType },
      { label: 'Company / Name', value: params.companyName },
      { label: 'Email', value: params.to },
      { label: 'Case type', value: params.caseType },
      { label: 'Company status', value: 'INFO_REQUESTED' },
    ];
    if (note) {
      details.push({ label: 'What Ops needs', value: note });
    }

    const text = [
      subject,
      '',
      intro,
      `Account type: ${accountType}`,
      `Company / Name: ${params.companyName}`,
      `Email: ${params.to}`,
      `Case type: ${params.caseType}`,
      'Company status: INFO_REQUESTED',
      note ? `What Ops needs: ${note}` : undefined,
      '',
      `Upload documents: ${docsHref}`,
      `Continue onboarding: ${continueHref}`,
      '',
      `Questions: ${EMAIL_BRAND.supportEmail}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Action required',
      title: 'More information needed',
      intro,
      details,
      nextSteps: [
        {
          title: 'Read the Ops note',
          body: note
            ? 'Follow the request in “What Ops needs” carefully — incomplete replies delay approval.'
            : 'Sign in to see any notes on your compliance case, then prepare the missing documents.',
        },
        {
          title: 'Upload documents',
          body: 'Use Upload & submit to add the requested files (PDF or images).',
        },
        {
          title: 'Re-submit for review',
          body: isCarrier
            ? 'Return to carrier onboarding and submit your compliance case again when ready.'
            : 'Return to sender onboarding and submit your compliance case again when ready.',
        },
      ],
      cta: { label: 'Upload documents →', href: docsHref },
    });
  }

  async sendAccountSuspendedEmail(params: {
    to: string;
    companyName: string;
    companyType: 'CARRIER' | 'SENDER';
    reason: string;
    note?: string | null;
  }) {
    const accountType =
      params.companyType === 'CARRIER'
        ? accountTypeLabel('TRANSPORT_COMPANY')
        : accountTypeLabel('SENDER');
    const subject = 'CLOX — your account has been suspended';
    const intro =
      'Your CLOX company account has been suspended by an administrator. You cannot sign in or use marketplace features until the account is reactivated.';
    const details: EmailDetailRow[] = [
      { label: 'Account type', value: accountType },
      { label: 'Company / Name', value: params.companyName },
      { label: 'Email', value: params.to },
      { label: 'Reason', value: params.reason },
    ];
    if (params.note?.trim()) {
      details.push({ label: 'Additional note', value: params.note.trim() });
    }

    const text = [
      subject,
      '',
      intro,
      `Account type: ${accountType}`,
      `Company / Name: ${params.companyName}`,
      `Email: ${params.to}`,
      `Reason: ${params.reason}`,
      params.note?.trim() ? `Additional note: ${params.note.trim()}` : undefined,
      '',
      `If you believe this is a mistake, contact ${EMAIL_BRAND.supportEmail}.`,
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Account suspended',
      title: 'Your CLOX account is suspended',
      intro,
      details,
      nextSteps: [
        {
          title: 'Access paused',
          body: 'Sign-in and marketplace actions are blocked while suspended.',
        },
        {
          title: 'Need help?',
          body: `Contact support at ${EMAIL_BRAND.supportEmail} and reference the reason above.`,
        },
      ],
    });
  }

  async sendAdminProvisionedEmail(params: {
    to: string;
    role: string;
    name?: string | null;
  }) {
    const typeLabel = accountTypeLabel(params.role);
    const login = this.loginCta();
    const subject = 'CLOX admin access provisioned';
    const text = [
      `You have been provisioned as ${typeLabel} on CLOX.`,
      params.name ? `Name: ${params.name}` : undefined,
      `Email: ${params.to}`,
      `Account type: ${typeLabel}`,
      '',
      `Sign in with OTP: ${login.href}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Admin access',
      title: 'Your CLOX admin account is ready',
      intro: `You have been provisioned as ${typeLabel}. Sign in with a one-time code using this email.`,
      details: [
        { label: 'Account type', value: typeLabel },
        ...(params.name ? [{ label: 'Name', value: params.name }] : []),
        { label: 'Email', value: params.to },
      ],
      nextSteps: [
        {
          title: 'Sign in',
          body: 'Open the app and request a one-time code for this email.',
        },
        {
          title: 'Complete setup',
          body: 'Use your scoped access (state / territory) according to your role.',
        },
      ],
      cta: login,
    });
  }
}

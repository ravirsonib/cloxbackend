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
      // Bound hangs so trip location / POD flows are not blocked for minutes.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
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
    attachments?: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
    }>;
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
      attachments: (params.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType ?? 'application/pdf',
      })),
    });

    this.logger.log(
      `Email sent to ${params.to}: ${params.subject} (${info.response ?? 'ok'})${
        params.attachments?.length
          ? ` · ${params.attachments.length} attachment(s)`
          : ''
      }`,
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
    attachments?: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
    }>;
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
      attachments: params.attachments,
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
    companyType: 'CARRIER' | 'SENDER' | 'ADMIN_PARTNER';
    reason: string;
    note?: string | null;
  }) {
    const accountType =
      params.companyType === 'CARRIER'
        ? accountTypeLabel('TRANSPORT_COMPANY')
        : params.companyType === 'ADMIN_PARTNER'
          ? 'Admin partner'
          : accountTypeLabel('SENDER');
    const subject = 'CLOX — your account has been suspended';
    const intro =
      params.companyType === 'ADMIN_PARTNER'
        ? 'Your CLOX admin partner account has been suspended by Super Admin. Ops access is disabled until the account is reactivated.'
        : 'Your CLOX company account has been suspended by an administrator. You cannot sign in or use marketplace features until the account is reactivated.';
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

  async sendAdminInviteEmail(params: {
    to: string;
    role: string;
    name?: string | null;
    regionCode?: string | null;
    territoryCode?: string | null;
    inviteUrl: string;
  }) {
    const typeLabel = accountTypeLabel(params.role);
    const subject = `CLOX admin partner invite — ${typeLabel}`;
    const text = [
      `You are invited to join CLOX as ${typeLabel}.`,
      params.name ? `Name: ${params.name}` : undefined,
      `Email: ${params.to}`,
      params.regionCode ? `Region: ${params.regionCode}` : undefined,
      params.territoryCode ? `Territory: ${params.territoryCode}` : undefined,
      '',
      `Accept invite: ${params.inviteUrl}`,
      'After accepting, sign in with OTP, upload KYB documents, and submit for Super Admin review.',
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Admin partner invite',
      title: 'You are invited to CLOX Ops',
      intro: `CLOX Super Admin invited you as ${typeLabel}. Accept the invite, complete KYB, then wait for Super approval before ops access is enabled.`,
      details: [
        { label: 'Account type', value: typeLabel },
        ...(params.name ? [{ label: 'Name', value: params.name }] : []),
        { label: 'Email', value: params.to },
        ...(params.regionCode ? [{ label: 'Region', value: params.regionCode }] : []),
        ...(params.territoryCode
          ? [{ label: 'Territory', value: params.territoryCode }]
          : []),
      ],
      nextSteps: [
        {
          title: 'Accept invite',
          body: 'Open the invite link to confirm your email.',
        },
        {
          title: 'Complete KYB',
          body: 'Upload ABN extract, government ID, and signed Master Administration Agreement, then submit for review.',
        },
      ],
      cta: { label: 'Accept invite →', href: params.inviteUrl },
    });
  }

  async sendCompanyInviteEmail(params: {
    to: string;
    companyType: string;
    legalNameHint?: string | null;
    territoryLabel?: string | null;
    inviteUrl: string;
  }) {
    const typeLabel = params.companyType === 'CARRIER' ? 'transport company' : 'sender';
    const subject = `CLOX invite — register as ${typeLabel}`;
    const text = [
      `You are invited to join CLOX as a ${typeLabel}.`,
      params.legalNameHint ? `Company: ${params.legalNameHint}` : undefined,
      `Email: ${params.to}`,
      params.territoryLabel ? `Territory: ${params.territoryLabel}` : undefined,
      '',
      `Register here: ${params.inviteUrl}`,
      'Use this link so your Local BDE partner can support your onboarding.',
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Marketplace invite',
      title: `Join CLOX as a ${typeLabel}`,
      intro: `A CLOX Local BDE invited you to register. Open the link to create your account and continue onboarding.`,
      details: [
        { label: 'Account type', value: typeLabel },
        ...(params.legalNameHint
          ? [{ label: 'Company', value: params.legalNameHint }]
          : []),
        { label: 'Email', value: params.to },
        ...(params.territoryLabel
          ? [{ label: 'Territory', value: params.territoryLabel }]
          : []),
      ],
      nextSteps: [
        {
          title: 'Register',
          body: 'Open the invite link and complete registration with this email.',
        },
        {
          title: 'Onboard',
          body: 'Finish verification so you can publish jobs or bid on loads.',
        },
      ],
      cta: { label: 'Register →', href: params.inviteUrl },
    });
  }

  async sendAdminProvisionedEmail(params: {
    to: string;
    role: string;
    name?: string | null;
  }) {
    const typeLabel = accountTypeLabel(params.role);
    const login = this.loginCta();
    const subject = 'CLOX admin access approved';
    const text = [
      `Your ${typeLabel} account on CLOX has been approved.`,
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
      title: 'Your CLOX admin account is active',
      intro: `Super Admin approved your ${typeLabel} KYB. You now have scoped ops access.`,
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
          title: 'Use your scope',
          body: 'Access is limited to your assigned state / territory.',
        },
      ],
      cta: login,
    });
  }

  async sendAdminPartnerInfoRequestedEmail(params: {
    to: string;
    role: string;
    name?: string | null;
    companyName: string;
    decisionNote?: string | null;
  }) {
    const typeLabel = accountTypeLabel(params.role);
    const continueHref = this.signInContinueUrl(params.to, '/partner/onboarding');
    const note = params.decisionNote?.trim();
    const subject = 'CLOX — more information needed for your admin partner KYB';
    const text = [
      `Super Admin needs more information for your ${typeLabel} KYB.`,
      `Company: ${params.companyName}`,
      note ? `Ops note: ${note}` : undefined,
      '',
      `Continue onboarding: ${continueHref}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return this.sendBranded({
      to: params.to,
      subject,
      text,
      eyebrow: 'Admin partner KYB',
      title: 'Additional information required',
      intro: note
        ? 'Super Admin reviewed your partner KYB and needs additional information before approval. See the note below, update documents, and re-submit.'
        : 'Super Admin reviewed your partner KYB and needs additional information. Sign in, update your documents, and re-submit for review.',
      details: [
        { label: 'Account type', value: typeLabel },
        { label: 'Company', value: params.companyName },
        ...(params.name ? [{ label: 'Name', value: params.name }] : []),
        ...(note ? [{ label: 'Ops note', value: note }] : []),
      ],
      nextSteps: [
        {
          title: 'Sign in',
          body: 'Open partner onboarding with a one-time code for this email.',
        },
        {
          title: 'Update and re-submit',
          body: 'Upload any requested documents, then submit KYB again for Super review.',
        },
      ],
      cta: { label: 'Continue onboarding →', href: continueHref },
    });
  }

  /** Carrier submitted a bid — notify sender to review proposals on the job. */
  async notifyProposalSubmitted(params: {
    senderEmails: string[];
    jobId: string;
    jobTitle: string;
    amountIncGstCents: number;
    etaMinutes: number | null;
  }) {
    const amount = `$${(params.amountIncGstCents / 100).toFixed(2)}`;
    const jobLabel = params.jobTitle || params.jobId.slice(0, 8);
    const details: EmailDetailRow[] = [
      { label: 'Job', value: jobLabel },
      { label: 'Bid (inc GST)', value: amount },
      ...(params.etaMinutes != null
        ? [{ label: 'ETA', value: `${params.etaMinutes} minutes` }]
        : []),
      { label: 'Job ID', value: params.jobId },
    ];
    const nextPath = `/jobs/${params.jobId}`;
    const emails = [...new Set(params.senderEmails.map((e) => e.trim()).filter(Boolean))];
    const results = await Promise.all(
      emails.map((to) =>
        this.sendBranded({
          to,
          subject: `CLOX — new bid on ${jobLabel}`,
          text: [
            `A carrier submitted a bid on your job ${jobLabel}.`,
            `Amount (inc GST): ${amount}`,
            params.etaMinutes != null ? `ETA: ${params.etaMinutes} minutes` : undefined,
            '',
            `Review and accept: ${this.signInContinueUrl(to, nextPath)}`,
          ]
            .filter((line) => line !== undefined)
            .join('\n'),
          eyebrow: 'New bid',
          title: 'A carrier bid on your job',
          intro:
            'A transport company submitted a proposal. Open the job to compare bids and accept one to start payment.',
          details,
          nextSteps: [
            {
              title: 'Review proposals',
              body: 'Open the job detail page to see amount, ETA, and vehicle class for each bid.',
            },
            {
              title: 'Accept & pay',
              body: 'Accepting a bid starts payment. Once paid, the assignment locks for the carrier.',
            },
          ],
          cta: {
            label: 'Review bid →',
            href: this.signInContinueUrl(to, nextPath),
          },
        }),
      ),
    );
    return { results, notified: emails.length };
  }

  /**
   * Sender paid & assignment locked — notify carrier (action) + assigned driver (new trip).
   */
  async notifyAssignmentLocked(params: {
    carrierEmails: string[];
    driverEmail: string | null;
    jobId: string;
    jobTitle: string;
    amountIncGstCents: number;
    vehicleLabel: string;
    driverName: string;
  }) {
    const amount = `$${(params.amountIncGstCents / 100).toFixed(2)}`;
    const jobLabel = params.jobTitle || params.jobId.slice(0, 8);
    const details: EmailDetailRow[] = [
      { label: 'Job', value: jobLabel },
      { label: 'Paid (inc GST)', value: amount },
      { label: 'Vehicle', value: params.vehicleLabel },
      { label: 'Driver', value: params.driverName },
      { label: 'Job ID', value: params.jobId },
    ];

    const carrierEmails = [
      ...new Set(params.carrierEmails.map((e) => e.trim()).filter(Boolean)),
    ];
    const carrierResults = await Promise.all(
      carrierEmails.map((to) =>
        this.sendBranded({
          to,
          subject: `CLOX — bid accepted · ${jobLabel}`,
          text: [
            `Your bid was accepted and paid for job ${jobLabel}.`,
            `Amount (inc GST): ${amount}`,
            `Vehicle: ${params.vehicleLabel}`,
            `Driver: ${params.driverName}`,
            '',
            `Open assignments: ${this.signInContinueUrl(to, '/assignments')}`,
          ].join('\n'),
          eyebrow: 'Bid won',
          title: 'Your bid was accepted',
          intro:
            'The sender paid for this job. The assignment is locked. Confirm crew readiness and make sure the driver can start the trip.',
          details,
          nextSteps: [
            {
              title: 'Open assignments',
              body: 'Review the locked assignment and reassign vehicle/driver only if needed before the trip starts.',
            },
            {
              title: 'Driver trip',
              body: 'The assigned driver can open My trips to complete safety checks and start.',
            },
          ],
          cta: {
            label: 'Open assignments →',
            href: this.signInContinueUrl(to, '/assignments'),
          },
        }),
      ),
    );

    let driverResult: { skipped: boolean } | null = null;
    const driverTo = params.driverEmail?.trim();
    if (driverTo) {
      driverResult = await this.sendBranded({
        to: driverTo,
        subject: `CLOX — new trip · ${jobLabel}`,
        text: [
          `You have been assigned a new trip: ${jobLabel}.`,
          `Vehicle: ${params.vehicleLabel}`,
          '',
          `Open My trips: ${this.signInContinueUrl(driverTo, '/trips')}`,
        ].join('\n'),
        eyebrow: 'New trip',
        title: 'You have a new trip',
        intro:
          'Your carrier won this job and payment is confirmed. Open My trips to complete safety checks and start when ready.',
        details: details.filter((d) => d.label !== 'Paid (inc GST)'),
        nextSteps: [
          {
            title: 'Open My trips',
            body: 'Complete pre-trip safety and mass declarations before starting.',
          },
        ],
        cta: {
          label: 'Open My trips →',
          href: this.signInContinueUrl(driverTo, '/trips'),
        },
      });
    }

    return {
      carrier: carrierResults,
      driver: driverResult,
      notifiedCarrier: carrierEmails.length,
      notifiedDriver: Boolean(driverTo),
    };
  }

  /** Trip exception opened — notify carrier (action) + sender (delay) + driver confirm. */
  async notifyTripExceptionOpened(params: {
    driverEmail: string;
    carrierEmails: string[];
    senderEmail: string | null;
    opsEmail?: string | null;
    jobTitle: string;
    jobId: string;
    kind: string;
    phase: string;
    reasonCode?: string | null;
    note: string;
    exceptionId: string;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'Kind', value: params.kind },
      { label: 'Phase', value: params.phase },
      ...(params.reasonCode
        ? [{ label: 'Reason', value: params.reasonCode }]
        : []),
      { label: 'Note', value: params.note },
      { label: 'Exception ID', value: params.exceptionId },
    ];

    const driverResult = await this.sendBranded({
      to: params.driverEmail,
      subject: 'CLOX — issue report received',
      text: `We received your trip issue report (${params.kind}). Your carrier has been notified.`,
      eyebrow: 'Trip exception',
      title: 'Issue report received',
      intro:
        'Your report was logged. Your transport company has been notified and must act. You will get another message when a replacement is assigned or the issue is resolved.',
      details,
    });

    const carrierCta = {
      label: 'Open exceptions →',
      href: `${this.adminAppUrl()}/carrier/exceptions/${params.exceptionId}`,
    };
    const carrierResults = await Promise.all(
      [...new Set(params.carrierEmails.filter(Boolean))].map((to) =>
        this.sendBranded({
          to,
          subject: 'CLOX — action required: trip exception',
          text: `Action required: ${params.kind} on job ${params.jobTitle || params.jobId}. Open the exceptions inbox.`,
          eyebrow: 'Action required',
          title: 'Trip exception — act now',
          intro:
            'A driver reported an issue on an active assignment. Open the exceptions inbox to reassign, continue, or escalate. This is not a silent event.',
          details,
          nextSteps: [
            {
              title: 'Review the exception',
              body: 'Confirm GPS/note and whether this is pre-trip or mid-trip.',
            },
            {
              title: 'Reassign or continue',
              body: 'Use intra-fleet reassign when possible. Escalate explicitly if you cannot rescue.',
            },
          ],
          cta: carrierCta,
        }),
      ),
    );

    let senderResult: { skipped: boolean } | null = null;
    if (params.senderEmail) {
      senderResult = await this.sendBranded({
        to: params.senderEmail,
        subject: 'CLOX — update on your shipment',
        text: `There is an issue on job ${params.jobTitle || params.jobId} (${params.kind}). Your carrier is handling it.`,
        eyebrow: 'Shipment update',
        title: 'Issue on your shipment',
        intro:
          'The assigned driver reported an issue. Your carrier has been notified and is arranging a response. You will be updated when a replacement is confirmed or the plan changes.',
        details: details.filter((d) => d.label !== 'Exception ID'),
      });
    }

    let opsResult: { skipped: boolean } | null = null;
    const opsTo = params.opsEmail ?? this.config.get('NOTIFY_EMAIL', { infer: true });
    if (opsTo && !params.carrierEmails.includes(opsTo)) {
      opsResult = await this.sendBranded({
        to: opsTo,
        subject: `CLOX Ops — trip exception ${params.kind}`,
        text: `Trip exception ${params.exceptionId} opened (${params.phase}).`,
        eyebrow: 'Ops digest',
        title: 'Trip exception opened',
        intro: 'A trip exception was opened. Carrier action is required.',
        details,
      });
    }

    return {
      driver: driverResult,
      carrier: carrierResults,
      sender: senderResult,
      ops: opsResult,
    };
  }

  async notifyTripExceptionContinued(params: {
    driverEmail: string | null;
    carrierEmails: string[];
    senderEmail: string | null;
    jobTitle: string;
    jobId: string;
    note: string;
    etaNote: string | null;
    exceptionId: string;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'Note', value: params.note },
      ...(params.etaNote ? [{ label: 'ETA update', value: params.etaNote }] : []),
      { label: 'Exception ID', value: params.exceptionId },
    ];
    const targets = new Set(
      [params.driverEmail, ...params.carrierEmails, params.senderEmail].filter(
        (e): e is string => Boolean(e),
      ),
    );
    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — trip continuing after issue',
          text: `Job ${params.jobTitle || params.jobId} will continue. ${params.note}`,
          eyebrow: 'Trip update',
          title: 'Repair & continue',
          intro:
            'The carrier chose to continue this trip after the reported issue. Check the latest ETA and status in the app.',
          details,
        }),
      );
    }
    return results;
  }

  async notifyTripExceptionEscalated(params: {
    driverEmail: string | null;
    carrierEmails: string[];
    senderEmail: string | null;
    opsEmail?: string | null;
    jobTitle: string;
    jobId: string;
    kind: string;
    phase: string;
    note: string;
    automatic: boolean;
    exceptionId: string;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'Kind', value: params.kind },
      { label: 'Phase', value: params.phase },
      { label: 'Escalation', value: params.automatic ? 'Automatic (SLA)' : 'Carrier requested' },
      { label: 'Note', value: params.note },
      { label: 'Exception ID', value: params.exceptionId },
    ];

    const opsTo = params.opsEmail ?? this.config.get('NOTIFY_EMAIL', { infer: true });
    if (opsTo) {
      await this.sendBranded({
        to: opsTo,
        subject: 'CLOX Ops — trip exception escalated (action)',
        text: `Escalated exception ${params.exceptionId} on job ${params.jobTitle || params.jobId}.`,
        eyebrow: 'Ops action required',
        title: 'Exception escalated',
        intro: params.automatic
          ? 'A pre-trip exception was not handled within the SLA and was auto-escalated. Review the Ops exceptions queue.'
          : 'A carrier escalated a trip exception to Ops. Review the Ops exceptions queue.',
        details,
        cta: {
          label: 'Open Ops exceptions →',
          href: `${this.adminAppUrl()}/ops/exceptions`,
        },
      });
    }

    const others = new Set(
      [params.driverEmail, ...params.carrierEmails, params.senderEmail].filter(
        (e): e is string => Boolean(e) && e !== opsTo,
      ),
    );
    for (const to of others) {
      await this.sendBranded({
        to,
        subject: 'CLOX — trip exception escalated',
        text: `Exception on job ${params.jobTitle || params.jobId} was escalated to Ops.`,
        eyebrow: 'Shipment update',
        title: 'Exception escalated',
        intro:
          'This trip exception was escalated to CLOX Ops. You will receive another update when it is resolved.',
        details: details.filter((d) => d.label !== 'Exception ID'),
      });
    }
    return { opsNotified: Boolean(opsTo) };
  }

  async notifyTripExceptionReleased(params: {
    driverEmail: string | null;
    carrierEmails: string[];
    senderEmail: string | null;
    opsEmail?: string | null;
    jobTitle: string;
    jobId: string;
    note: string;
    exceptionId: string;
    phase: string;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'Phase', value: params.phase },
      { label: 'Note', value: params.note },
      { label: 'Exception ID', value: params.exceptionId },
    ];
    const opsTo = params.opsEmail ?? this.config.get('NOTIFY_EMAIL', { infer: true });
    const targets = new Set(
      [params.driverEmail, ...params.carrierEmails, params.senderEmail, opsTo].filter(
        (e): e is string => Boolean(e),
      ),
    );
    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — trip released / cancelled (explicit)',
          text: `Job ${params.jobTitle || params.jobId} was explicitly released from the exception path (not a silent marketplace swap).`,
          eyebrow: 'Explicit release',
          title: 'Trip released from exception',
          intro:
            'The carrier explicitly released this trip (cancel / marketplace path). This is never silent. Stripe/marketplace re-list hooks are queued for M10.',
          details,
        }),
      );
    }
    return results;
  }

  async notifyTripExceptionReplacementProposed(params: {
    carrierEmails: string[];
    senderEmail: string | null;
    jobTitle: string;
    jobId: string;
    vehicleLabel: string;
    driverName: string;
    exceptionId: string;
    note: string | null;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'Proposed vehicle', value: params.vehicleLabel },
      { label: 'Proposed driver', value: params.driverName },
      { label: 'Exception ID', value: params.exceptionId },
    ];
    if (params.note) details.push({ label: 'Note', value: params.note });
    const targets = new Set(
      [...params.carrierEmails, params.senderEmail].filter(
        (e): e is string => Boolean(e),
      ),
    );
    const results = [];
    for (const to of targets) {
      const isSender = to === params.senderEmail;
      results.push(
        await this.sendBranded({
          to,
          subject: isSender
            ? 'CLOX — approve replacement crew for your job'
            : 'CLOX — replacement proposed (awaiting sender)',
          text: `Job ${params.jobTitle || params.jobId}: proposed ${params.driverName} / ${params.vehicleLabel}. Sender must approve.`,
          eyebrow: 'Exception',
          title: isSender ? 'Approve replacement?' : 'Replacement proposed',
          intro: isSender
            ? 'Your carrier proposed a replacement vehicle/driver. Open CLOX to Approve (continue) or Reject (cancel + refund).'
            : 'Replacement crew proposed. Waiting for the sender to Approve or Reject.',
          details,
          cta: {
            label: 'Open CLOX →',
            href: this.adminAppUrl(),
          },
        }),
      );
    }
    return results;
  }

  async notifyTripExceptionReplacementRejected(params: {
    carrierEmails: string[];
    senderEmail: string | null;
    driverEmail: string | null;
    jobTitle: string;
    jobId: string;
    note: string;
    exceptionId: string;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'Reason', value: params.note },
      { label: 'Exception ID', value: params.exceptionId },
    ];
    const targets = new Set(
      [
        params.senderEmail,
        params.driverEmail,
        ...params.carrierEmails,
      ].filter((e): e is string => Boolean(e)),
    );
    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — replacement rejected · job cancelled',
          text: `Job ${params.jobTitle || params.jobId} cancelled: sender rejected the proposed replacement.`,
          eyebrow: 'Exception',
          title: 'Replacement rejected',
          intro:
            'The sender rejected the proposed replacement. The job has been cancelled and a refund will be processed per payment policy.',
          details,
          cta: {
            label: 'Open CLOX →',
            href: this.adminAppUrl(),
          },
        }),
      );
    }
    return results;
  }

  async notifyTripExceptionReassigned(params: {
    driverEmail: string | null;
    previousDriverEmail: string | null;
    carrierEmails: string[];
    senderEmail: string | null;
    jobTitle: string;
    jobId: string;
    vehicleLabel: string;
    driverName: string;
    exceptionId: string;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId.slice(0, 8) },
      { label: 'New vehicle', value: params.vehicleLabel },
      { label: 'New driver', value: params.driverName },
      { label: 'Exception ID', value: params.exceptionId },
    ];
    const targets = new Set(
      [
        params.driverEmail,
        params.previousDriverEmail,
        ...params.carrierEmails,
        params.senderEmail,
      ].filter((e): e is string => Boolean(e)),
    );
    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — crew reassigned for your job',
          text: `Job ${params.jobTitle || params.jobId} reassigned to ${params.driverName} / ${params.vehicleLabel}.`,
          eyebrow: 'Trip update',
          title: 'Crew reassigned',
          intro:
            'The carrier assigned a replacement vehicle/driver for this job. Check the app for the latest trip status and safety gates.',
          details,
          cta: {
            label: 'Open CLOX →',
            href: this.adminAppUrl(),
          },
        }),
      );
    }
    return results;
  }

  /** M10 — driver early notify / auto approaching */
  async notifyTripApproaching(params: {
    senderEmails: string[];
    receiverEmail: string | null;
    jobId: string;
    jobTitle: string | null;
    dropSuburb: string | null;
    dropAddress: string | null;
    etaLabel: string | null;
    source: 'DRIVER' | 'ETA_AUTO';
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId },
      { label: 'Drop suburb', value: params.dropSuburb || '—' },
      { label: 'Drop address', value: params.dropAddress || '—' },
    ];
    if (params.etaLabel) details.push({ label: 'ETA', value: params.etaLabel });
    details.push({
      label: 'Source',
      value: params.source === 'DRIVER' ? 'Driver notified early' : 'System ETA alert',
    });

    const targets = new Set<string>();
    for (const e of params.senderEmails) {
      if (e?.includes('@')) targets.add(e.trim().toLowerCase());
    }
    if (params.receiverEmail?.includes('@')) {
      targets.add(params.receiverEmail.trim().toLowerCase());
    }

    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — driver approaching delivery',
          text: `Driver is approaching for job ${params.jobTitle || params.jobId} (${params.dropSuburb || 'drop'}).`,
          eyebrow: 'Delivery update',
          title: 'Driver approaching',
          intro:
            'The driver is on the way to the delivery site. Please prepare to receive the load. No action is required in the app for receivers.',
          details,
        }),
      );
    }
    return { sentTo: [...targets], results };
  }

  /** M10 — first AT_DROPOFF (informational; no sign link) */
  async notifyTripAtDropoff(params: {
    senderEmails: string[];
    carrierEmails: string[];
    receiverEmail: string | null;
    jobId: string;
    jobTitle: string | null;
    dropSuburb: string | null;
    dropAddress: string | null;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId },
      { label: 'Drop suburb', value: params.dropSuburb || '—' },
      { label: 'Drop address', value: params.dropAddress || '—' },
    ];

    const targets = new Set<string>();
    for (const e of [...params.senderEmails, ...params.carrierEmails]) {
      if (e?.includes('@')) targets.add(e.trim().toLowerCase());
    }
    if (params.receiverEmail?.includes('@')) {
      targets.add(params.receiverEmail.trim().toLowerCase());
    }

    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — driver at delivery site',
          text: `Driver has arrived at the delivery site for job ${params.jobTitle || params.jobId}.`,
          eyebrow: 'Delivery update',
          title: 'Driver at delivery site',
          intro:
            'The driver has arrived at the drop-off location. The receiver will sign proof of delivery on the driver’s device (SOG).',
          details,
        }),
      );
    }
    return { sentTo: [...targets], results };
  }

  /** M10 — POD finalized; POD PDF attached for sender / receiver / carrier */
  async notifyPodFinalized(params: {
    senderEmails: string[];
    receiverEmail: string | null;
    carrierEmails?: string[];
    jobId: string;
    jobTitle: string | null;
    dropSuburb: string | null;
    signerName: string;
    attachments?: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
    }>;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId },
      { label: 'Drop suburb', value: params.dropSuburb || '—' },
      { label: 'Signed by', value: params.signerName },
      {
        label: 'Attachments',
        value: params.attachments?.length
          ? params.attachments.map((a) => a.filename).join(', ')
          : 'None',
      },
    ];
    const targets = new Set<string>();
    for (const e of [...params.senderEmails, ...(params.carrierEmails ?? [])]) {
      if (e?.includes('@')) targets.add(e.trim().toLowerCase());
    }
    if (params.receiverEmail?.includes('@')) {
      targets.add(params.receiverEmail.trim().toLowerCase());
    }
    if (targets.size === 0) {
      this.logger.warn(
        `POD finalized email skipped — no sender/carrier/receiver addresses for job ${params.jobId}`,
      );
      return { sentTo: [] as string[], results: [] as Array<{ skipped: boolean }> };
    }

    const results: Array<{ skipped: boolean; to: string; error?: string }> = [];
    for (const to of targets) {
      try {
        const result = await this.sendBranded({
          to,
          subject: 'CLOX — delivery completed (POD attached)',
          text: [
            `POD finalized for job ${params.jobTitle || params.jobId}, signed by ${params.signerName}.`,
            params.attachments?.length
              ? `Attached: ${params.attachments.map((a) => a.filename).join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          eyebrow: 'Proof of delivery',
          title: 'Delivery completed',
          intro:
            'Proof of delivery has been captured on the driver’s SOG (signature + photos). The POD PDF is attached to this email.',
          details,
          cta: this.loginCta(),
          attachments: params.attachments,
        });
        results.push({ ...result, to });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`POD finalized email failed for ${to}: ${message}`);
        results.push({ skipped: true, to, error: message });
      }
    }
    this.logger.log(
      `POD finalized emails: ${results.filter((r) => !r.skipped && !r.error).length}/${targets.size} delivered for job ${params.jobId}`,
    );
    return { sentTo: [...targets], results };
  }

  /**
   * M10 — after trip COMPLETED: tax invoice (+ run sheet) + POD PDFs attached
   * for sender, receiver, and carrier.
   */
  async notifyTripCompletionDocuments(params: {
    senderEmails: string[];
    carrierEmails: string[];
    receiverEmail?: string | null;
    jobId: string;
    jobTitle: string | null;
    hasRunSheet: boolean;
    totalIncGstCents: number;
    attachments?: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
    }>;
  }) {
    const docLabel = [
      'Tax invoice',
      params.hasRunSheet ? 'hourly run sheet' : null,
      params.attachments?.some((a) => /pod/i.test(a.filename))
        ? 'POD package'
        : null,
    ]
      .filter(Boolean)
      .join(' + ');
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId },
      {
        label: 'Total (inc GST)',
        value: `$${(params.totalIncGstCents / 100).toFixed(2)} AUD`,
      },
      { label: 'Documents', value: docLabel || 'Trip documents' },
      {
        label: 'Attachments',
        value: params.attachments?.length
          ? params.attachments.map((a) => a.filename).join(', ')
          : 'None',
      },
    ];
    const targets = new Set<string>();
    for (const e of [...params.senderEmails, ...params.carrierEmails]) {
      if (e?.includes('@')) targets.add(e.trim().toLowerCase());
    }
    if (params.receiverEmail?.includes('@')) {
      targets.add(params.receiverEmail.trim().toLowerCase());
    }
    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — trip complete · documents attached',
          text: [
            `Trip completed for job ${params.jobTitle || params.jobId}.`,
            `Documents attached: ${
              params.attachments?.map((a) => a.filename).join(', ') || 'none'
            }.`,
          ].join('\n'),
          eyebrow: 'Trip complete',
          title: 'Trip documents attached',
          intro:
            'The trip is complete. Your tax invoice' +
            (params.hasRunSheet ? ', hourly run sheet,' : '') +
            ' and proof of delivery (where available) are attached as PDF files.',
          details,
          cta: this.loginCta(),
          attachments: params.attachments,
        }),
      );
    }
    return { sentTo: [...targets], results };
  }

  /** M10 Phase D — breakdown / exception report PDF attached */
  async notifyBreakdownReport(params: {
    carrierEmails: string[];
    senderEmail: string | null;
    driverEmail: string | null;
    jobId: string;
    jobTitle: string | null;
    kind: string;
    exceptionId: string;
    attachments?: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
    }>;
  }) {
    const details: EmailDetailRow[] = [
      { label: 'Job', value: params.jobTitle || params.jobId },
      { label: 'Exception', value: params.kind },
      { label: 'Report id', value: params.exceptionId.slice(0, 8) },
    ];
    const targets = new Set<string>();
    for (const e of params.carrierEmails) {
      if (e?.includes('@')) targets.add(e.trim().toLowerCase());
    }
    if (params.senderEmail?.includes('@')) {
      targets.add(params.senderEmail.trim().toLowerCase());
    }
    if (params.driverEmail?.includes('@')) {
      targets.add(params.driverEmail.trim().toLowerCase());
    }
    const results = [];
    for (const to of targets) {
      results.push(
        await this.sendBranded({
          to,
          subject: 'CLOX — trip exception report (PDF attached)',
          text: `Exception report generated for job ${params.jobTitle || params.jobId} (${params.kind}). PDF attached.`,
          eyebrow: 'Exception report',
          title: 'Breakdown / exception report',
          intro:
            'A driver exception report PDF is attached. Review the report and take the next carrier action in CLOX.',
          details,
          cta: this.loginCta(),
          attachments: params.attachments,
        }),
      );
    }
    return { sentTo: [...targets], results };
  }
}

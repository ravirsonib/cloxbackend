/**
 * Cross-client email HTML (table layout, inline CSS).
 * Header logo is a hosted absolute URL only (no CID / base64 attachments).
 * When PUBLIC_SITE_URL is unset, the navy bar falls back to a text wordmark.
 * Icons in the body are CSS/text only (numbered circles, emoji-free labels).
 */

export const EMAIL_BRAND = {
  navy: '#0B2147',
  navySoft: '#14305f',
  orange: '#F06A2D',
  ink: '#0B2147',
  mute: '#5B6B7C',
  surface: '#F0F4F8',
  white: '#FFFFFF',
  border: '#D8E0E8',
  supportEmail: 'info@clox.com.au',
  legalEntity: 'Achieve Global Enterprises Pty Ltd trading as CLOX Freight Forwarding',
  abn: '48 626 269 387',
  tagline: "AUSTRALIA'S DIGITAL FULL-LOAD FREIGHT MARKETPLACE",
  /** Light wordmark for navy header — served from public web `/brand/`. */
  logoLightPath: '/brand/logo-clox-light.webp',
  logoWidthPx: 148,
} as const;

/** Absolute logo URL from marketing site base, or null if unavailable. */
export function resolveEmailLogoUrl(publicSiteUrl: string | null | undefined): string | null {
  if (!publicSiteUrl?.trim()) return null;
  const base = publicSiteUrl.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}${EMAIL_BRAND.logoLightPath}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type EmailDetailRow = { label: string; value: string };
export type EmailNextStep = { title: string; body: string };

export type BrandedEmailContent = {
  eyebrow: string;
  title: string;
  intro: string;
  details?: EmailDetailRow[];
  nextSteps?: EmailNextStep[];
  /** Absolute URL from env only (caller responsibility). */
  cta?: { label: string; href: string };
  supportEmail?: string;
  /** Absolute public site URL from env — footer + optional display. */
  publicSiteUrl?: string | null;
};

function detailRowsHtml(rows: EmailDetailRow[]): string {
  if (rows.length < 1) return '';
  const lines = rows
    .map(
      (row, index) => `
      <tr>
        <td style="padding:${index === 0 ? '0' : '10px'} 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:${EMAIL_BRAND.ink};">
          <span style="display:inline-block;min-width:1.25rem;margin-right:8px;color:${EMAIL_BRAND.orange};font-weight:700;">•</span>
          <strong style="color:${EMAIL_BRAND.navy};">${escapeHtml(row.label)}:</strong>
          ${escapeHtml(row.value)}
        </td>
      </tr>`,
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0 0;background:${EMAIL_BRAND.surface};border-radius:10px;">
      <tr>
        <td style="padding:18px 20px;">
          <p style="margin:0 0 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${EMAIL_BRAND.navy};">
            Details
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines}</table>
        </td>
      </tr>
    </table>`;
}

function nextStepsHtml(steps: EmailNextStep[]): string {
  if (steps.length < 1) return '';
  const items = steps
    .map(
      (step, index) => `
      <tr>
        <td style="padding:${index === 0 ? '0' : '14px'} 0 0 0;vertical-align:top;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td width="36" valign="top" style="padding-right:12px;">
                <div style="width:28px;height:28px;border-radius:14px;border:2px solid ${EMAIL_BRAND.navy};background:#FFF3EB;text-align:center;line-height:28px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${EMAIL_BRAND.orange};">
                  ${index + 1}
                </div>
              </td>
              <td style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:${EMAIL_BRAND.mute};">
                <strong style="display:block;margin-bottom:2px;color:${EMAIL_BRAND.navy};">${escapeHtml(step.title)}</strong>
                ${escapeHtml(step.body)}
              </td>
            </tr>
          </table>
        </td>
      </tr>`,
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0 0;">
      <tr>
        <td>
          <p style="margin:0 0 14px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:${EMAIL_BRAND.navy};">
            What happens next?
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
        </td>
      </tr>
    </table>`;
}

function ctaHtml(cta: { label: string; href: string } | undefined): string {
  if (!cta?.href) return '';
  const href = escapeHtml(cta.href);
  const label = escapeHtml(cta.label);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 0 auto;">
      <tr>
        <td align="center" bgcolor="${EMAIL_BRAND.orange}" style="border-radius:10px;">
          <a href="${href}" target="_blank" rel="noopener noreferrer"
            style="display:inline-block;padding:14px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:${EMAIL_BRAND.white};text-decoration:none;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

function footerSiteLine(publicSiteUrl: string | null | undefined, supportEmail: string): string {
  const enquire = `<a href="mailto:${escapeHtml(supportEmail)}" style="color:${EMAIL_BRAND.orange};text-decoration:underline;">${escapeHtml(supportEmail)}</a>`;
  if (!publicSiteUrl) {
    return `Enquiries: ${enquire}`;
  }
  const display = publicSiteUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `Enquiries: ${enquire} &nbsp;|&nbsp; <a href="${escapeHtml(publicSiteUrl)}" style="color:${EMAIL_BRAND.orange};text-decoration:none;">${escapeHtml(display)}</a>`;
}

function headerBrandHtml(publicSiteUrl: string | null | undefined): string {
  const logoUrl = resolveEmailLogoUrl(publicSiteUrl);
  const siteHref = publicSiteUrl?.trim().replace(/\/$/, '') ?? '';
  const brandBlock =
    logoUrl && siteHref
      ? `<a href="${escapeHtml(siteHref)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">
                <img src="${escapeHtml(logoUrl)}" width="${EMAIL_BRAND.logoWidthPx}" alt="CLOX Freight Forwarding"
                  style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:${EMAIL_BRAND.logoWidthPx}px;" />
              </a>`
      : `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:26px;font-weight:800;letter-spacing:0.02em;color:${EMAIL_BRAND.white};">
                CLOX <span style="color:${EMAIL_BRAND.orange};font-weight:600;font-size:14px;">Freight Forwarding</span>
              </p>`;
  return `
            <td style="background:${EMAIL_BRAND.navy};padding:28px 28px 24px 28px;">
              ${brandBlock}
              <p style="margin:14px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#C9D4E3;">
                ${EMAIL_BRAND.tagline}
              </p>
            </td>`;
}

/** Full multipart-friendly HTML document. Hosted header logo when publicSiteUrl is set. */
export function renderBrandedEmailHtml(content: BrandedEmailContent): string {
  const support = content.supportEmail ?? EMAIL_BRAND.supportEmail;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(content.title)}</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_BRAND.surface};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_BRAND.surface};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${EMAIL_BRAND.white};border-radius:12px;overflow:hidden;">
          <tr>
${headerBrandHtml(content.publicSiteUrl)}
          </tr>
          <tr>
            <td style="padding:28px 28px 8px 28px;">
              <p style="margin:0 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_BRAND.orange};">
                ${escapeHtml(content.eyebrow)}
              </p>
              <h1 style="margin:0 0 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:26px;line-height:1.25;font-weight:800;color:${EMAIL_BRAND.navy};">
                ${escapeHtml(content.title)}
              </h1>
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:${EMAIL_BRAND.mute};">
                ${escapeHtml(content.intro)}
              </p>
              ${detailRowsHtml(content.details ?? [])}
              ${nextStepsHtml(content.nextSteps ?? [])}
              ${ctaHtml(content.cta)}
              <p style="margin:20px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:${EMAIL_BRAND.mute};text-align:center;">
                If you have any questions, please email
                <a href="mailto:${escapeHtml(support)}" style="color:${EMAIL_BRAND.orange};">${escapeHtml(support)}</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px 0 28px;">
              <div style="height:3px;background:${EMAIL_BRAND.orange};line-height:3px;font-size:0;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td style="background:${EMAIL_BRAND.navy};padding:22px 28px;text-align:center;">
              <p style="margin:0 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:${EMAIL_BRAND.white};">
                CLOX Freight Forwarding
              </p>
              <p style="margin:0 0 4px 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#A8B6C8;">
                ${EMAIL_BRAND.legalEntity}
              </p>
              <p style="margin:0 0 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#A8B6C8;">
                ABN ${EMAIL_BRAND.abn}
              </p>
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#C9D4E3;">
                ${footerSiteLine(content.publicSiteUrl, support)}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function accountTypeLabel(roleOrType: string): string {
  const map: Record<string, string> = {
    SUPER_ADMIN: 'Super Admin',
    STATE_MASTER: 'State Master',
    LOCAL_BDE: 'Local BDE',
    SENDER: 'Sender / Shipper',
    TRANSPORT_COMPANY: 'Carrier / Transport Operator',
    DRIVER: 'Driver',
    REGISTRY_SENDER: 'Registry — Sender',
    REGISTRY_CARRIER: 'Registry — Carrier',
    EOI_STATE_MASTER: 'Partner EOI — State Master',
    EOI_LOCAL_BDE: 'Partner EOI — Local BDE',
    INVESTOR: 'Investor enquiry',
    CARRIER: 'Carrier / Transport Operator',
  };
  return map[roleOrType] ?? roleOrType.replace(/_/g, ' ');
}

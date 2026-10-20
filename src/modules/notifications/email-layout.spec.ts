import {
  accountTypeLabel,
  escapeHtml,
  renderBrandedEmailHtml,
  resolveEmailLogoUrl,
} from './email-layout';

describe('email-layout', () => {
  it('escapes HTML in user-controlled fields', () => {
    expect(escapeHtml(`a<b>"&'`)).toBe('a&lt;b&gt;&quot;&amp;&#39;');
  });

  it('resolves hosted logo URL from public site base', () => {
    expect(resolveEmailLogoUrl('https://clox.com.au/')).toBe(
      'https://clox.com.au/brand/logo-clox-light.png',
    );
    expect(resolveEmailLogoUrl(null)).toBeNull();
    expect(resolveEmailLogoUrl('not-a-url')).toBeNull();
  });

  it('renders branded HTML with hosted logo and without CID/base64', () => {
    const html = renderBrandedEmailHtml({
      eyebrow: 'Registration confirmation',
      title: 'Welcome to CLOX!',
      intro: 'Thanks for registering.',
      details: [
        { label: 'Account type', value: 'Carrier / Transport Operator' },
        { label: 'Email', value: 'carrier@yopmail.com' },
      ],
      nextSteps: [{ title: 'Sign in', body: 'Request an OTP.' }],
      cta: { label: 'Sign in to CLOX →', href: 'http://localhost:5174/login' },
      publicSiteUrl: 'https://clox.com.au',
    });
    expect(html).toContain('CLOX');
    expect(html).toContain('Account type');
    expect(html).toContain('http://localhost:5174/login');
    expect(html).toContain('clox.com.au');
    expect(html).toContain('https://clox.com.au/brand/logo-clox-light.png');
    expect(html).toMatch(/<img\b[^>]*src="https:\/\/clox\.com\.au\/brand\/logo-clox-light\.png"/i);
    expect(html).not.toMatch(/cid:/i);
    expect(html).not.toMatch(/data:image/i);
    expect(html).not.toMatch(/pre-launch/i);
  });

  it('falls back to text wordmark when publicSiteUrl is missing', () => {
    const html = renderBrandedEmailHtml({
      eyebrow: 'Notice',
      title: 'Hello',
      intro: 'Body',
    });
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain('Freight Forwarding');
  });

  it('maps account types to readable labels', () => {
    expect(accountTypeLabel('TRANSPORT_COMPANY')).toBe('Carrier / Transport Operator');
    expect(accountTypeLabel('REGISTRY_SENDER')).toBe('Registry — Sender');
  });
});

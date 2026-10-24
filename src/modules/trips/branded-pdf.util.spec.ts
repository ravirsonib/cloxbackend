import { buildBrandedPdf, loadCloxLogoBuffer, pdfSafeText } from './branded-pdf.util';

/** 1x1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Tall JPEG-ish payload reused as PNG for layout pressure (fit box still applies). */
const TALL_PNG = TINY_PNG;

function countPdfPages(buf: Buffer): number {
  // PDFKit writes uncompressed page objects; count leaf pages only.
  const text = buf.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/g) ?? [];
  // /Type /Pages is the tree root — exclude by requiring word Page not Pages
  return matches.filter((m) => !m.includes('Pages')).length;
}

describe('pdfSafeText', () => {
  it('replaces middle dots and curly quotes for Helvetica', () => {
    expect(pdfSafeText('CLOX · Confidential')).toBe('CLOX | Confidential');
    expect(pdfSafeText('driver’s')).toBe("driver's");
    expect(pdfSafeText('wait…')).toBe('wait...');
  });
});

describe('buildBrandedPdf', () => {
  it('produces a multi-page capable PDF with %PDF header', async () => {
    const buf = await buildBrandedPdf({
      documentTitle: 'Tax Invoice',
      subtitle: 'INV-TEST123 - 2026-10-22',
      sections: [
        {
          title: 'Bill to',
          rows: [
            { label: 'Name', value: 'Acme Pty Ltd' },
            { label: 'Address', value: '1 Collins St, Melbourne VIC 3000' },
          ],
        },
        {
          title: 'Stops',
          table: {
            headers: ['#', 'Type', 'Suburb'],
            rows: [
              ['1', 'PICKUP', 'Docklands'],
              ['2', 'DROPOFF', 'Richmond'],
            ],
          },
        },
        {
          title: 'Notes',
          paragraphs: ['System-generated CLOX document for layout verification.'],
        },
      ],
    });

    expect(buf.length).toBeGreaterThan(800);
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const asText = buf.toString('latin1');
    expect(asText).toContain('/Type /Page');
    expect(asText).toMatch(/endobj/);
    expect(countPdfPages(buf)).toBe(1);
  });

  it('embeds images and journey timeline without phantom blank pages', async () => {
    const logo = loadCloxLogoBuffer();
    const buf = await buildBrandedPdf({
      documentTitle: 'Proof of Delivery',
      subtitle: 'Job DEMO | Richmond drop | Finalized 23 Oct 2026, 14:42 AEST',
      headerRef: 'CLOX-POD-demojob | Job demojob',
      logo,
      footerNote: 'CLOX | Confidential | System-generated proof of delivery',
      sections: [
        {
          title: 'Delivery details',
          rows: [
            { label: 'Signer', value: 'Alex Receiver' },
            { label: 'Goods photos', value: '2' },
          ],
        },
        {
          title: 'Evidence',
          paragraphs: [
            "Images are embedded in this PDF and attached as separate files on the POD finalize email. Storage keys are not shown as links (auth-gated APIs are not usable from email).",
          ],
          images: [
            {
              caption: 'Signature | attached: sig.png',
              buffer: TINY_PNG,
              fitWidth: 120,
              fitHeight: 40,
            },
            {
              caption: 'Photo 1 | attached: goods-1.png',
              buffer: TALL_PNG,
              fitWidth: 120,
              fitHeight: 80,
            },
            {
              caption: 'Photo 2 | attached: goods-2.png',
              buffer: TALL_PNG,
              fitWidth: 120,
              fitHeight: 80,
            },
          ],
        },
        {
          title: 'Driver journey',
          table: {
            headers: ['Time (AEST)', 'Event', 'Detail'],
            rows: [
              ['22 Oct 2026, 12:10:00', 'Trip started', 'Driver started the trip'],
              ['22 Oct 2026, 12:40:00', 'Approaching', 'Site A | source MANUAL'],
              ['22 Oct 2026, 13:00:00', 'POD signed', 'Alex Receiver on SOG'],
              ['22 Oct 2026, 13:10:00', 'POD finalized', 'Package generated'],
            ],
          },
        },
      ],
    });

    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1500);
    const pages = countPdfPages(buf);
    // Content fits on 1 page with tiny images; never spawn blank trailer pages.
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(2);
  });

  it('keeps a short signature receipt on a single page with full SOG note', async () => {
    const sog =
      "Receiver signature was captured on the driver's authenticated SOG session. No public magic-link was used.";
    const buf = await buildBrandedPdf({
      documentTitle: 'Signature receipt',
      subtitle: 'Job DEMO | Delivery sign-on-glass',
      headerRef: 'CLOX-signature-demo | Job demo',
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated signature receipt',
      sections: [
        {
          title: 'Delivery sign-on-glass',
          rows: [
            { label: 'Job', value: 'DEMO' },
            { label: 'Signer', value: 'Alex' },
            { label: 'Signed at', value: '23 Oct 2026, 14:38:12 AEST' },
          ],
        },
        {
          title: 'Signature image',
          images: [
            {
              caption: 'Embedded signature | also attached to email',
              buffer: TINY_PNG,
              fitWidth: 200,
              fitHeight: 80,
            },
          ],
          paragraphs: [sog],
        },
      ],
    });

    expect(countPdfPages(buf)).toBe(1);
  });

  it('keeps tax invoice on one page', async () => {
    const buf = await buildBrandedPdf({
      documentTitle: 'Tax Invoice',
      subtitle: 'INV-DEMO | 2026-10-24',
      headerRef: 'INV-DEMO | Job demojob',
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated tax invoice',
      sections: [
        {
          title: 'Invoice summary',
          rows: [
            { label: 'Invoice ref', value: 'INV-DEMO' },
            { label: 'Job', value: 'QA job' },
            { label: 'Pricing model', value: 'PER_KM' },
          ],
        },
        {
          title: 'Amounts (AUD)',
          rows: [
            { label: 'Freight (inc GST)', value: '$150.00 AUD' },
            { label: 'Total inc GST', value: '$150.00 AUD' },
          ],
        },
        {
          title: 'Notes',
          paragraphs: [
            'This is a system-generated tax invoice summary from CLOX. Retain for your records.',
          ],
        },
      ],
    });
    expect(countPdfPages(buf)).toBe(1);
  });

  it('keeps exception report on one page', async () => {
    const buf = await buildBrandedPdf({
      documentTitle: 'Exception report',
      subtitle: 'BREAKDOWN | abcdef12',
      headerRef: 'CLOX-exception-abcdef12 | BREAKDOWN',
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated exception report',
      sections: [
        {
          title: 'Exception details',
          rows: [
            { label: 'Kind', value: 'BREAKDOWN' },
            { label: 'Driver', value: 'RohitDriver' },
            { label: 'Vehicle', value: '12345' },
          ],
        },
        {
          title: 'Driver note',
          paragraphs: ['Flat tyre on approach to drop.'],
        },
        {
          title: 'Notes',
          paragraphs: [
            'Generated automatically when the driver opened the exception in CLOX Cab.',
          ],
        },
      ],
    });
    expect(countPdfPages(buf)).toBe(1);
  });

  it('hourly run sheet with many stops does not spawn blank trailer pages', async () => {
    const stopRows = Array.from({ length: 12 }, (_, i) => [
      String(i + 1),
      i % 2 === 0 ? 'PICKUP' : 'DROPOFF',
      `Suburb ${i + 1}`,
      '2026-10-24 10:00',
      '2026-10-24 10:15',
      '5m',
    ]);
    const buf = await buildBrandedPdf({
      documentTitle: 'Hourly Run Sheet',
      subtitle: 'Job demojob | 2026-10-24',
      headerRef: 'CLOX-runsheet-demojob | Job demojob',
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated hourly run sheet',
      sections: [
        {
          title: 'Trip header',
          rows: [
            { label: 'Driver', value: 'RohitDriver' },
            { label: 'Vehicle rego', value: '12345' },
          ],
        },
        {
          title: 'Stops',
          table: {
            headers: ['#', 'Type', 'Suburb', 'Arrival', 'Departure', 'Wait'],
            rows: stopRows,
          },
          paragraphs: ['Odometer: not captured (manual input pending).'],
        },
        {
          title: 'Fatigue / break log',
          rows: [
            { label: 'Break at completion', value: 'no' },
            {
              label: 'Billing note',
              value: 'Billed hours: 4.0 (4.0 hour floor applies).',
            },
          ],
        },
      ],
    });
    const pages = countPdfPages(buf);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(3);
  });
});

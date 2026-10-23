import { buildBrandedPdf, loadCloxLogoBuffer } from './branded-pdf.util';

/** 1×1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('buildBrandedPdf', () => {
  it('produces a multi-page capable PDF with %PDF header', async () => {
    const buf = await buildBrandedPdf({
      documentTitle: 'Tax Invoice',
      subtitle: 'INV-TEST123 · 2026-10-22',
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
    // Content streams may be compressed; assert PDF structure markers.
    const asText = buf.toString('latin1');
    expect(asText).toContain('/Type /Page');
    expect(asText).toMatch(/endobj/);
  });

  it('embeds images and journey timeline without throwing', async () => {
    const logo = loadCloxLogoBuffer();
    const buf = await buildBrandedPdf({
      documentTitle: 'Proof of Delivery',
      subtitle: 'Job DEMO · Richmond drop · Finalized 23 Oct 2026, 14:42 AEST',
      headerRef: 'CLOX-POD-demojob · Job demojob',
      logo,
      footerNote: 'CLOX · Confidential · System-generated proof of delivery',
      sections: [
        {
          title: 'Delivery details',
          rows: [
            { label: 'Signer', value: 'Alex Receiver' },
            { label: 'Goods photos', value: '1' },
          ],
        },
        {
          title: 'Evidence',
          paragraphs: ['Images embedded below.'],
          images: [
            {
              caption: 'Signature · attached: sig.png',
              buffer: TINY_PNG,
              fitWidth: 120,
              fitHeight: 40,
            },
            {
              caption: 'Photo 1 · attached: goods-1.png',
              buffer: TINY_PNG,
              fitWidth: 120,
              fitHeight: 80,
            },
          ],
        },
        {
          title: 'Driver journey',
          table: {
            headers: ['Time', 'Event', 'Detail'],
            rows: [
              ['22 Oct 2026, 12:10:00', 'Trip started', 'Driver started the trip'],
              ['22 Oct 2026, 12:40:00', 'Approaching', 'Site A · source MANUAL'],
              ['22 Oct 2026, 13:00:00', 'POD signed', 'Alex Receiver on SOG'],
              ['22 Oct 2026, 13:10:00', 'POD finalized', 'Package generated'],
            ],
          },
        },
      ],
    });

    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1500);
    const asText = buf.toString('latin1');
    expect(asText).toContain('/Type /Page');
  });
});

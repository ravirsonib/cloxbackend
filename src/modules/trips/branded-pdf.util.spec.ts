import { buildBrandedPdf } from './branded-pdf.util';

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
});

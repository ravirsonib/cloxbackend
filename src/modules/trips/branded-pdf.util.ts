import PDFDocument from 'pdfkit';

export type BrandedPdfKv = { label: string; value: string };

export type BrandedPdfSection = {
  title: string;
  rows?: BrandedPdfKv[];
  paragraphs?: string[];
  /** Simple table: first row = headers */
  table?: { headers: string[]; rows: string[][] };
};

export type BrandedPdfInput = {
  /** Document title under the CLOX header (e.g. Tax Invoice) */
  documentTitle: string;
  /** Short subtitle / ref line */
  subtitle?: string;
  sections: BrandedPdfSection[];
  /** Footer left text override */
  footerNote?: string;
};

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = { left: 48, right: 48, top: 48, bottom: 56 };
const HEADER_H = 64;
const COLORS = {
  navy: '#1a2f4c',
  ink: '#17233b',
  mute: '#5b6b84',
  line: '#dce2ec',
  orange: '#f26e22',
  surface: '#f3f5f9',
  white: '#ffffff',
};

function contentWidth() {
  return PAGE.width - MARGIN.left - MARGIN.right;
}

/**
 * Branded CLOX PDF: navy header with CLOX wordmark, structured sections,
 * and a footer on every page. PDFKit layout (no HTML/CSS) — stable alignment.
 */
export async function buildBrandedPdf(input: BrandedPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: HEADER_H + 28,
        bottom: MARGIN.bottom + 12,
        left: MARGIN.left,
        right: MARGIN.right,
      },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: `CLOX — ${input.documentTitle}`,
        Author: 'CLOX',
        Subject: input.subtitle ?? input.documentTitle,
        Creator: 'CLOX Platform',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const drawHeader = () => {
      doc.save();
      doc.rect(0, 0, PAGE.width, HEADER_H).fill(COLORS.navy);
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18);
      doc.text('CLOX', MARGIN.left, 18, { width: 160, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor('#c9d3e4');
      doc.text('Freight marketplace · Australia', MARGIN.left, 40, {
        width: 220,
        lineBreak: false,
      });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.white);
      doc.text(truncate(input.documentTitle, 42), MARGIN.left + 200, 28, {
        width: contentWidth() - 200,
        align: 'right',
        lineBreak: false,
      });
      doc.rect(0, HEADER_H, PAGE.width, 3).fill(COLORS.orange);
      doc.restore();
    };

    drawHeader();
    doc.on('pageAdded', () => {
      drawHeader();
    });

    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(16);
    doc.text(input.documentTitle, { width: contentWidth() });
    if (input.subtitle) {
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.mute);
      doc.text(input.subtitle, { width: contentWidth() });
    }
    doc.moveDown(0.75);

    for (const section of input.sections) {
      ensureSpace(doc, 48);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.navy);
      doc.text(section.title, { width: contentWidth() });
      const ruleY = doc.y + 3;
      doc
        .moveTo(MARGIN.left, ruleY)
        .lineTo(MARGIN.left + contentWidth(), ruleY)
        .strokeColor(COLORS.line)
        .lineWidth(1)
        .stroke();
      doc.y = ruleY + 8;

      if (section.paragraphs?.length) {
        doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
        for (const p of section.paragraphs) {
          ensureSpace(doc, 24);
          doc.text(p, { width: contentWidth(), align: 'left' });
          doc.moveDown(0.3);
        }
      }

      if (section.rows?.length) {
        for (const row of section.rows) {
          ensureSpace(doc, 20);
          const y = doc.y;
          const labelW = 148;
          const valueW = contentWidth() - labelW - 10;
          doc.font('Helvetica').fontSize(9).fillColor(COLORS.mute);
          doc.text(row.label, MARGIN.left, y, {
            width: labelW,
            lineBreak: false,
          });
          doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
          const valueHeight = doc.heightOfString(row.value || '—', {
            width: valueW,
          });
          doc.text(row.value || '—', MARGIN.left + labelW + 10, y, {
            width: valueW,
          });
          doc.y = Math.max(y + 14, y + valueHeight + 4);
        }
        doc.moveDown(0.25);
      }

      if (section.table && section.table.headers.length > 0) {
        drawTable(doc, section.table.headers, section.table.rows);
        doc.moveDown(0.4);
      }

      doc.moveDown(0.3);
    }

    const range = doc.bufferedPageRange();
    const footerLeft =
      input.footerNote ?? 'CLOX · Confidential · System-generated document';
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const footerY = PAGE.height - 34;
      doc
        .moveTo(MARGIN.left, footerY - 10)
        .lineTo(MARGIN.left + contentWidth(), footerY - 10)
        .strokeColor(COLORS.line)
        .lineWidth(0.8)
        .stroke();
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.mute);
      doc.text(footerLeft, MARGIN.left, footerY, {
        width: contentWidth() * 0.68,
        lineBreak: false,
      });
      doc.text(`Page ${i + 1} of ${range.count}`, MARGIN.left, footerY, {
        width: contentWidth(),
        align: 'right',
        lineBreak: false,
      });
    }

    doc.end();
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > PAGE.height - MARGIN.bottom - 24) {
    doc.addPage();
  }
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
) {
  const colCount = headers.length;
  const width = contentWidth();
  const colW = width / colCount;
  const pad = 4;

  const measure = (text: string, bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    return doc.heightOfString(text || '—', { width: colW - pad * 2 });
  };

  const drawRow = (cells: string[], header: boolean) => {
    const heights = cells.map((c) => measure(c, header));
    const rowH = Math.max(16, ...heights) + pad * 2;
    ensureSpace(doc, rowH + 2);
    const y = doc.y;
    if (header) {
      doc.rect(MARGIN.left, y, width, rowH).fill(COLORS.surface);
    }
    doc.strokeColor(COLORS.line).lineWidth(0.6);
    doc.rect(MARGIN.left, y, width, rowH).stroke();
    for (let i = 1; i < colCount; i++) {
      const x = MARGIN.left + colW * i;
      doc.moveTo(x, y).lineTo(x, y + rowH).stroke();
    }
    for (let i = 0; i < colCount; i++) {
      doc
        .font(header ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8)
        .fillColor(COLORS.ink)
        .text(cells[i] || '—', MARGIN.left + colW * i + pad, y + pad, {
          width: colW - pad * 2,
          height: rowH - pad * 2,
        });
    }
    doc.y = y + rowH;
  };

  drawRow(headers, true);
  for (const row of rows) {
    const padded = [...row];
    while (padded.length < colCount) padded.push('—');
    drawRow(padded.slice(0, colCount), false);
  }
}

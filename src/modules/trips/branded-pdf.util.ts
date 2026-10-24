import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';

export type BrandedPdfKv = { label: string; value: string };

export type BrandedPdfImage = {
  /** Caption above the image */
  caption: string;
  buffer: Buffer;
  /** Optional fit width; default ~ half content width */
  fitWidth?: number;
  fitHeight?: number;
};

export type BrandedPdfSection = {
  title: string;
  rows?: BrandedPdfKv[];
  paragraphs?: string[];
  /** Simple table: first row = headers */
  table?: { headers: string[]; rows: string[][] };
  images?: BrandedPdfImage[];
};

export type BrandedPdfInput = {
  /** Document title under the CLOX header (e.g. Tax Invoice) */
  documentTitle: string;
  /** Short subtitle / ref line */
  subtitle?: string;
  /** Right-side header ref under document title (e.g. CLOX-POD-a1b2c3d4 | Job ...) */
  headerRef?: string;
  sections: BrandedPdfSection[];
  /** Footer left text override */
  footerNote?: string;
  /** Optional logo PNG/JPEG buffer; falls back to wordmark text */
  logo?: Buffer | null;
  /** Hide duplicate H1 under header (header already shows documentTitle) */
  omitBodyTitle?: boolean;
};

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = { left: 48, right: 48 };
/** Navy bar height; orange accent sits on HEADER_H. */
const HEADER_H = 64;
const ACCENT_H = 3;
const CONTENT_TOP = HEADER_H + ACCENT_H + 20;
const FOOTER_ZONE = 36;
const COLORS = {
  navy: '#1a2f4c',
  ink: '#17233b',
  mute: '#5b6b84',
  line: '#dce2ec',
  orange: '#f26e22',
  surface: '#f3f5f9',
  white: '#ffffff',
  headerMute: '#c9d3e4',
};

function contentWidth() {
  return PAGE.width - MARGIN.left - MARGIN.right;
}

function contentBottom() {
  return PAGE.height - FOOTER_ZONE - 8;
}

/** Helvetica cannot paint many Unicode glyphs — normalize for PDFKit. */
export function pdfSafeText(value: string): string {
  return value
    .replace(/\s*\u00b7\s*/g, ' | ') // middle dot
    .replace(/\u2022/g, '-') // bullet
    .replace(/[\u2013\u2014]/g, '-') // en/em dash
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2011/g, '-');
}

/** Resolve default CLOX light logo from api/assets/brand (monorepo layout). */
export function loadCloxLogoBuffer(): Buffer | null {
  const candidates = [
    join(__dirname, '..', '..', '..', 'assets', 'brand', 'logo-clox-light.png'),
    join(process.cwd(), 'assets', 'brand', 'logo-clox-light.png'),
    join(process.cwd(), 'api', 'assets', 'brand', 'logo-clox-light.png'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return readFileSync(path);
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/**
 * Branded CLOX PDF: navy header with logo (or wordmark), structured sections,
 * embedded images, tables, and a footer on every page.
 */
export async function buildBrandedPdf(input: BrandedPdfInput): Promise<Buffer> {
  const logo = input.logo === undefined ? loadCloxLogoBuffer() : input.logo;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: CONTENT_TOP,
        bottom: FOOTER_ZONE,
        left: MARGIN.left,
        right: MARGIN.right,
      },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: `CLOX - ${pdfSafeText(input.documentTitle)}`,
        Author: 'CLOX',
        Subject: pdfSafeText(input.subtitle ?? input.documentTitle),
        Creator: 'CLOX Platform',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    /**
     * Header must not move doc.x / doc.y — PDFKit image/text with absolute
     * coords still advance the flow cursor, which caused body/header overlap
     * and footer writes that spawned blank pages.
     */
    const drawHeader = () => {
      const savedX = doc.x;
      const savedY = doc.y;
      doc.save();
      doc.rect(0, 0, PAGE.width, HEADER_H).fill(COLORS.navy);

      let brandRight = MARGIN.left;
      if (logo && logo.length > 0) {
        try {
          doc.image(logo, MARGIN.left, 12, { fit: [130, 28] });
          brandRight = MARGIN.left + 138;
        } catch {
          doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(16);
          doc.text('CLOX', MARGIN.left, 16, { width: 100, lineBreak: false });
          brandRight = MARGIN.left + 70;
        }
      } else {
        doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(16);
        doc.text('CLOX', MARGIN.left, 16, { width: 100, lineBreak: false });
        brandRight = MARGIN.left + 70;
      }

      doc.font('Helvetica').fontSize(8).fillColor(COLORS.headerMute);
      doc.text('Freight marketplace - Australia', brandRight, 22, {
        width: 180,
        lineBreak: false,
      });

      const headerRightW = Math.max(160, PAGE.width - MARGIN.right - (brandRight + 190));
      const headerRightX = PAGE.width - MARGIN.right - headerRightW;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.white);
      doc.text(truncate(pdfSafeText(input.documentTitle), 42), headerRightX, input.headerRef ? 16 : 24, {
        width: headerRightW,
        align: 'right',
        lineBreak: false,
      });
      if (input.headerRef) {
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.headerMute);
        doc.text(truncate(pdfSafeText(input.headerRef), 58), headerRightX, 32, {
          width: headerRightW,
          align: 'right',
          lineBreak: false,
        });
      }
      doc.rect(0, HEADER_H, PAGE.width, ACCENT_H).fill(COLORS.orange);
      doc.restore();
      doc.x = savedX;
      doc.y = savedY;
    };

    const resetFlowToContentTop = () => {
      doc.x = MARGIN.left;
      doc.y = CONTENT_TOP;
    };

    drawHeader();
    resetFlowToContentTop();
    // Only paint chrome on new pages. Do NOT move doc.x/doc.y here —
    // PDFKit may fire pageAdded mid-text() while wrapping a line; resetting
    // the cursor drops the remainder (seen as "No public m" truncation).
    doc.on('pageAdded', () => {
      drawHeader();
    });

    if (!input.omitBodyTitle) {
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(16);
      doc.text(pdfSafeText(input.documentTitle), {
        width: contentWidth(),
        lineGap: 2,
      });
    }
    if (input.subtitle) {
      if (!input.omitBodyTitle) doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.mute);
      doc.text(pdfSafeText(input.subtitle), {
        width: contentWidth(),
        lineGap: 2,
      });
    }
    doc.moveDown(0.7);

    for (const section of input.sections) {
      ensureSpace(doc, 44);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.navy);
      doc.text(pdfSafeText(section.title), { width: contentWidth() });
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
          const text = pdfSafeText(p);
          const h = doc.heightOfString(text, {
            width: contentWidth(),
            lineGap: 2,
          });
          ensureSpace(doc, h + 12);
          doc.fillColor(COLORS.ink).font('Helvetica').fontSize(10);
          doc.text(text, MARGIN.left, doc.y, {
            width: contentWidth(),
            align: 'left',
            lineGap: 2,
          });
          doc.x = MARGIN.left;
          doc.moveDown(0.35);
        }
      }

      if (section.rows?.length) {
        for (const row of section.rows) {
          const label = pdfSafeText(row.label);
          const value = pdfSafeText(row.value || '-');
          const labelW = 148;
          const valueW = contentWidth() - labelW - 10;
          doc.font('Helvetica').fontSize(10);
          const valueHeight = doc.heightOfString(value, { width: valueW });
          ensureSpace(doc, Math.max(16, valueHeight + 6));
          const y = doc.y;
          doc.font('Helvetica').fontSize(9).fillColor(COLORS.mute);
          doc.text(label, MARGIN.left, y, {
            width: labelW,
            lineBreak: false,
          });
          doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
          doc.text(value, MARGIN.left + labelW + 10, y, {
            width: valueW,
            lineGap: 1,
          });
          doc.y = Math.max(y + 14, y + valueHeight + 4);
        }
        doc.moveDown(0.25);
      }

      if (section.table && section.table.headers.length > 0) {
        drawTable(doc, section.table.headers, section.table.rows);
        doc.moveDown(0.4);
      }

      if (section.images?.length) {
        for (const img of section.images) {
          const fitW = img.fitWidth ?? Math.min(240, contentWidth());
          const fitH = img.fitHeight ?? 140;
          const caption = pdfSafeText(img.caption);
          doc.font('Helvetica').fontSize(9);
          const captionH = doc.heightOfString(caption, { width: contentWidth() });
          const blockH = captionH + 6 + fitH + 12;
          ensureSpace(doc, blockH);
          const captionY = doc.y;
          doc.fillColor(COLORS.mute).text(caption, MARGIN.left, captionY, {
            width: contentWidth(),
            lineGap: 1,
          });
          const imageY = doc.y + 4;
          try {
            const savedX = doc.x;
            const savedY = doc.y;
            doc.image(img.buffer, MARGIN.left, imageY, {
              fit: [fitW, fitH],
            });
            // image() advances cursor — pin below the fit box
            doc.x = savedX;
            doc.y = Math.max(savedY, imageY + fitH + 10);
            doc.x = MARGIN.left;
          } catch {
            doc.font('Helvetica').fontSize(9).fillColor(COLORS.mute);
            doc.text('[ Image could not be embedded ]', MARGIN.left, imageY, {
              width: contentWidth(),
              lineBreak: false,
            });
            doc.x = MARGIN.left;
            doc.y = imageY + 18;
          }
        }
        doc.moveDown(0.2);
      }

      doc.moveDown(0.3);
    }

    // Footers: must write inside the reserved zone without triggering addPage.
    const range = doc.bufferedPageRange();
    const footerLeft = pdfSafeText(
      input.footerNote ?? 'CLOX | Confidential | System-generated document',
    );
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const savedX = doc.x;
      const savedY = doc.y;
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      const footerY = PAGE.height - 26;
      doc.save();
      doc
        .moveTo(MARGIN.left, footerY - 10)
        .lineTo(MARGIN.left + contentWidth(), footerY - 10)
        .strokeColor(COLORS.line)
        .lineWidth(0.8)
        .stroke();
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.mute);
      doc.text(footerLeft, MARGIN.left, footerY, {
        width: contentWidth() * 0.62,
        height: 12,
        lineBreak: false,
      });
      doc.text(`Page ${i + 1} of ${range.count}`, MARGIN.left, footerY, {
        width: contentWidth(),
        height: 12,
        align: 'right',
        lineBreak: false,
      });
      doc.restore();

      doc.page.margins.bottom = savedBottom;
      doc.x = savedX;
      doc.y = savedY;
    }

    doc.end();
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > contentBottom()) {
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
    return doc.heightOfString(pdfSafeText(text || '-'), { width: colW - pad * 2 });
  };

  const drawRow = (cells: string[], header: boolean) => {
    const safe = cells.map((c) => pdfSafeText(c || '-'));
    const heights = safe.map((c) => measure(c, header));
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
        .text(safe[i]!, MARGIN.left + colW * i + pad, y + pad, {
          width: colW - pad * 2,
          height: rowH - pad * 2,
        });
    }
    doc.x = MARGIN.left;
    doc.y = y + rowH;
  };

  drawRow(headers, true);
  for (const row of rows) {
    const padded = [...row];
    while (padded.length < colCount) padded.push('-');
    drawRow(padded.slice(0, colCount), false);
  }
}

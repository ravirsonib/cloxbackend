import { createHash, randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const trimmed = dataUrl.trim();
  const match = /^data:([^;]+);base64,(.+)$/s.exec(trimmed);
  if (match) {
    return {
      mime: match[1]!.toLowerCase(),
      buffer: Buffer.from(match[2]!, 'base64'),
    };
  }
  // raw base64 PNG fallback
  return { mime: 'image/png', buffer: Buffer.from(trimmed, 'base64') };
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function writeTripArtifact(params: {
  rootDir: string;
  tripId: string;
  /** Stop id, exception id, or `_trip` for trip-level docs */
  stopId: string;
  kind: 'signature' | 'photo' | 'pod-pdf' | 'signature-pdf' | 'breakdown-pdf' | 'invoice-pdf' | 'run-sheet-pdf';
  ext: string;
  buffer: Buffer;
}): Promise<{ storageKey: string; contentHash: string; absPath: string }> {
  const storageKey = `trips/${params.tripId}/${params.stopId}/${params.kind}-${randomUUID()}.${params.ext}`;
  const absPath = join(params.rootDir, storageKey);
  await mkdir(join(params.rootDir, 'trips', params.tripId, params.stopId), { recursive: true });
  await writeFile(absPath, params.buffer);
  return { storageKey, contentHash: sha256Hex(params.buffer), absPath };
}

export function formatAudCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)} AUD`;
}

export {
  buildBrandedPdf,
  loadCloxLogoBuffer,
  type BrandedPdfImage,
  type BrandedPdfInput,
  type BrandedPdfKv,
  type BrandedPdfSection,
} from './branded-pdf.util';

export {
  buildPodJourney,
  formatJourneyForTable,
  type PodJourneyEvent,
  type PodJourneyInput,
} from './pod-journey.util';

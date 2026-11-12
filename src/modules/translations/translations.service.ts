import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  DEFAULT_LOCALE,
  normalizeAppLocale,
  type TranslationPreviewInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TranslationsService {
  constructor(private readonly prisma: PrismaService) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private hashSource(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  /**
   * Deterministic stub translator for on-read UGC preview.
   * Never overwrites source columns; real providers can replace this later.
   */
  private stubTranslate(text: string, targetLocale: string): string {
    const lang = normalizeAppLocale(targetLocale);
    if (lang === DEFAULT_LOCALE) return text;
    return `[${lang}] ${text}`;
  }

  async preview(input: TranslationPreviewInput) {
    this.ensureDatabase();
    const targetLocale = normalizeAppLocale(input.targetLocale);
    const sourceLocale = input.sourceLocale
      ? normalizeAppLocale(input.sourceLocale)
      : null;
    const text = input.text;
    const sourceHash = this.hashSource(text);

    if (sourceLocale && sourceLocale === targetLocale) {
      return {
        text,
        translatedText: text,
        targetLocale,
        sourceLocale,
        cached: false,
        provider: 'identity',
      };
    }

    const existing = await this.prisma.contentTranslation.findUnique({
      where: {
        sourceHash_targetLocale: { sourceHash, targetLocale },
      },
    });
    if (existing) {
      return {
        text,
        translatedText: existing.text,
        targetLocale,
        sourceLocale: existing.sourceLocale ?? sourceLocale,
        cached: true,
        provider: existing.provider,
      };
    }

    const translatedText = this.stubTranslate(text, targetLocale);
    const created = await this.prisma.contentTranslation.create({
      data: {
        sourceHash,
        sourceLocale,
        targetLocale,
        text: translatedText,
        provider: 'stub',
      },
    });

    return {
      text,
      translatedText: created.text,
      targetLocale,
      sourceLocale,
      cached: false,
      provider: created.provider,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../../config/env.validation';

export type AbrLookupResult = {
  configured: boolean;
  abn: string;
  active: boolean | null;
  entityName: string | null;
  abnStatus: string | null;
  message: string;
  raw?: unknown;
};

/**
 * Optional ABR free GUID lookup — assist Ops only, never auto-approve (G0-2).
 * https://abr.business.gov.au/Tools/WebServices
 */
@Injectable()
export class AbrService {
  private readonly logger = new Logger(AbrService.name);

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  async lookupAbn(abn: string): Promise<AbrLookupResult> {
    const cleaned = abn.replace(/\s/g, '');
    const guid = this.config.get('ABR_GUID', { infer: true });

    if (!guid) {
      return {
        configured: false,
        abn: cleaned,
        active: null,
        entityName: null,
        abnStatus: null,
        message: 'ABR_GUID not configured — Ops may verify ABN manually',
      };
    }

    try {
      const url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(cleaned)}&guid=${encodeURIComponent(guid)}&callback=callback`;
      const response = await fetch(url);
      const text = await response.text();
      const jsonText = text.replace(/^callback\(/, '').replace(/\);?\s*$/, '');
      const data = JSON.parse(jsonText) as {
        Abn?: string;
        EntityName?: string;
        AbnStatus?: string;
        Message?: string;
      };

      const status = data.AbnStatus ?? null;
      const active = status ? status.toLowerCase() === 'active' : null;

      return {
        configured: true,
        abn: cleaned,
        active,
        entityName: data.EntityName ?? null,
        abnStatus: status,
        message: data.Message ?? (active ? 'ABN appears active (assist only)' : 'See AbnStatus'),
        raw: data,
      };
    } catch (error) {
      this.logger.warn(
        `ABR lookup failed for ${cleaned}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        configured: true,
        abn: cleaned,
        active: null,
        entityName: null,
        abnStatus: null,
        message: 'ABR lookup failed — verify manually',
      };
    }
  }
}

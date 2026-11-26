import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushPlatform } from '@prisma/client';
import { createSign, randomUUID } from 'node:crypto';
import type { AppEnv } from '../../config/env.validation';
import type {
  PushProvider,
  PushSendRequest,
  PushSendResult,
} from './push.types';

type FirebaseServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

type CachedAccessToken = {
  token: string;
  expiresAtMs: number;
};

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseServiceAccountFromEnv(
  config: ConfigService<AppEnv, true>,
): FirebaseServiceAccount | null {
  const rawJson = config.get('FIREBASE_SERVICE_ACCOUNT_JSON', { infer: true });
  if (rawJson?.trim()) {
    try {
      const decoded = rawJson.trim().startsWith('{')
        ? rawJson.trim()
        : Buffer.from(rawJson.trim(), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key.replace(/\\n/g, '\n'),
        };
      }
    } catch {
      return null;
    }
  }

  const projectId = config.get('FIREBASE_PROJECT_ID', { infer: true });
  const clientEmail = config.get('FIREBASE_CLIENT_EMAIL', { infer: true });
  const privateKey = config.get('FIREBASE_PRIVATE_KEY', { infer: true });
  if (projectId && clientEmail && privateKey) {
    return {
      projectId: projectId.trim(),
      clientEmail: clientEmail.trim(),
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

/**
 * Firebase Cloud Messaging HTTP v1 provider using Node built-in RSA-SHA256 JWT + fetch.
 * Automatically falls back to mock mode when PUSH_MOCK=true or Firebase credentials are unset.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly account: FirebaseServiceAccount | null;
  private readonly forceMock: boolean;
  private cachedToken: CachedAccessToken | null = null;

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    this.forceMock = Boolean(this.config.get('PUSH_MOCK', { infer: true }));
    this.account = parseServiceAccountFromEnv(this.config);
  }

  get mode(): 'fcm' | 'mock' {
    if (this.forceMock || !this.account) {
      return 'mock';
    }
    return 'fcm';
  }

  private createSignedJwt(account: FirebaseServiceAccount, nowSec: number): string {
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64UrlEncode(
      JSON.stringify({
        iss: account.clientEmail,
        scope: FCM_SCOPE,
        aud: GOOGLE_TOKEN_URI,
        iat: nowSec,
        exp: nowSec + 3600,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = base64UrlEncode(signer.sign(account.privateKey));
    return `${signingInput}.${signature}`;
  }

  private async getAccessToken(account: FirebaseServiceAccount): Promise<string> {
    const nowMs = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - 60_000 > nowMs) {
      return this.cachedToken.token;
    }

    const assertion = this.createSignedJwt(account, Math.floor(nowMs / 1000));
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await fetch(GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OAuth token exchange failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error('OAuth token response missing access_token');
    }

    const ttlSec = Math.max(60, Number(data.expires_in ?? 3600));
    this.cachedToken = {
      token: data.access_token,
      expiresAtMs: nowMs + ttlSec * 1000,
    };
    return data.access_token;
  }

  private buildFcmMessage(request: PushSendRequest): Record<string, unknown> {
    const { payload, token, platform } = request;
    const message: Record<string, unknown> = {
      token,
      notification: {
        title: payload.title,
        ...(payload.body ? { body: payload.body } : {}),
      },
      data: payload.data,
    };

    if (platform === PushPlatform.ANDROID) {
      message.android = {
        priority: payload.priority === 'high' ? 'HIGH' : 'NORMAL',
        ...(payload.collapseKey ? { collapse_key: payload.collapseKey } : {}),
        notification: {
          channel_id: payload.channelId,
          sound: 'default',
        },
      };
    } else if (platform === PushPlatform.IOS) {
      message.apns = {
        headers: {
          'apns-priority': payload.priority === 'high' ? '10' : '5',
          ...(payload.collapseKey ? { 'apns-collapse-id': payload.collapseKey } : {}),
        },
        payload: {
          aps: {
            sound: 'default',
            badge: Math.max(0, payload.badge),
            'interruption-level': payload.isCritical ? 'time-sensitive' : 'active',
          },
        },
      };
    } else if (platform === PushPlatform.WEB) {
      message.webpush = {
        headers: {
          Urgency: payload.priority === 'high' ? 'high' : 'normal',
        },
      };
    }

    return { message };
  }

  async send(request: PushSendRequest): Promise<PushSendResult> {
    if (this.mode === 'mock' || !this.account) {
      const mockId = `mock-fcm-${randomUUID()}`;
      this.logger.debug(
        `[PUSH MOCK] platform=${request.platform} channel=${request.payload.channelId} type=${request.payload.data.type ?? 'unknown'} title="${request.payload.title}"`,
      );
      return { ok: true, messageId: mockId, mode: 'mock' };
    }

    try {
      const accessToken = await this.getAccessToken(this.account);
      const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildFcmMessage(request)),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        const okJson = (await response.json()) as { name?: string };
        return {
          ok: true,
          messageId: okJson.name ?? `fcm-${randomUUID()}`,
          mode: 'fcm',
        };
      }

      const rawErr = await response.text().catch(() => '');
      const upperErr = rawErr.toUpperCase();

      if (
        response.status === 404 ||
        upperErr.includes('UNREGISTERED') ||
        upperErr.includes('REGISTRATION-TOKEN-NOT-REGISTERED')
      ) {
        return {
          ok: false,
          errorCode: 'UNREGISTERED',
          errorMessage: `FCM token unregistered (${response.status})`,
          shouldDeactivateDevice: true,
          retryable: false,
        };
      }

      if (
        response.status === 400 &&
        (upperErr.includes('INVALID_ARGUMENT') || upperErr.includes('INVALID REGISTRATION'))
      ) {
        return {
          ok: false,
          errorCode: 'INVALID_TOKEN',
          errorMessage: `FCM invalid token (${response.status})`,
          shouldDeactivateDevice: true,
          retryable: false,
        };
      }

      if (response.status === 401 || response.status === 403) {
        // Clear cached token so next attempt mints a fresh one.
        this.cachedToken = null;
      }

      return {
        ok: false,
        errorCode: 'TRANSIENT',
        errorMessage: `FCM HTTP ${response.status}: ${rawErr.slice(0, 200)}`,
        shouldDeactivateDevice: false,
        retryable: response.status >= 500 || response.status === 429 || response.status === 401,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        errorCode: 'TRANSIENT',
        errorMessage: error instanceof Error ? error.message : String(error),
        shouldDeactivateDevice: false,
        retryable: true,
      };
    }
  }
}

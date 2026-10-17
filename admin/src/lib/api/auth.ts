import type { AuthTokens, OtpRequestInput, OtpVerifyInput } from '@/shared/types';
import { createHttpClient, toApiError } from '@/lib/http/client';
import { http } from '@/lib/http';
import type { IdentityMe } from '@/lib/api/identity.types';

export type { IdentityMe } from '@/lib/api/identity.types';

export { applyAuthTokensToStore } from '@/lib/auth-session';

const publicHttp = createHttpClient();
publicHttp.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(toApiError(error)),
);

export function requestOtp(payload: OtpRequestInput, options?: { signal?: AbortSignal }) {
  return publicHttp
    .post<{ ok: boolean; message: string; debugCode?: string }>(
      '/auth/otp/request',
      payload,
      {
        signal: options?.signal,
        timeout: 60_000,
      },
    )
    .then((res) => res.data);
}

export function verifyOtp(payload: OtpVerifyInput, options?: { signal?: AbortSignal }) {
  return publicHttp
    .post<AuthTokens>('/auth/otp/verify', payload, {
      signal: options?.signal,
    })
    .then((res) => res.data);
}

export function refreshSession(refreshToken: string, options?: { signal?: AbortSignal }) {
  return publicHttp
    .post<AuthTokens>('/auth/refresh', { refreshToken }, { signal: options?.signal })
    .then((res) => res.data);
}

export function logout(payload?: { refreshToken?: string; allDevices?: boolean }) {
  return http
    .post<{ ok: boolean }>('/auth/logout', payload ?? { allDevices: true })
    .then((r) => r.data);
}

export function listSessions() {
  return http
    .get<{
      data: Array<{
        id: string;
        deviceLabel: string | null;
        userAgent: string | null;
        createdAt: string;
        lastUsedAt: string;
        expiresAt: string;
        isCurrent: boolean;
      }>;
    }>('/auth/sessions')
    .then((r) => r.data);
}

export function revokeSession(id: string) {
  return http.delete<{ ok: boolean }>(`/auth/sessions/${id}`).then((r) => r.data);
}

export function getIdentityMe() {
  return http.get<IdentityMe>('/identity/me').then((r) => r.data);
}

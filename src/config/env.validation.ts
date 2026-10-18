import { z } from 'zod';

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value;
    }
    return ['true', '1', 'yes'].includes(value.toLowerCase());
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('v1'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  /** Admin/verification UI base URL for driver invite links. */
  ADMIN_APP_URL: z.string().url().default('http://localhost:5174'),
  /** Driver invite token TTL hours. */
  DRIVER_INVITE_TTL_HOURS: z.coerce.number().int().positive().default(168),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromString.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  NOTIFY_EMAIL: z.string().email().optional(),
  INVEST_NOTIFY_EMAIL: z.string().email().optional(),
  ENABLE_OPENAPI: booleanFromString.default(false),
  /** TEMP testing: include OTP in API response and show on admin login. Turn off for real use. */
  EXPOSE_OTP_IN_RESPONSE: booleanFromString.default(false),
  SEED_SUPER_ADMIN_EMAIL: z.string().email().default('cloxadmin@yopmail.com'),
  SEED_SUPER_ADMIN_NAME: z.string().default('CLOX Super Admin'),
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Local filesystem root for Phase 1 doc uploads (no S3 required yet). */
  STORAGE_LOCAL_DIR: z.string().default('.data/uploads'),
  /** Optional free ABR GUID — assist Ops only, never auto-approve. */
  ABR_GUID: z.string().optional(),
  /** Expiry watchdog interval ms (default 1h). Set 0 to disable. */
  COMPLIANCE_WATCHDOG_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  /** Stripe secret — optional in local; when missing, payment uses mock mode. */
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Force mock Stripe even if key present (local QA). */
  STRIPE_MOCK: booleanFromString.default(false),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** Webhook signing secret (whsec_…) — required for live/test webhook verify when not mock. */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** M9 geofence radius meters (default 200). */
  GEOFENCE_RADIUS_METERS: z.coerce.number().positive().default(200),
  /** M9 DEV: override free-wait to N seconds for demo (0 = use policy minutes). */
  GEOFENCE_FREE_WAIT_SECONDS: z.coerce.number().int().nonnegative().default(30),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

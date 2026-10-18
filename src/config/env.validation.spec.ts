import { validateEnv } from './env.validation';

describe('validateEnv (M0-3)', () => {
  const base = {
    DATABASE_URL: 'postgresql://clox:clox@localhost:5432/clox_prelaunch',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_REFRESH_SECRET: 'y'.repeat(32),
  };

  it('accepts valid minimal config', () => {
    const env = validateEnv(base);
    expect(env.DATABASE_URL).toContain('postgresql');
    expect(env.EXPOSE_OTP_IN_RESPONSE).toBe(false);
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: '' })).toThrow(/Invalid environment/);
  });

  it('rejects short JWT secrets', () => {
    expect(() =>
      validateEnv({ ...base, JWT_ACCESS_SECRET: 'too-short' }),
    ).toThrow(/Invalid environment/);
  });

  it('parses STRIPE_MOCK string true', () => {
    const env = validateEnv({ ...base, STRIPE_MOCK: 'true' });
    expect(env.STRIPE_MOCK).toBe(true);
  });
});

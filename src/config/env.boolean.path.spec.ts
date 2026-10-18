import { validateEnv } from './env.validation';

describe('env booleanFromString leftover', () => {
  const base = {
    DATABASE_URL: 'postgresql://clox:clox@localhost:5432/clox_prelaunch',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_REFRESH_SECRET: 'y'.repeat(32),
  };

  it('accepts native boolean for STRIPE_MOCK / ENABLE_OPENAPI', () => {
    const env = validateEnv({
      ...base,
      STRIPE_MOCK: true,
      ENABLE_OPENAPI: false,
      EXPOSE_OTP_IN_RESPONSE: true,
    });
    expect(env.STRIPE_MOCK).toBe(true);
    expect(env.ENABLE_OPENAPI).toBe(false);
    expect(env.EXPOSE_OTP_IN_RESPONSE).toBe(true);
  });
});

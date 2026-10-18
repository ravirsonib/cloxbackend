import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';

describe('AppModule Throttler useFactory leftover', () => {
  it('invokes ThrottlerModule forRootAsync useFactory from providers', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<{
      module?: { name?: string };
      providers?: Array<{ useFactory?: (config: { get: (key: string, fallback?: number) => number }) => unknown }>;
    }>;

    const throttleDyn = imports.find((entry) => entry?.module?.name === 'ThrottlerModule');
    expect(throttleDyn).toBeDefined();

    const factoryProvider = throttleDyn!.providers?.find(
      (p) => typeof p?.useFactory === 'function',
    );
    expect(factoryProvider?.useFactory).toBeDefined();

    const result = factoryProvider!.useFactory!({
      get: (key: string, fallback?: number) => {
        if (key === 'THROTTLE_TTL_MS') return 30_000;
        if (key === 'THROTTLE_LIMIT') return 5;
        return fallback ?? 0;
      },
    });
    expect(result).toEqual([{ ttl: 30_000, limit: 5 }]);
  });
});

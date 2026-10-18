const listen = jest.fn().mockResolvedValue(undefined);
const useLogger = jest.fn();
const setGlobalPrefix = jest.fn();
const useGlobalPipes = jest.fn();
const useGlobalFilters = jest.fn();
const enableCors = jest.fn();
const log = jest.fn();
const createDocument = jest.fn().mockReturnValue({});
const setup = jest.fn();

const configGet = jest.fn((key: string) => {
  const map: Record<string, unknown> = {
    API_PREFIX: 'v1',
    CORS_ORIGINS: 'http://localhost:5173, http://localhost:5174',
    NODE_ENV: 'test',
    ENABLE_OPENAPI: true,
    PORT: 3999,
  };
  return map[key];
});

const mockApp = {
  get: jest
    .fn()
    .mockReturnValueOnce({ get: configGet })
    .mockReturnValueOnce({ log }),
  useLogger,
  setGlobalPrefix,
  useGlobalPipes,
  useGlobalFilters,
  enableCors,
  listen,
};

jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn().mockResolvedValue(mockApp),
  },
}));

jest.mock('@nestjs/swagger', () => {
  const chain = () => {
    const api: Record<string, jest.Mock> = {};
    const self = new Proxy(api, {
      get: (_t, prop: string) => {
        if (prop === 'build') return jest.fn().mockReturnValue({});
        if (!api[prop]) api[prop] = jest.fn().mockReturnValue(self);
        return api[prop];
      },
    });
    return self;
  };
  return {
    DocumentBuilder: jest.fn().mockImplementation(() => chain()),
    SwaggerModule: {
      createDocument,
      setup,
    },
  };
});

jest.mock('./app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('nestjs-pino', () => ({ Logger: class Logger {} }));
jest.mock('./common/filters/problem-details.filter', () => ({
  ProblemDetailsFilter: class ProblemDetailsFilter {},
}));

async function waitForListen(port: number) {
  for (let i = 0; i < 20; i += 1) {
    if (listen.mock.calls.some((c) => c[0] === port)) break;
    await new Promise((r) => setImmediate(r));
  }
}

describe('main bootstrap leftover', () => {
  it(
    'boots Nest app with OpenAPI and listens',
    async () => {
      await import('./main');
      await waitForListen(3999);
      expect(setGlobalPrefix).toHaveBeenCalledWith('v1');
      expect(enableCors).toHaveBeenCalled();
      expect(listen).toHaveBeenCalledWith(3999);
      expect(createDocument).toHaveBeenCalled();
      expect(setup).toHaveBeenCalled();
    },
    15_000,
  );

  it(
    'skips OpenAPI when production and ENABLE_OPENAPI false',
    async () => {
      jest.resetModules();
      createDocument.mockClear();
      setup.mockClear();
      listen.mockClear();
      configGet.mockImplementation((key: string) => {
        const map: Record<string, unknown> = {
          API_PREFIX: 'v1',
          CORS_ORIGINS: 'http://localhost:5173',
          NODE_ENV: 'production',
          ENABLE_OPENAPI: false,
          PORT: 4001,
        };
        return map[key];
      });
      mockApp.get
        .mockReset()
        .mockReturnValueOnce({ get: configGet })
        .mockReturnValueOnce({ log });

      await import('./main');
      await waitForListen(4001);
      expect(listen).toHaveBeenCalledWith(4001);
      expect(createDocument).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
    },
    15_000,
  );
});

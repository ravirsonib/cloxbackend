import { PrismaService } from './prisma.service';

type PrismaHarness = {
  connected: boolean;
  $connect: jest.Mock;
  $disconnect: jest.Mock;
  logger: { warn: jest.Mock };
  isConnected: () => boolean;
  onModuleInit: () => Promise<void>;
  onModuleDestroy: () => Promise<void>;
};

function harness(): PrismaHarness {
  const proto = PrismaService.prototype as unknown as {
    isConnected: () => boolean;
    onModuleInit: () => Promise<void>;
    onModuleDestroy: () => Promise<void>;
  };
  return {
    connected: false,
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    logger: { warn: jest.fn() },
    isConnected: proto.isConnected,
    onModuleInit: proto.onModuleInit,
    onModuleDestroy: proto.onModuleDestroy,
  };
}

describe('PrismaService lifecycle leftovers', () => {
  it('onModuleInit sets connected true when $connect succeeds', async () => {
    const service = harness();
    service.$connect.mockResolvedValue(undefined);

    await service.onModuleInit.call(service);
    expect(service.connected).toBe(true);
    expect(service.isConnected.call(service)).toBe(true);
  });

  it('onModuleInit stays disconnected and warns on failure', async () => {
    const service = harness();
    service.$connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.onModuleInit.call(service);
    expect(service.connected).toBe(false);
    expect(service.isConnected.call(service)).toBe(false);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it('onModuleInit stringifies non-Error connect failures', async () => {
    const service = harness();
    service.$connect.mockRejectedValue('postgres offline');

    await service.onModuleInit.call(service);
    expect(service.connected).toBe(false);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('postgres offline'),
    );
  });

  it('onModuleDestroy disconnects only when connected', async () => {
    const service = harness();
    service.connected = true;
    service.$disconnect.mockResolvedValue(undefined);

    await service.onModuleDestroy.call(service);
    expect(service.$disconnect).toHaveBeenCalled();

    service.connected = false;
    service.$disconnect.mockClear();
    await service.onModuleDestroy.call(service);
    expect(service.$disconnect).not.toHaveBeenCalled();
  });
});

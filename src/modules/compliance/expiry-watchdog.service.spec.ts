import { ExpiryWatchdogService } from './expiry-watchdog.service';

describe('ExpiryWatchdogService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('disables when COMPLIANCE_WATCHDOG_MS is 0', () => {
    const compliance = { runExpiryWatchdog: jest.fn() };
    const drivers = { suspendExpiredLicences: jest.fn() };
    const service = new ExpiryWatchdogService(
      compliance as never,
      drivers as never,
      { get: () => 0 } as never,
    );
    service.onModuleInit();
    expect(compliance.runExpiryWatchdog).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('ticks immediately and on interval; clears on destroy', async () => {
    const compliance = {
      runExpiryWatchdog: jest.fn().mockResolvedValue({
        expired: 1,
        suspendedVehicles: 0,
        suspendedCompanies: 0,
      }),
    };
    const drivers = {
      suspendExpiredLicences: jest.fn().mockResolvedValue({ suspended: 2 }),
    };
    const service = new ExpiryWatchdogService(
      compliance as never,
      drivers as never,
      { get: () => 60_000 } as never,
    );
    service.onModuleInit();
    await Promise.resolve();
    expect(compliance.runExpiryWatchdog).toHaveBeenCalledTimes(1);
    expect(drivers.suspendExpiredLicences).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(compliance.runExpiryWatchdog).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(compliance.runExpiryWatchdog).toHaveBeenCalledTimes(2);
  });

  it('swallows tick errors without throwing', async () => {
    const compliance = {
      runExpiryWatchdog: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const drivers = { suspendExpiredLicences: jest.fn() };
    const service = new ExpiryWatchdogService(
      compliance as never,
      drivers as never,
      { get: () => 30_000 } as never,
    );
    service.onModuleInit();
    await Promise.resolve();
    expect(drivers.suspendExpiredLicences).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('quiet tick when nothing expired; stringifies non-Error catch', async () => {
    const compliance = {
      runExpiryWatchdog: jest.fn().mockResolvedValue({
        expired: 0,
        suspendedVehicles: 0,
        suspendedCompanies: 0,
      }),
    };
    const drivers = {
      suspendExpiredLicences: jest.fn().mockResolvedValue({ suspended: 0 }),
    };
    const quiet = new ExpiryWatchdogService(
      compliance as never,
      drivers as never,
      { get: () => 30_000 } as never,
    );
    quiet.onModuleInit();
    await Promise.resolve();
    expect(compliance.runExpiryWatchdog).toHaveBeenCalled();
    quiet.onModuleDestroy();

    const complianceFail = {
      runExpiryWatchdog: jest.fn().mockRejectedValue('db string fail'),
    };
    const failing = new ExpiryWatchdogService(
      complianceFail as never,
      drivers as never,
      { get: () => 30_000 } as never,
    );
    failing.onModuleInit();
    await Promise.resolve();
    failing.onModuleDestroy();
  });
});

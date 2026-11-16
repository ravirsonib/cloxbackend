import { FleetPlusStatus } from '@prisma/client';
import { FleetPlusService } from './fleet-plus.service';

describe('FleetPlusService billing kill-switch', () => {
  function makeService(billingEnabled: boolean) {
    const config = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'FLEET_PLUS_BILLING_ENABLED') return billingEnabled;
        return undefined;
      }),
    };
    return new FleetPlusService({} as never, {} as never, config as never);
  }

  it('isBillingEnabled reflects env', () => {
    expect(makeService(false).isBillingEnabled()).toBe(false);
    expect(makeService(true).isBillingEnabled()).toBe(true);
  });

  it('isEntitled is always true when billing is off', () => {
    const service = makeService(false);
    expect(service.isEntitled(FleetPlusStatus.NONE, null)).toBe(true);
    expect(service.isEntitled(FleetPlusStatus.CANCELED, null)).toBe(true);
  });

  it('isEntitled enforces trial/active when billing is on', () => {
    const service = makeService(true);
    expect(service.isEntitled(FleetPlusStatus.NONE, null)).toBe(false);
    expect(service.isEntitled(FleetPlusStatus.ACTIVE, null)).toBe(true);
    expect(
      service.isEntitled(FleetPlusStatus.TRIALING, new Date(Date.now() + 86_400_000)),
    ).toBe(true);
    expect(
      service.isEntitled(FleetPlusStatus.TRIALING, new Date(Date.now() - 86_400_000)),
    ).toBe(false);
  });
});

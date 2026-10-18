import { MODULE_METADATA } from '@nestjs/common/constants';
import { CarrierModule } from './carrier/carrier.module';
import { MatchingModule } from './matching/matching.module';
import { PaymentsModule } from './payments/payments.module';
import { TripsModule } from './trips/trips.module';

function invokeForwardRefs(moduleClass: new (...args: never[]) => unknown) {
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) as unknown[];
  for (const entry of imports ?? []) {
    if (entry && typeof entry === 'function' && 'forwardRef' in Function.prototype === false) {
      // Nest forwardRef returns an object with forwardRef: () => Type
    }
    if (
      entry &&
      typeof entry === 'object' &&
      entry !== null &&
      'forwardRef' in entry &&
      typeof (entry as { forwardRef: unknown }).forwardRef === 'function'
    ) {
      const resolved = (entry as { forwardRef: () => unknown }).forwardRef();
      expect(resolved).toBeTruthy();
    }
  }
}

describe('Nest module forwardRef leftovers', () => {
  it('resolves MatchingModule → CarrierModule forwardRef', () => {
    invokeForwardRefs(MatchingModule);
  });

  it('resolves PaymentsModule → TripsModule forwardRef', () => {
    invokeForwardRefs(PaymentsModule);
  });

  it('resolves TripsModule → PaymentsModule forwardRef', () => {
    invokeForwardRefs(TripsModule);
  });

  it('resolves CarrierModule forwardRefs', () => {
    invokeForwardRefs(CarrierModule);
  });
});

import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TripsService } from '../trips/trips.service';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

describe('PaymentsService constructor leftover', () => {
  it('constructs via Nest TestingModule (covers Inject forwardRef)', async () => {
    const deps =
      (Reflect.getMetadata('self:paramtypes', PaymentsService) as Array<{
        index: number;
        param: { forwardRef?: () => unknown };
      }>) ?? [];
    for (const dep of deps) {
      if (typeof dep.param?.forwardRef === 'function') {
        expect(dep.param.forwardRef()).toBe(TripsService);
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: { isConnected: () => false } },
        { provide: AuditService, useValue: { recordPlatform: jest.fn() } },
        { provide: StripeService, useValue: { isMockMode: () => true } },
        { provide: TripsService, useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(PaymentsService);
    expect(service).toBeInstanceOf(PaymentsService);
  });
});

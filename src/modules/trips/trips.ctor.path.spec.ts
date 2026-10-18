import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { TripsService } from './trips.service';

describe('TripsService constructor leftover', () => {
  it('constructs via Nest TestingModule (covers Inject forwardRef)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: PrismaService, useValue: { isConnected: () => false } },
        { provide: AuditService, useValue: { recordPlatform: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PaymentsService, useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(TripsService);
    expect(service).toBeInstanceOf(TripsService);
  });
});

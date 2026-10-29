import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
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
        {
          provide: NotificationsService,
          useValue: {
            notifyTripApproaching: jest.fn(),
            notifyTripAtDropoff: jest.fn(),
            notifyPodFinalized: jest.fn(),
          },
        },
        {
          provide: InAppNotificationsService,
          useValue: {
            notifyUsers: jest.fn(),
            userIdsForCompanies: jest.fn().mockResolvedValue([]),
            userIdForDriver: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(TripsService);
    expect(service).toBeInstanceOf(TripsService);
  });
});

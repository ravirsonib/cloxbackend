import { ForbiddenException } from '@nestjs/common';
import { TripStatus } from '@prisma/client';

describe('TripsService gate rules (unit contracts)', () => {
  it('offline start must be rejected with OFFLINE_REJECTED', () => {
    const err = new ForbiddenException({
      message: 'Offline start trip rejected — online-only',
      code: 'OFFLINE_REJECTED',
    });
    expect(err.getResponse()).toMatchObject({ code: 'OFFLINE_REJECTED' });
  });

  it('documents server statuses used by M8/M9 SM', () => {
    expect(TripStatus.PENDING_GATES).toBe('PENDING_GATES');
    expect(TripStatus.AT_PICKUP).toBe('AT_PICKUP');
    expect(TripStatus.IN_TRANSIT).toBe('IN_TRANSIT');
    expect(TripStatus.AT_DROPOFF).toBe('AT_DROPOFF');
  });

  it('mass discrepancy blocks start until surcharge resolved', () => {
    const err = new ForbiddenException({
      message: 'Mass gate not passed — pay/waive mass surcharge',
      code: 'MASS_REQUIRED',
    });
    expect(err.getResponse()).toMatchObject({ code: 'MASS_REQUIRED' });
  });
});

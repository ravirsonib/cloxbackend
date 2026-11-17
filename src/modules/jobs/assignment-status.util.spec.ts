import {
  AssignmentStatus,
  PaymentEventStatus,
  PaymentEventType,
} from '@prisma/client';
import {
  isAssignmentPaidAndConfirmed,
  isAssignmentPendingPayment,
  pickPrimaryFarePaymentEvent,
} from './assignment-status.util';

describe('assignment-status.util', () => {
  it('treats LOCKED and COMPLETED as paid/confirmed', () => {
    expect(isAssignmentPaidAndConfirmed(AssignmentStatus.LOCKED)).toBe(true);
    expect(isAssignmentPaidAndConfirmed(AssignmentStatus.COMPLETED)).toBe(true);
    expect(isAssignmentPaidAndConfirmed(AssignmentStatus.PENDING)).toBe(false);
    expect(isAssignmentPaidAndConfirmed(AssignmentStatus.CANCELLED)).toBe(false);
    expect(isAssignmentPaidAndConfirmed(null)).toBe(false);
  });

  it('treats only PENDING as pending payment', () => {
    expect(isAssignmentPendingPayment(AssignmentStatus.PENDING)).toBe(true);
    expect(isAssignmentPendingPayment(AssignmentStatus.LOCKED)).toBe(false);
    expect(isAssignmentPendingPayment(AssignmentStatus.COMPLETED)).toBe(false);
  });

  describe('pickPrimaryFarePaymentEvent', () => {
    it('prefers SUCCEEDED CHARGE over newer TRANSFER/SURCHARGE', () => {
      const picked = pickPrimaryFarePaymentEvent([
        { type: PaymentEventType.TRANSFER, status: PaymentEventStatus.SUCCEEDED, id: 'tr' },
        { type: PaymentEventType.SURCHARGE, status: PaymentEventStatus.PENDING, id: 'sc' },
        { type: PaymentEventType.CHARGE, status: PaymentEventStatus.SUCCEEDED, id: 'ch' },
      ]);
      expect(picked?.id).toBe('ch');
    });

    it('falls back to latest CHARGE when none succeeded', () => {
      const picked = pickPrimaryFarePaymentEvent([
        { type: PaymentEventType.CHARGE, status: PaymentEventStatus.PENDING, id: 'pending' },
        { type: PaymentEventType.CHARGE, status: PaymentEventStatus.FAILED, id: 'failed' },
      ]);
      expect(picked?.id).toBe('pending');
    });

    it('returns null when there is no CHARGE', () => {
      expect(
        pickPrimaryFarePaymentEvent([
          { type: PaymentEventType.TRANSFER, status: PaymentEventStatus.SUCCEEDED, id: 'tr' },
        ]),
      ).toBeNull();
      expect(pickPrimaryFarePaymentEvent([])).toBeNull();
      expect(pickPrimaryFarePaymentEvent(null)).toBeNull();
    });
  });
});

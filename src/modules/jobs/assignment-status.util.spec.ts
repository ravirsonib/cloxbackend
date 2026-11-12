import { AssignmentStatus } from '@prisma/client';
import {
  isAssignmentPaidAndConfirmed,
  isAssignmentPendingPayment,
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
});

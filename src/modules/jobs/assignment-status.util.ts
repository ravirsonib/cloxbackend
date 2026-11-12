import { AssignmentStatus } from '@prisma/client';

/**
 * Bid accept creates PENDING; successful charge locks to LOCKED; trip finish → COMPLETED.
 * "Paid and confirmed" must stay true after lock — including COMPLETED — or sender UI
 * incorrectly shows "pending payment" / Complete payment CTAs on finished jobs.
 */
export function isAssignmentPaidAndConfirmed(
  status: AssignmentStatus | null | undefined,
): boolean {
  return (
    status === AssignmentStatus.LOCKED ||
    status === AssignmentStatus.COMPLETED
  );
}

/** Assignment still awaiting card payment after bid accept. */
export function isAssignmentPendingPayment(
  status: AssignmentStatus | null | undefined,
): boolean {
  return status === AssignmentStatus.PENDING;
}

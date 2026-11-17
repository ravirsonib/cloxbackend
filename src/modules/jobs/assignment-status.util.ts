import {
  AssignmentStatus,
  PaymentEventStatus,
  PaymentEventType,
} from '@prisma/client';

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

type PaymentEventLike = {
  type: PaymentEventType;
  status: PaymentEventStatus;
};

/**
 * Sender job "payment" line must reflect the fare CHARGE — not a later TRANSFER /
 * SURCHARGE row (those are newer and often lack a PaymentIntent id, which made
 * completed jobs look like "Payment PENDING · —").
 *
 * Prefer SUCCEEDED CHARGE; otherwise the latest CHARGE (events should be newest-first).
 */
export function pickPrimaryFarePaymentEvent<T extends PaymentEventLike>(
  events: readonly T[] | null | undefined,
): T | null {
  if (!events?.length) return null;
  const charges = events.filter((e) => e.type === PaymentEventType.CHARGE);
  if (!charges.length) return null;
  return (
    charges.find((e) => e.status === PaymentEventStatus.SUCCEEDED) ?? charges[0] ?? null
  );
}

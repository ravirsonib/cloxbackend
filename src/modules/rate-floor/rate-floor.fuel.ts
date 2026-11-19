/** Monday of the ISO-ish week containing `date`, as UTC date-only (midnight). */
export function mondayOfWeek(date: Date = new Date()): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

export function formatWeekStartIso(weekStart: Date): string {
  return weekStart.toISOString().slice(0, 10);
}

/** Absolute percent change of `next` vs `prev`. Returns 0 if prev is ~0. */
export function percentChange(prev: number, next: number): number {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || Math.abs(prev) < 1e-9) return 0;
  return (Math.abs(next - prev) / Math.abs(prev)) * 100;
}

/**
 * Cap week-over-week diesel move for floor calc.
 * Returns the diesel cpl to apply and whether a cap was used.
 */
export function applyWeeklyDieselCap(
  previousDieselCpl: number | null | undefined,
  latestDieselCpl: number,
  capPercent: number,
): { appliedDieselCpl: number; weeklyMoveCapped: boolean; uncappedMovePercent: number } {
  if (previousDieselCpl == null || !Number.isFinite(previousDieselCpl) || capPercent <= 0) {
    return {
      appliedDieselCpl: latestDieselCpl,
      weeklyMoveCapped: false,
      uncappedMovePercent: 0,
    };
  }
  const movePct = percentChange(previousDieselCpl, latestDieselCpl);
  if (movePct <= capPercent + 1e-9) {
    return {
      appliedDieselCpl: latestDieselCpl,
      weeklyMoveCapped: false,
      uncappedMovePercent: movePct,
    };
  }
  const direction = latestDieselCpl >= previousDieselCpl ? 1 : -1;
  const capped = previousDieselCpl * (1 + (direction * capPercent) / 100);
  return {
    appliedDieselCpl: capped,
    weeklyMoveCapped: true,
    uncappedMovePercent: movePct,
  };
}

export function ageDaysFromWeekStart(weekStart: Date, now: Date = new Date()): number {
  const ms = now.getTime() - weekStart.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

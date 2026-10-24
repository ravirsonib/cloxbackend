/**
 * Milestone driver journey for POD package — not raw GPS samples.
 */

export type PodJourneyEvent = {
  at: Date;
  event: string;
  detail: string;
};

export type PodJourneyInput = {
  trip: {
    startedAt: Date | null;
    safetyPassedAt?: Date | null;
    massCheckedAt?: Date | null;
    breakStartedAt: Date | null;
    onBreak?: boolean;
    completedAt: Date | null;
  };
  /** Progress rows for this trip (all stops). */
  stopProgress: Array<{
    stopType?: string | null;
    stopLabel?: string | null;
    suburb?: string | null;
    enteredAt: Date | null;
    exitedAt: Date | null;
    approachingNotifiedAt: Date | null;
    approachingSource?: string | null;
    atDropoffNotifiedAt: Date | null;
    signedAt: Date | null;
    signerName?: string | null;
    podFinalizedAt: Date | null;
  }>;
  exceptions?: Array<{
    kind: string;
    status: string;
    openedAt: Date;
    resolvedAt?: Date | null;
    note?: string | null;
    reasonCode?: string | null;
  }>;
  /** Optional audit rows (break toggles, etc.) */
  auditEvents?: Array<{
    action: string;
    createdAt: Date;
    metadata?: Record<string, unknown> | null;
  }>;
  /** When finalize is running, inject finalize time if not yet on progress. */
  finalizeAt?: Date | null;
};

function push(
  out: PodJourneyEvent[],
  at: Date | null | undefined,
  event: string,
  detail: string,
) {
  if (!at) return;
  out.push({ at, event, detail });
}

function stopName(p: PodJourneyInput['stopProgress'][number]): string {
  return p.stopLabel || p.suburb || p.stopType || 'stop';
}

/**
 * Build chronological milestone list for POD PDF / email package.
 */
export function buildPodJourney(input: PodJourneyInput): PodJourneyEvent[] {
  const events: PodJourneyEvent[] = [];
  const { trip } = input;

  push(
    events,
    trip.safetyPassedAt,
    'Safety passed',
    'Pre-trip safety gate cleared',
  );
  push(
    events,
    trip.massCheckedAt,
    'Mass checked',
    'Declared vs actual mass gate cleared',
  );
  push(events, trip.startedAt, 'Trip started', 'Driver started the trip');

  for (const p of input.stopProgress) {
    const name = stopName(p);
    push(events, p.enteredAt, 'Geofence enter', name);
    push(events, p.exitedAt, 'Geofence exit', name);
    if (p.approachingNotifiedAt) {
      const src = p.approachingSource ? ` | source ${p.approachingSource}` : '';
      push(events, p.approachingNotifiedAt, 'Approaching', `${name}${src}`);
    }
    push(events, p.atDropoffNotifiedAt, 'At dropoff', `${name} | notify sent`);
    if (p.signedAt) {
      push(
        events,
        p.signedAt,
        'POD signed',
        p.signerName ? `${p.signerName} on SOG` : 'Receiver signed on SOG',
      );
    }
    push(events, p.podFinalizedAt, 'POD finalized', 'Package generated');
  }

  for (const ex of input.exceptions ?? []) {
    const note = [ex.reasonCode, ex.note].filter(Boolean).join(' - ') || ex.status;
    push(events, ex.openedAt, `Exception | ${ex.kind}`, note);
    push(events, ex.resolvedAt ?? null, `Exception resolved | ${ex.kind}`, ex.status);
  }

  for (const a of input.auditEvents ?? []) {
    if (a.action === 'trip.break_toggled') {
      const onBreak = Boolean(a.metadata && (a.metadata as { onBreak?: boolean }).onBreak);
      push(
        events,
        a.createdAt,
        onBreak ? 'Break started' : 'Break ended',
        onBreak ? 'Sender ETA paused' : 'Resume tracking',
      );
    }
  }

  // Fallback break marker from trip scalar when no audit rows.
  const hasBreakAudit = (input.auditEvents ?? []).some(
    (a) => a.action === 'trip.break_toggled',
  );
  if (!hasBreakAudit && trip.breakStartedAt) {
    push(events, trip.breakStartedAt, 'Break started', 'Sender ETA paused');
  }

  if (input.finalizeAt) {
    const already = events.some((e) => e.event === 'POD finalized');
    if (!already) {
      push(events, input.finalizeAt, 'POD finalized', 'Package generated');
    }
  }

  push(events, trip.completedAt, 'Trip completed', 'All dropoffs finalized');

  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return events;
}

/** Melbourne local display matching POD HTML mock (label Time (AEST)). */
export function formatPodDateTime(
  at: Date,
  timeZone = 'Australia/Melbourne',
): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(at);
}

export function formatJourneyForTable(
  events: PodJourneyEvent[],
  timeZone = 'Australia/Melbourne',
): { headers: string[]; rows: string[][] } {
  return {
    headers: ['Time (AEST)', 'Event', 'Detail'],
    rows: events.map((e) => [
      formatPodDateTime(e.at, timeZone),
      e.event,
      e.detail,
    ]),
  };
}

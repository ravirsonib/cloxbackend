import {
  buildPodJourney,
  formatJourneyForTable,
} from './pod-journey.util';

describe('buildPodJourney', () => {
  const t0 = new Date('2026-10-22T01:00:00.000Z');
  const t1 = new Date('2026-10-22T01:10:00.000Z');
  const t2 = new Date('2026-10-22T01:20:00.000Z');
  const t3 = new Date('2026-10-22T01:30:00.000Z');
  const t4 = new Date('2026-10-22T01:40:00.000Z');
  const t5 = new Date('2026-10-22T01:50:00.000Z');
  const t6 = new Date('2026-10-22T02:00:00.000Z');
  const t7 = new Date('2026-10-22T02:10:00.000Z');

  it('orders milestones chronologically including breaks and exceptions', () => {
    const events = buildPodJourney({
      trip: {
        startedAt: t1,
        safetyPassedAt: t0,
        massCheckedAt: new Date('2026-10-22T01:05:00.000Z'),
        breakStartedAt: t3,
        onBreak: false,
        completedAt: t7,
      },
      stopProgress: [
        {
          stopType: 'PICKUP',
          stopLabel: 'Warehouse',
          suburb: 'Docklands',
          enteredAt: t2,
          exitedAt: new Date('2026-10-22T01:25:00.000Z'),
          approachingNotifiedAt: null,
          atDropoffNotifiedAt: null,
          signedAt: null,
          podFinalizedAt: null,
        },
        {
          stopType: 'DROPOFF',
          stopLabel: 'Site A',
          suburb: 'Richmond',
          enteredAt: t5,
          exitedAt: null,
          approachingNotifiedAt: t4,
          approachingSource: 'MANUAL',
          atDropoffNotifiedAt: t5,
          signedAt: t6,
          signerName: 'Alex Receiver',
          podFinalizedAt: null,
        },
      ],
      exceptions: [
        {
          kind: 'BREAKDOWN',
          status: 'RESOLVED',
          openedAt: new Date('2026-10-22T01:35:00.000Z'),
          resolvedAt: new Date('2026-10-22T01:38:00.000Z'),
          note: 'Flat tyre',
          reasonCode: 'VEHICLE',
        },
      ],
      auditEvents: [
        {
          action: 'trip.break_toggled',
          createdAt: t3,
          metadata: { onBreak: true },
        },
        {
          action: 'trip.break_toggled',
          createdAt: new Date('2026-10-22T01:42:00.000Z'),
          metadata: { onBreak: false },
        },
      ],
      finalizeAt: t7,
    });

    const labels = events.map((e) => e.event);
    expect(labels[0]).toBe('Safety passed');
    expect(labels).toContain('Trip started');
    expect(labels).toContain('Break started');
    expect(labels).toContain('Break ended');
    expect(labels).toContain('Approaching');
    expect(labels).toContain('At dropoff');
    expect(labels).toContain('POD signed');
    expect(labels).toContain('POD finalized');
    expect(labels).toContain('Exception | BREAKDOWN');
    expect(labels).toContain('Exception resolved | BREAKDOWN');
    expect(labels[labels.length - 1]).toBe('Trip completed');

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.at.getTime()).toBeGreaterThanOrEqual(
        events[i - 1]!.at.getTime(),
      );
    }
  });

  it('falls back to trip.breakStartedAt when no break audit', () => {
    const events = buildPodJourney({
      trip: {
        startedAt: t1,
        breakStartedAt: t3,
        completedAt: null,
      },
      stopProgress: [],
    });
    expect(events.some((e) => e.event === 'Break started')).toBe(true);
  });

  it('formatJourneyForTable returns Time/Event/Detail rows', () => {
    const events = buildPodJourney({
      trip: {
        startedAt: t1,
        breakStartedAt: null,
        completedAt: null,
      },
      stopProgress: [
        {
          stopType: 'DROPOFF',
          suburb: 'Richmond',
          enteredAt: t2,
          exitedAt: null,
          approachingNotifiedAt: null,
          atDropoffNotifiedAt: null,
          signedAt: t6,
          signerName: 'Sam',
          podFinalizedAt: t7,
        },
      ],
    });
    const table = formatJourneyForTable(events);
    expect(table.headers).toEqual(['Time (AEST)', 'Event', 'Detail']);
    expect(table.rows.length).toBe(events.length);
    expect(table.rows[0]).toHaveLength(3);
  });
});

/**
 * Pure helper mirrored from JobsService.resolveJobOrigin state mapping —
 * keeps origin-region resolution unit-tested without Nest DI.
 */
export function resolveOriginStateCode(
  stops: Array<{ stopType: string; state: string | null }>,
): string | null {
  const pickup = stops.find((s) => s.stopType === 'PICKUP') ?? stops[0] ?? null;
  const stateCode = pickup?.state?.trim().toUpperCase() ?? null;
  const AU = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);
  if (stateCode && AU.has(stateCode)) return stateCode;
  return null;
}

describe('job origin state resolution (S1/M1)', () => {
  it('uses primary PICKUP stop state', () => {
    expect(
      resolveOriginStateCode([
        { stopType: 'DROPOFF', state: 'NSW' },
        { stopType: 'PICKUP', state: 'vic' },
      ]),
    ).toBe('VIC');
  });

  it('falls back to first stop when no PICKUP', () => {
    expect(resolveOriginStateCode([{ stopType: 'DROPOFF', state: 'QLD' }])).toBe('QLD');
  });

  it('returns null for unknown state', () => {
    expect(resolveOriginStateCode([{ stopType: 'PICKUP', state: 'ZZ' }])).toBeNull();
  });
});

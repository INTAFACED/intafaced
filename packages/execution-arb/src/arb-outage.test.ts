import { describe, expect, it } from 'vitest';
import { observeArbLeg, recordArbVenueLegs, recoverArbFills, type ArbFillFact, type ObserveArbLegInput } from './arb-outage.js';

function obs(over: Partial<ObserveArbLegInput> & Pick<ObserveArbLegInput, 'signal'>): ObserveArbLegInput {
  return {
    side: over.side ?? (over.venueId === 'bybit' ? 'sell' : 'buy'),
    venueId: over.venueId ?? (over.side === 'sell' ? 'bybit' : 'binance'),
    signal: over.signal,
  };
}

function fill(over: Partial<ArbFillFact> = {}): ArbFillFact {
  return {
    fillId: over.fillId ?? 'fill-1',
    clientOrderId: over.clientOrderId ?? 'clid-1',
    venueId: over.venueId ?? 'binance',
    amount: over.amount ?? '1',
  };
}

describe('observeArbLeg — outage/timeout/missing fill are unknown, never invented fills', () => {
  it('outage is OUTCOME_UNKNOWN with no fill', () => {
    const seen = observeArbLeg(obs({ signal: { kind: 'outage' } }));
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
    expect(seen.fill).toBeNull();
  });

  it('timeout is OUTCOME_UNKNOWN with no fill', () => {
    const seen = observeArbLeg(obs({ signal: { kind: 'timeout' } }));
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
    expect(seen.fill).toBeNull();
  });

  it('missing fill report is OUTCOME_UNKNOWN with no invented fill', () => {
    const seen = observeArbLeg(obs({ signal: { kind: 'missing_fill_report' } }));
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
    expect(seen.fill).toBeNull();
  });

  it('degraded is OUTCOME_UNKNOWN — not group-success material', () => {
    const seen = observeArbLeg(obs({ signal: { kind: 'degraded' } }));
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
    expect(seen.fill).toBeNull();
  });

  it('fill_report without fillId does not invent a fill', () => {
    const seen = observeArbLeg(
      obs({
        signal: { kind: 'fill_report', fillId: '  ', clientOrderId: 'clid-1', amount: '1' },
      }),
    );
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
    expect(seen.fill).toBeNull();
  });

  it('fill_report with malformed amount does not invent a fill', () => {
    const seen = observeArbLeg(
      obs({
        signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: 'not-money' },
      }),
    );
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
    expect(seen.fill).toBeNull();
  });

  it('fill_report with non-positive amount is not a fill', () => {
    const seen = observeArbLeg(
      obs({
        signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: '0' },
      }),
    );
    expect(seen.fill).toBeNull();
    expect(seen.leg.outcome).toBe('OUTCOME_UNKNOWN');
  });

  it('a real fill_report is APPLIED with canonical decimal amount', () => {
    const seen = observeArbLeg(
      obs({
        signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: '1.10' },
      }),
    );
    expect(seen.leg.outcome).toBe('APPLIED');
    expect(seen.fill).toEqual({
      fillId: 'fill-1',
      clientOrderId: 'clid-1',
      venueId: 'binance',
      amount: '1.1',
    });
  });
});

describe('recoverArbFills — duplicate recovery does not double-fill', () => {
  it('the same fillId from venue then drop-copy is one journal row', () => {
    const first = recoverArbFills([], [fill({ amount: '1.00' })]);
    const second = recoverArbFills(first.journal, [fill({ amount: '1' })]);
    expect(first.newlyApplied).toHaveLength(1);
    expect(second.journal).toHaveLength(1);
    expect(second.newlyApplied).toHaveLength(0);
    expect(second.duplicatesIgnored).toHaveLength(1);
    expect(second.journal[0]?.amount).toBe('1.00');
  });

  it('same fillId with a different amount is a conflict, not a second fill', () => {
    const result = recoverArbFills([fill({ amount: '1' })], [fill({ amount: '2' })]);
    expect(result.journal).toHaveLength(1);
    expect(result.journal[0]?.amount).toBe('1');
    expect(result.newlyApplied).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.ignored.amount).toBe('2');
  });

  it('two distinct fillIds remain two fills', () => {
    const result = recoverArbFills([], [fill({ fillId: 'a' }), fill({ fillId: 'b', venueId: 'bybit' })]);
    expect(result.journal).toHaveLength(2);
    expect(result.newlyApplied).toHaveLength(2);
  });
});

describe('recordArbVenueLegs — degraded/outage is not a successful arb', () => {
  it('first-leg fill plus second-leg outage is unknown, with only the real fill journaled', () => {
    const result = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'buy-1', clientOrderId: 'clid-buy', amount: '1' },
        }),
        obs({ side: 'sell', venueId: 'bybit', signal: { kind: 'outage' } }),
      ],
    });
    expect(result.group.ok).toBe(false);
    expect(result.group).toMatchObject({ outcome: 'OUTCOME_UNKNOWN', reason: 'unknown_leg' });
    expect(result.journal).toEqual([{ fillId: 'buy-1', clientOrderId: 'clid-buy', venueId: 'binance', amount: '1' }]);
  });

  it('timeout on a venue after dispatch is unknown — not success, not a reject that invites a duplicate', () => {
    const result = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'buy-1', clientOrderId: 'clid-buy', amount: '1' },
        }),
        obs({ side: 'sell', venueId: 'bybit', signal: { kind: 'timeout' } }),
      ],
    });
    expect(result.group.ok).toBe(false);
    expect(result.group.outcome).toBe('OUTCOME_UNKNOWN');
    expect(result.journal).toHaveLength(1);
  });

  it('missing fill report cannot invent the second fill or mark the arb successful', () => {
    const result = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'buy-1', clientOrderId: 'clid-buy', amount: '1' },
        }),
        obs({ side: 'sell', venueId: 'bybit', signal: { kind: 'missing_fill_report' } }),
      ],
    });
    expect(result.group.ok).toBe(false);
    expect(result.journal.map((row) => row.fillId)).toEqual(['buy-1']);
  });

  it('duplicate recovery of the same fill during outage catch-up does not double-fill', () => {
    const first = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'buy-1', clientOrderId: 'clid-buy', amount: '1' },
        }),
        obs({ side: 'sell', venueId: 'bybit', signal: { kind: 'timeout' } }),
      ],
    });
    const catchUp = recordArbVenueLegs({
      expectedLegCount: 2,
      journal: first.journal,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'buy-1', clientOrderId: 'clid-buy', amount: '1.0' },
        }),
        obs({
          side: 'sell',
          venueId: 'bybit',
          signal: { kind: 'fill_report', fillId: 'sell-1', clientOrderId: 'clid-sell', amount: '1' },
        }),
      ],
    });
    expect(catchUp.duplicatesIgnored).toHaveLength(1);
    expect(catchUp.newlyApplied.map((row) => row.fillId)).toEqual(['sell-1']);
    expect(catchUp.journal).toHaveLength(2);
    expect(catchUp.group.ok).toBe(true);
  });

  it('both venues outaged is not a successful arb and journals no fills', () => {
    const result = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({ side: 'buy', venueId: 'binance', signal: { kind: 'outage' } }),
        obs({ side: 'sell', venueId: 'bybit', signal: { kind: 'degraded' } }),
      ],
    });
    expect(result.group.ok).toBe(false);
    expect(result.group.outcome).toBe('OUTCOME_UNKNOWN');
    expect(result.journal).toEqual([]);
  });

  it('two APPLIED observations that share a fillId and disagree on amount are not group success', () => {
    const result = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: '1' },
        }),
        obs({
          side: 'sell',
          venueId: 'bybit',
          signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: '2' },
        }),
      ],
    });
    expect(result.group.ok).toBe(false);
    expect(result.conflicts.map((row) => row.fillId)).toEqual(['fill-1']);
    expect(result.journal).toEqual([{ fillId: 'fill-1', clientOrderId: 'clid-1', venueId: 'binance', amount: '1' }]);
    expect(result.conflicts[0]?.kept.amount).toBe('1');
    expect(result.conflicts[0]?.ignored.amount).toBe('2');
  });

  it('equal amounts on the same fillId ignore the duplicate and the group can still be ok', () => {
    const result = recordArbVenueLegs({
      expectedLegCount: 2,
      observations: [
        obs({
          side: 'buy',
          venueId: 'binance',
          signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: '1' },
        }),
        obs({
          side: 'sell',
          venueId: 'bybit',
          signal: { kind: 'fill_report', fillId: 'fill-1', clientOrderId: 'clid-1', amount: '1.00' },
        }),
      ],
    });
    expect(result.duplicatesIgnored).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(result.journal).toEqual([{ fillId: 'fill-1', clientOrderId: 'clid-1', venueId: 'binance', amount: '1' }]);
    expect(result.group.ok).toBe(true);
  });
});

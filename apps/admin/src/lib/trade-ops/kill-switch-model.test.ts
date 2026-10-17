import { describe, expect, it } from 'vitest';
import type { KillSwitchSnapshot } from '@/lib/control-plane-contract';
import { checkMassCancel, massCancelOutcome, tradeSwitchState, venueOutcome } from './kill-switch-model';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
describe('tradeSwitchState', () => {
  const base: KillSwitchSnapshot = { disabledModules: [], reasons: {}, audit: [] };
  it('is open with no audit', () => {
    expect(tradeSwitchState(base)).toMatchObject({ stopped: false, since: null });
  });
  it('is stopped with the reason and the newest changing entry', () => {
    const s = tradeSwitchState({
      disabledModules: ['trade'],
      reasons: { trade: 'why (by a; confirmed b)' },
      audit: [
        {
          at: '2026-10-17T01:00:00.000Z',
          module: 'trade',
          actor: 'a',
          confirmOperatorId: 'b',
          reason: 'why',
          previous: false,
          next: true,
          changed: true,
        },
        {
          at: '2026-10-16T01:00:00.000Z',
          module: 'trade',
          actor: 'z',
          confirmOperatorId: null,
          reason: 'old',
          previous: true,
          next: false,
          changed: true,
        },
      ],
    });
    expect(s).toMatchObject({
      stopped: true,
      reason: 'why (by a; confirmed b)',
      since: '2026-10-17T01:00:00.000Z',
      by: 'a',
      confirmedBy: 'b',
    });
  });
});

describe('blocked controls', () => {
  it('venue halt answers matching_not_routed once valid', () => {
    const o = venueOutcome({ action: 'halt_all', reason: 'venue incident drill', confirmOperatorId: OTHER }, ME);
    expect(o).toMatchObject({ kind: 'refused', blocker: { key: 'matching_not_routed' } });
  });
  it('venue halt with the same operator is missing_operator', () => {
    expect(venueOutcome({ action: 'halt_all', reason: 'venue incident drill', confirmOperatorId: ME }, ME)).toMatchObject({
      code: 'missing_operator',
    });
  });
  it('mass cancel validates the target then answers the blocker', () => {
    expect(checkMassCancel({ scope: 'market', target: 'btc', reason: 'x'.repeat(12), confirmOperatorId: OTHER }, ME)).toMatchObject({
      ok: false,
      code: 'trade_ops.bad_target',
    });
    expect(
      massCancelOutcome({ scope: 'market', target: 'BTC/USDT', reason: 'cleanup after halt', confirmOperatorId: OTHER }, ME),
    ).toMatchObject({ blocker: { key: 'mass_cancel_operator_missing' } });
    expect(
      massCancelOutcome({ scope: 'account', target: OTHER, reason: 'cleanup after halt', confirmOperatorId: OTHER }, ME),
    ).toMatchObject({ blocker: { key: 'mass_cancel_operator_missing' } });
  });
});

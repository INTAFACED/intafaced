import { describe, expect, it } from 'vitest';
import { QUANT_CLAIM_PNL_UNSET, QUANT_RUN_NOT_FOUND, QUANT_RUN_UNFINISHED, QUANT_SIMULATED_AS_LIVE } from '../errors.js';
import type { StoredRun } from '../runs/types.js';
import { claimFromRun } from './claim.js';

const caller = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function run(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'run_1',
    userId: caller,
    kind: 'backtest',
    strategyId: 'strategy_1',
    strategyVersion: 1,
    started: '2026-10-18T00:00:00.000Z',
    finished: '2026-10-18T00:00:01.000Z',
    outcome: 'ok',
    detail: {
      equityCurve: [{ ts: '2026-02-01T00:00:00.000Z', equity: '9500' }],
      trades: [{ ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' }],
      costs: null,
      pnl: '-1520',
      simulated: true,
      live: false,
      environment: 'backtest',
      kind: 'simulated',
      claimLabel: 'Historical simulation — not a forecast',
    },
    response: null,
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

describe('marketplace.claim — pnl comes from the stored run', () => {
  it('refuses a missing run as not found', () => {
    expect(() => claimFromRun({ run: null, callerId: caller })).toThrow(QUANT_RUN_NOT_FOUND);
  });

  it('refuses another caller as not found', () => {
    expect(() => claimFromRun({ run: run(), callerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toThrow(QUANT_RUN_NOT_FOUND);
  });

  it('refuses an unfinished run', () => {
    expect(() => claimFromRun({ run: run({ finished: null, outcome: null }), callerId: caller })).toThrow(QUANT_RUN_UNFINISHED);
  });

  it('refuses presenting the stored result as live', () => {
    expect(() => claimFromRun({ run: run(), callerId: caller, environment: 'backtest', presentedAs: 'live' })).toThrow(
      QUANT_SIMULATED_AS_LIVE,
    );
  });

  it('refuses a client environment of live', () => {
    expect(() => claimFromRun({ run: run(), callerId: caller, environment: 'live' })).toThrow(QUANT_SIMULATED_AS_LIVE);
  });

  it('stamps the stored simulated pnl and ignores a missing client environment', () => {
    const claim = claimFromRun({ run: run(), callerId: caller });
    expect(claim.live).toBe(false);
    expect(claim.simulated).toBe(true);
    expect(claim.environment).toBe('backtest');
    expect(claim.kind).toBe('simulated');
    expect(claim.claimLabel).toBe('Historical simulation — not a forecast');
    expect(claim.pnl).toBe('-1520');
    expect(claim.runId).toBe('run_1');
  });

  it('refuses a stored result with no pnl', () => {
    const source = run();
    expect(() =>
      claimFromRun({
        run: run({ detail: source.detail ? { ...source.detail, pnl: null } : null }),
        callerId: caller,
      }),
    ).toThrow(QUANT_CLAIM_PNL_UNSET);
  });
});

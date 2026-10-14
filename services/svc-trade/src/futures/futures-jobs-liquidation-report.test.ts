import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reportLiquidationTick } from './futures-jobs.js';
import type { LiquidationTickResult } from './liquidation-tick.js';

function tick(items: LiquidationTickResult['items']): LiquidationTickResult {
  return { scanned: items.length, liquidated: 0, partial: 0, marginCalls: 0, errored: 0, parked: 0, items };
}

describe('reportLiquidationTick', () => {
  it('logs an errored position and a parked rung at error level, and nothing for the rest', () => {
    const logged: { name: string; message: string }[] = [];
    reportLiquidationTick(
      tick([
        { positionId: 'pos-a', outcome: 'errored', reason: 'ledger.idempotency_conflict', summary: 'refused' },
        { positionId: 'pos-b', outcome: 'skipped_already', reason: 'already_done' },
        { positionId: 'pos-c', outcome: 'liquidated', reason: 'ladder_full_close' },
        { positionId: 'pos-d', outcome: 'skipped_healthy', reason: 'healthy' },
      ]),
      (name, err) => logged.push({ name, message: (err as Error).message }),
    );
    expect(logged).toEqual([
      { name: 'futures.liquidation', message: 'position pos-a errored (ledger.idempotency_conflict): refused' },
      {
        name: 'futures.liquidation',
        message: 'liquidation rung parked: claim exists but position still open (operator action needed) positionId=pos-b',
      },
    ]);
  });

  it('logs the parked rung again on every tick', () => {
    const logged: unknown[] = [];
    const parked = tick([{ positionId: 'pos-b', outcome: 'skipped_already', reason: 'already_done' }]);
    reportLiquidationTick(parked, (_n, e) => logged.push(e));
    reportLiquidationTick(parked, (_n, e) => logged.push(e));
    expect(logged).toHaveLength(2);
  });
});

describe('reportLiquidationTick: an abandoned rung', () => {
  it('logs a position parked behind an abandoned rung at error level, with its own message', () => {
    const logged: string[] = [];
    reportLiquidationTick(
      tick([{ positionId: 'pos-x', outcome: 'skipped_already', reason: 'trade.liquidation_abandoned_parked' }]),
      (_n, err) => logged.push((err as Error).message),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('latest rung was abandoned');
    expect(logged[0]).toContain('pos-x');
  });
});

describe('reportLiquidationTick: margin alerts', () => {
  it('raises a rung that applied with a margin drift at error level, though the item is a success', () => {
    const logged: string[] = [];
    reportLiquidationTick(
      tick([
        {
          positionId: 'pos-d',
          outcome: 'liquidated',
          reason: 'bankrupt_full_close',
          alert: { code: 'trade.liquidation_margin_drift', rungId: 'r-1', amount: '50' },
        },
      ]),
      (_n, err) => logged.push((err as Error).message),
    );
    expect(logged).toEqual(['trade.liquidation_margin_drift positionId=pos-d rungId=r-1 amount=50']);
  });
});

describe('startFuturesJobs wiring', () => {
  it('hands the liquidation tick the SQL rung store (a rung that is not stored cannot be replayed)', () => {
    const src = readFileSync(fileURLToPath(new URL('./futures-jobs.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/const rungs = sqlLiquidationRungStore\(deps\.sql\)/);
    expect(src).toMatch(/runLiquidationTick\(\{[\s\S]*?\brungs,[\s\S]*?\}\)/);
  });
});

describe('reportLiquidationTick: margin divergence', () => {
  it('raises a row/pot divergence at error level on every tick, even for a healthy position', () => {
    const logged: { name: string; message: string }[] = [];
    const t = tick([
      {
        positionId: 'pos-v',
        outcome: 'skipped_healthy',
        reason: 'none',
        divergence: { code: 'trade.liquidation_margin_divergence', row: '100', pot: '80' },
      },
    ]);
    reportLiquidationTick(t, (name, err) => logged.push({ name, message: (err as Error).message }));
    reportLiquidationTick(t, (name, err) => logged.push({ name, message: (err as Error).message }));
    expect(logged).toHaveLength(2);
    expect(logged[0]!.name).toBe('futures.liquidation');
    expect(logged[0]!.message).toContain('trade.liquidation_margin_divergence positionId=pos-v row=100 pot=80');
  });
});

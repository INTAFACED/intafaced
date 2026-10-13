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

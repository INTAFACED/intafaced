import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moveSettlement, SETTLEMENT_MOVES, settlementPredecessors, SettlementMoveError } from './settlement-status.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const HELPER = 'payment-service/settlement-status.ts';

/** Every `UPDATE pay.settlements … SET …` in a source text whose SET list writes `status`. */
function rawSettlementStatusWrites(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/UPDATE\s+pay\.settlements\s+SET\s+([\s\S]*?)\bWHERE\b/gi)) {
    if (/(^|[\s,])status\s*=/i.test(m[1]!)) found.push(m[0].replace(/\s+/g, ' ').slice(0, 120));
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('a settlement status changes only through moveSettlement', () => {
  it('no svc-pay source writes pay.settlements.status outside settlement-status.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => relative(SRC, path) !== HELPER)
      .flatMap((path) => rawSettlementStatusWrites(readFileSync(path, 'utf8')).map((sql) => `${relative(SRC, path)}: ${sql}`));
    expect(offenders, `write the move with moveSettlement (src/${HELPER}), which refuses a status SETTLEMENT_MOVES does not allow`).toEqual(
      [],
    );
  });

  it('catches the raw writes payouts.ts held before the helper (the reconcile not_sent and paid_out writes)', () => {
    // Verbatim from payouts.ts on main before this change (reconcileDispatchedPayout): neither checked the current status.
    const before = [
      "await tx`UPDATE pay.settlements SET status='failed',payout_attempts=${admission.attempt + 1},failed_at=now(),failure_code=${(safeFailure(failureCode) ?? { code: 'pay.failed' }).code},updated_at=now() WHERE id=${settlement.id}`;",
      "await tx`UPDATE pay.settlements SET status='paid_out',payout_method=${admission.rail_id},payout_ref=${railRef!},sent_at=COALESCE(sent_at, now()),failed_at=NULL,failure_code=NULL,updated_at=now() WHERE id=${settlement.id}`;",
    ].join('\n');
    expect(rawSettlementStatusWrites(before)).toHaveLength(2);
    // A write that leaves status alone (the refund cut of a payout's net) is not a move.
    expect(
      rawSettlementStatusWrites(
        'UPDATE pay.settlements SET net = ${n}::numeric, gross = fees + ${n}::numeric, updated_at = now() WHERE id = ${id}',
      ),
    ).toEqual([]);
  });
});

describe('SETTLEMENT_MOVES', () => {
  it('a paid-out settlement never moves, and a payout moves only a posted or failed one', () => {
    expect(SETTLEMENT_MOVES.paid_out).toEqual([]);
    expect(settlementPredecessors('paid_out').sort()).toEqual(['failed', 'posted']);
    expect(settlementPredecessors('posted')).toEqual(['pending']);
    expect(settlementPredecessors('failed').sort()).toEqual(['failed', 'pending', 'posted']);
  });
});

describe('moveSettlement', () => {
  /** A tagged-template stand-in for one settlement row: the UPDATE moves it only from a status in its ANY() list. */
  function fakeRow(status: string) {
    const calls: string[] = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push(text);
      if (/^\s*UPDATE/.test(text)) {
        const allowed = values.find(Array.isArray) as string[];
        if (!allowed.includes(status)) return Promise.resolve([]);
        status = /SET status = '(\w+)'/.exec(text)![1]!;
        return Promise.resolve([{ id: 's1' }]);
      }
      return Promise.resolve([{ status }]);
    };
    return { tx: tx as never, calls, status: () => status };
  }

  it('moves a posted settlement to paid_out', async () => {
    const row = fakeRow('posted');
    await moveSettlement(row.tx, 's1', { to: 'paid_out', payoutMethod: 'crypto-native', payoutRef: '0xabc' });
    expect(row.status()).toBe('paid_out');
  });

  it('refuses to fail a settlement already paid out: a late not_sent answer changes nothing', async () => {
    const row = fakeRow('paid_out');
    const err = await moveSettlement(row.tx, 's1', { to: 'failed', failureCode: 'rail.not_sent', payoutAttempts: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(SettlementMoveError);
    expect(err).toMatchObject({ code: 'pay.invalid_transition', from: 'paid_out', to: 'failed' });
    expect(row.status()).toBe('paid_out');
  });

  it('refuses to post a released window', async () => {
    const row = fakeRow('failed');
    await expect(moveSettlement(row.tx, 's1', { to: 'posted' })).rejects.toMatchObject({ from: 'failed', to: 'posted' });
  });
});

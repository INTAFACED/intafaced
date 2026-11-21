/**
 * #4615 data repair: rows written with the old `${text}::jsonb` bind hold a
 * JSON string instead of the value. The repair migration turns each one back
 * into the value it held, leaves good rows and unrecoverable strings alone,
 * and is safe to run twice.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const REPAIR = '20261113003208_repair_jsonb_string_rows.sql';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const repairSql = readFileSync(join(drizzleDir, REPAIR), 'utf8');
// Every migration before the repair, so the broken rows can be planted first.
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql') && name < REPAIR)
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

// PG-hard: never skip-green. An unset or unreachable database fails this suite.
const db: TestDatabase = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
afterAll(async () => {
  await db.drop();
});

const USER = '11111111-1111-4111-8111-111111111111';
const MARKETS = ['BTC/USDT', 'ETH/USDT'];
const PROOF = { stage: 'placed', venue: 'TEST', steps: [1, 2] };
const DOSSIER = { kind: 'AUTHORITY_DOSSIER', version: 1 };
const TRANSITION = { from: 'listed', to: 'halted' };
const CORRECTION = { corrects: 'ev-1', reason: 'TEST' };

async function market(): Promise<string> {
  const symbol = `R/${randomUUID().slice(0, 8)}`;
  const rows = await db.sql<{ id: string }[]>`
    INSERT INTO trade.markets (symbol, display_name, base_asset, quote_asset, tick_size, lot_size, min_qty, min_notional, maker_bps, taker_bps)
    VALUES (${symbol}, ${symbol}, 'BTC', 'USDT', '0.01', '0.0001', '0.0001', '1', 10, 20)
    RETURNING id
  `;
  return rows[0]!.id;
}

async function follow(id: string, marketsJson: string, bind: 'bug' | 'good') {
  const markets = bind === 'bug' ? db.sql`${marketsJson}::jsonb` : db.sql`${marketsJson}::text::jsonb`;
  await db.sql`
    INSERT INTO trade.copy_follows (follow_id, follower_id, leader_id, region, permitted_markets, max_notional_per_order, max_aggregate_exposure, expires_at)
    VALUES (${id}, ${`f-${id}`}, ${`l-${id}`}, 'TEST', ${markets}, '10', '100', now() + interval '1 day')
  `;
}

async function order(marketId: string, proofJson: string | null, bind: 'bug' | 'good') {
  const id = randomUUID();
  const proof = proofJson === null ? db.sql`NULL` : bind === 'bug' ? db.sql`${proofJson}::jsonb` : db.sql`${proofJson}::text::jsonb`;
  await db.sql`
    INSERT INTO trade.orders (id, user_id, market_id, side, type, price, qty, hold_asset, hold_amount, status, lifecycle_proof)
    VALUES (${id}, ${USER}, ${marketId}, 'buy', 'limit', '1', '1', 'USDT', '1', 'open', ${proof})
  `;
  return id;
}

async function evidence(
  kind: 'TRANSITION' | 'CORRECTION' | 'AUTHORITY_DOSSIER',
  marketId: string,
  payloadJson: string,
  predecessor: string | null,
) {
  const id = `ev-${randomUUID()}`;
  const payload = db.sql`${payloadJson}::jsonb`; // the old, buggy bind
  const transition = kind === 'TRANSITION' ? payload : db.sql`NULL`;
  const correction = kind === 'CORRECTION' ? payload : db.sql`NULL`;
  const publication = kind === 'AUTHORITY_DOSSIER' ? payload : db.sql`NULL`;
  await db.sql`
    INSERT INTO trade.market_lifecycle_evidence (evidence_id, market_id, evidence_kind, transition, correction, publication, causal_predecessor_id, observed_at)
    VALUES (${id}, ${marketId}, ${kind}, ${transition}, ${correction}, ${publication}, ${predecessor}, now())
  `;
  return id;
}

async function typeOf(table: string, column: string, key: string, id: string) {
  const rows = await db.sql.unsafe<{ t: string | null; v: unknown }[]>(
    `SELECT jsonb_typeof("${column}") AS t, "${column}" AS v FROM trade.${table} WHERE ${key} = $1`,
    [id],
  );
  return rows[0]!;
}

describe('repair of jsonb columns stored as JSON strings (#4615)', () => {
  it('turns every string-stored row back into its value and leaves the rest alone', async () => {
    const marketId = await market();
    await follow('broken', JSON.stringify(MARKETS), 'bug');
    await follow('good', JSON.stringify(MARKETS), 'good');
    // A string that never held JSON: nothing to recover, so it must stay.
    await follow('junk', JSON.stringify('not json'), 'good');
    const brokenOrder = await order(marketId, JSON.stringify(PROOF), 'bug');
    const goodOrder = await order(marketId, JSON.stringify(PROOF), 'good');
    const noProofOrder = await order(marketId, null, 'good');
    const dossier = await evidence('AUTHORITY_DOSSIER', marketId, JSON.stringify(DOSSIER), null);
    const transition = await evidence('TRANSITION', marketId, JSON.stringify(TRANSITION), 'ev-0');
    const correction = await evidence('CORRECTION', marketId, JSON.stringify(CORRECTION), transition);

    // The planted rows really carry the bug.
    expect((await typeOf('copy_follows', 'permitted_markets', 'follow_id', 'broken')).t).toBe('string');
    expect((await typeOf('orders', 'lifecycle_proof', 'id', brokenOrder)).t).toBe('string');
    expect((await typeOf('market_lifecycle_evidence', 'publication', 'evidence_id', dossier)).t).toBe('string');
    expect((await typeOf('market_lifecycle_evidence', 'transition', 'evidence_id', transition)).t).toBe('string');
    expect((await typeOf('market_lifecycle_evidence', 'correction', 'evidence_id', correction)).t).toBe('string');

    await db.sql.unsafe(repairSql);

    expect(await typeOf('copy_follows', 'permitted_markets', 'follow_id', 'broken')).toEqual({ t: 'array', v: MARKETS });
    expect(await typeOf('copy_follows', 'permitted_markets', 'follow_id', 'good')).toEqual({ t: 'array', v: MARKETS });
    expect(await typeOf('copy_follows', 'permitted_markets', 'follow_id', 'junk')).toEqual({ t: 'string', v: 'not json' });
    expect(await typeOf('orders', 'lifecycle_proof', 'id', brokenOrder)).toEqual({ t: 'object', v: PROOF });
    expect(await typeOf('orders', 'lifecycle_proof', 'id', goodOrder)).toEqual({ t: 'object', v: PROOF });
    expect(await typeOf('orders', 'lifecycle_proof', 'id', noProofOrder)).toEqual({ t: null, v: null });
    expect(await typeOf('market_lifecycle_evidence', 'publication', 'evidence_id', dossier)).toEqual({
      t: 'object',
      v: DOSSIER,
    });
    expect(await typeOf('market_lifecycle_evidence', 'transition', 'evidence_id', transition)).toEqual({
      t: 'object',
      v: TRANSITION,
    });
    expect(await typeOf('market_lifecycle_evidence', 'correction', 'evidence_id', correction)).toEqual({
      t: 'object',
      v: CORRECTION,
    });

    // Running it again changes nothing.
    const before = await db.sql`SELECT follow_id, permitted_markets FROM trade.copy_follows ORDER BY follow_id`;
    await db.sql.unsafe(repairSql);
    const after = await db.sql`SELECT follow_id, permitted_markets FROM trade.copy_follows ORDER BY follow_id`;
    expect(after).toEqual(before);
  });
});

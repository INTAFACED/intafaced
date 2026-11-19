import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlSpotConditionalStore, type SpotConditional } from './spot-conditional-store.js';

// trade.user_venue_spot_conditionals (J-cex-spot-08): one order per client id, never deleted, its terms fixed except a
// live stop's prices and an exit size set once, a final state final, and of two claims on one order only one wins.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The spot conditional store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const USER = '11111111-1111-4111-8111-1111111111c8';
const OWNER = '0x00000000000000000000000000000000000000c8';
const a = parseAmount;
const row = (id: string, clientKey: string, over: Partial<SpotConditional> = {}): SpotConditional => ({
  id,
  userId: USER,
  venueId: 'test-venue-sim',
  owner: OWNER,
  clientKey,
  kind: 'oco',
  symbol: 'TESTC-USDC',
  side: 'sell',
  quantity: a('1'),
  triggerPrice: a('95'),
  limitPrice: null,
  takeProfitPrice: a('110'),
  entryPrice: null,
  entryTif: null,
  closePrice: null,
  exitQuantity: null,
  agentAddress: '0x00000000000000000000000000000000000000a8',
  region: 'DE',
  status: 'placing',
  failure: null,
  cancelReason: null,
  firedAt: null,
  createdAt: new Date('2026-11-17T12:00:00Z'),
  ...over,
});

describe('SqlSpotConditionalStore on Postgres (trade.user_venue_spot_conditionals)', () => {
  let db: TestDatabase | undefined;
  let store: SqlSpotConditionalStore;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    store = new SqlSpotConditionalStore(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('stores one order per client id: a replay answers the first', async () => {
    const first = await store.createOnce(row('aaaaaaaa-0000-4000-8000-0000000000c1', 'oco-1'));
    const again = await store.createOnce(row('aaaaaaaa-0000-4000-8000-0000000000c2', 'oco-1', { takeProfitPrice: a('120') }));
    expect(again.id).toBe(first.id);
    expect(again.takeProfitPrice).toBe(a('110'));
    expect((await store.listForOwner(USER, OWNER)).map((r) => r.id)).toEqual([first.id]);
  });

  it('of two claims on one order only one wins; a final state stays final; an order is never deleted', async () => {
    const r = await store.createOnce(row('aaaaaaaa-0000-4000-8000-0000000000c3', 'oco-2', { status: 'open' }));
    const at = new Date();
    const [one, two] = await Promise.all([store.move(r.id, 'open', 'firing', at), store.move(r.id, 'open', 'cancelling', at)]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const now = (await store.get(USER, r.id))!.status;
    expect(await store.move(r.id, now, 'fired', at)).toBe(true);
    await expect(db!.sql`UPDATE trade.user_venue_spot_conditionals SET status = 'open' WHERE id = ${r.id}`).rejects.toThrow(
      /only a live order changes/,
    );
    await expect(db!.sql`DELETE FROM trade.user_venue_spot_conditionals WHERE id = ${r.id}`).rejects.toThrow(/never deleted/);
  });

  it('changes a live stop’s prices and an exit size once, never its other terms', async () => {
    const r = await store.createOnce(
      row('aaaaaaaa-0000-4000-8000-0000000000c4', 'br-1', {
        kind: 'bracket',
        side: 'buy',
        entryPrice: a('100'),
        entryTif: 'GTC',
        status: 'entry',
      }),
    );
    expect(await store.reprice(r.id, 'entry', a('96'), a('95'), new Date())).toBe(true);
    expect(await store.move(r.id, 'entry', 'placing', new Date(), { exitQuantity: a('0.999') })).toBe(true);
    expect(await store.move(r.id, 'placing', 'open', new Date(), { exitQuantity: a('5') })).toBe(true);
    const now = (await store.get(USER, r.id))!;
    expect(now).toMatchObject({ triggerPrice: a('96'), limitPrice: a('95'), exitQuantity: a('0.999'), status: 'open' });
    await expect(db!.sql`UPDATE trade.user_venue_spot_conditionals SET quantity = 2 WHERE id = ${r.id}`).rejects.toThrow(
      /only a live order changes/,
    );
    await expect(db!.sql`UPDATE trade.user_venue_spot_conditionals SET exit_quantity = 2 WHERE id = ${r.id}`).rejects.toThrow(
      /only a live order changes/,
    );
    expect((await store.live()).map((x) => x.id)).toContain(r.id);
  });

  it('refuses a row whose fields do not fit its kind', async () => {
    await expect(
      store.createOnce(row('aaaaaaaa-0000-4000-8000-0000000000c5', 'bad-1', { kind: 'stop_limit', takeProfitPrice: a('1') })),
    ).rejects.toThrow(/fields_ck/);
  });
});

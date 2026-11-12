import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlAllowanceStore, type AllowanceRecord, type DrawRecord } from './own-agent-allowance-store.js';

// trade.user_venue_own_agent_allowances and trade.user_venue_own_agent_draws (J-agents-08 #4 #6 #7): one live
// allowance per agent, draws admitted under the allowance's row lock (two that together exceed it admit one), the same
// order id again the same draw, and no draw admitted once the allowance is revoked.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The allowance store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c1';
const AGENT = '22222222-2222-4222-8222-2222222222c2';
let n = 0;
const id = () => {
  n += 1;
  return `a1a1a1a1-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
const allowance = (allowanceId: string, agentId = AGENT): AllowanceRecord => ({
  userId: USER,
  allowanceId,
  agentId,
  venueId: 'test-venue-sim',
  owner: '0x00000000000000000000000000000000000000c1',
  subAccount: '0x00000000000000000000000000000000000000c2',
  asset: 'USDC',
  amount: a('20'),
  period: 'week',
  agentAddress: `0x${allowanceId.replace(/-/g, '').padStart(40, '0').slice(-40)}`,
  status: 'signing',
  createdAt: new Date(Date.now() - 1_000),
  endsAt: new Date(Date.now() + 7 * 86_400_000),
  activeAt: null,
  revokedAt: null,
});
const draw = (allowanceId: string, size: string): DrawRecord => ({
  userId: USER,
  allowanceId,
  orderId: id(),
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'market',
  size: a(size),
  price: a('65000'),
  amount: a(String(Number(size) * 65000)),
  state: 'admitted',
  createdAt: new Date(),
});

describe('SqlAllowanceStore on Postgres (trade.user_venue_own_agent_allowances, trade.user_venue_own_agent_draws)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('one live allowance per agent: a second grant while one is signing names the live one; the same id is the same row', async () => {
    const store = new SqlAllowanceStore(db!.sql);
    const agent = '22222222-2222-4222-8222-2222222222d1';
    const first = allowance(id(), agent);
    expect(await store.insertOnce(first)).toEqual({ stored: first });
    expect(await store.insertOnce(first)).toEqual({ stored: first });
    const second = await store.insertOnce(allowance(id(), agent));
    expect('live' in second && second.live.allowanceId).toBe(first.allowanceId);
    await store.abandon(USER, first.allowanceId);
    expect('stored' in (await store.insertOnce(allowance(id(), agent)))).toBe(true);
  });

  it('two draws at once that together exceed the allowance admit one; the same order id again is the same draw', async () => {
    const store = new SqlAllowanceStore(db!.sql);
    const al = allowance(id(), '22222222-2222-4222-8222-2222222222d2');
    expect(await store.insertOnce(al)).toEqual({ stored: al });
    await store.activate(USER, al.allowanceId, new Date());
    const x = draw(al.allowanceId, '0.0002');
    const y = draw(al.allowanceId, '0.0002');
    const both = await Promise.all([store.admit(x, new Date()), store.admit(y, new Date())]);
    expect(both.map((o) => (o.admitted ? 'admitted' : o.refusal)).sort()).toEqual(['admitted', 'exceeded']);
    expect((await store.draws(USER, al.allowanceId)).length).toBe(1);
    const winner = both[0]!.admitted ? x : y;
    const again = await store.admit(winner, new Date());
    expect(again).toMatchObject({ admitted: true, replayed: true });
    expect((await store.draws(USER, al.allowanceId)).length).toBe(1);
    // A refused draw no longer counts, so the room comes back.
    await store.refuse(USER, winner.orderId);
    expect(await store.admit(draw(al.allowanceId, '0.0002'), new Date())).toMatchObject({ admitted: true, replayed: false });
  });

  it('a draw waits for the row lock: one admitted while it waited is counted, so the two never both fit', async () => {
    const sql = db!.sql;
    const store = new SqlAllowanceStore(sql);
    const al = allowance(id(), '22222222-2222-4222-8222-2222222222d4');
    expect(await store.insertOnce(al)).toEqual({ stored: al });
    await store.activate(USER, al.allowanceId, new Date());
    const x = draw(al.allowanceId, '0.0002');
    const y = draw(al.allowanceId, '0.0002');
    let second: ReturnType<typeof store.admit> | undefined;
    // Another admission holds the lock: y is asked meanwhile, and x is written before the lock is let go.
    await sql.begin(async (tx) => {
      await tx`SELECT 1 FROM trade.user_venue_own_agent_allowances WHERE user_id = ${USER} AND allowance_id = ${al.allowanceId} FOR UPDATE`;
      second = store.admit(y, new Date());
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`
        INSERT INTO trade.user_venue_own_agent_draws
          (user_id, allowance_id, order_id, symbol, side, order_type, size, price, amount, state, created_at)
        VALUES (${USER}, ${al.allowanceId}, ${x.orderId}, 'BTC-USDC', 'buy', 'market', '0.0002', '65000', '13', 'admitted', now())`;
    });
    expect(await second!).toMatchObject({ admitted: false, refusal: 'exceeded' });
    expect((await store.draws(USER, al.allowanceId)).map((d) => d.orderId)).toEqual([x.orderId]);
  });

  it('a revoked allowance admits nothing, and a draw is never deleted and never un-refused', async () => {
    const sql = db!.sql;
    const store = new SqlAllowanceStore(sql);
    const al = allowance(id(), '22222222-2222-4222-8222-2222222222d3');
    expect(await store.insertOnce(al)).toEqual({ stored: al });
    await store.activate(USER, al.allowanceId, new Date());
    const d = draw(al.allowanceId, '0.0001');
    expect((await store.admit(d, new Date())).admitted).toBe(true);
    const revoked = await store.revoke(USER, al.allowanceId, new Date());
    expect(revoked.status).toBe('revoked');
    expect(await store.admit(draw(al.allowanceId, '0.0001'), new Date())).toMatchObject({ admitted: false, refusal: 'revoked' });
    await expect(sql`DELETE FROM trade.user_venue_own_agent_draws WHERE order_id = ${d.orderId}`).rejects.toThrow(/never deleted/);
    await store.refuse(USER, d.orderId);
    await expect(sql`UPDATE trade.user_venue_own_agent_draws SET state = 'admitted' WHERE order_id = ${d.orderId}`).rejects.toThrow(
      /only an admitted draw may be refused/,
    );
  });
});

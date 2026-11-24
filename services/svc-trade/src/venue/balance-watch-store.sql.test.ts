import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlBalanceWatchStore } from './balance-watch-store.js';

// trade.user_venue_balance_watch_* (J-cex-spot-15 #9): the watch's cursor reads back as it was written, a later write
// replaces the totals and adds to what was seen, and each account's cursor is its own.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The balance watch store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const MAIN = { venueId: 'test-venue-sim', owner: '0x00000000000000000000000000000000000000c9', subAccount: null };
const SUB = { ...MAIN, subAccount: '0x00000000000000000000000000000000000000ca' };

describe('SqlBalanceWatchStore on Postgres (trade.user_venue_balance_watch_*)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('reads back what it wrote, replaces totals, adds to what was seen, and keeps each account apart', async () => {
    const store = new SqlBalanceWatchStore(db!.sql);
    expect(await store.read(MAIN)).toBeNull();
    const t1 = new Date('2026-11-24T03:00:00Z');
    await store.write(MAIN, { totals: new Map([['USDC', a('1000')]]), unreported: new Map(), fillsSince: t1 }, ['arrival:a', 'fill:1']);
    const first = await store.read(MAIN);
    expect(first).toEqual({
      totals: new Map([['USDC', a('1000')]]),
      unreported: new Map([['USDC', 0]]),
      seen: new Set(['arrival:a', 'fill:1']),
      fillsSince: t1,
    });
    const t2 = new Date('2026-11-24T03:05:00Z');
    await store.write(
      MAIN,
      {
        totals: new Map([
          ['USDC', a('975.5')],
          ['BTC', a('0.01')],
        ]),
        unreported: new Map([['USDC', 1]]),
        fillsSince: t2,
      },
      ['fill:1', 'fill:2'],
    );
    const second = await store.read(MAIN);
    expect(second?.totals).toEqual(
      new Map([
        ['USDC', a('975.5')],
        ['BTC', a('0.01')],
      ]),
    );
    expect(second?.unreported.get('USDC')).toBe(1);
    expect(second?.seen).toEqual(new Set(['arrival:a', 'fill:1', 'fill:2']));
    expect(second?.fillsSince).toEqual(t2);
    expect(await store.read(SUB)).toBeNull();
  });
});

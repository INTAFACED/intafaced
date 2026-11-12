/**
 * Signal bots (J-copy-bots-otc-21 #1 #2 #3), against Postgres: access read from svc-market fail closed, the owner's
 * cap required, one bot per client bot id, and a new bot awaiting its first signal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { principalFor } from '../spot/testing.js';
import { SignalBots, parseSignalBotCap, type SignalAccessSource } from './signal-bots.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const LISTING = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
}, 120_000);
afterAll(async () => {
  await db?.drop();
}, 30_000);
beforeEach(async () => {
  await db.sql`TRUNCATE trade.signal_bots`;
});

const access = (answer: { access: boolean; title: string } | null): SignalAccessSource & { calls: number } => {
  const source = {
    calls: 0,
    async access() {
      source.calls += 1;
      return answer;
    },
  };
  return source;
};
const alice = principalFor(ALICE);

describe('signal bots', () => {
  it('refuses a listing not bought, by market.access_required, and writes nothing', async () => {
    const bots = new SignalBots(db.sql, access({ access: false, title: 'TEST signal' }), '100');
    await expect(bots.create(alice, { listingId: LISTING, clientBotId: 'k1' })).rejects.toMatchObject({
      code: 'market.access_required',
      status: 403,
    });
    expect(await bots.list(alice)).toEqual([]);
  });

  it('fails closed when access cannot be read, and on an unknown listing', async () => {
    const down: SignalAccessSource = {
      access: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    await expect(new SignalBots(db.sql, down, '100').create(alice, { listingId: LISTING, clientBotId: 'k1' })).rejects.toMatchObject({
      code: 'trade.signal_access_unavailable',
    });
    await expect(
      new SignalBots(db.sql, access(null), '100').create(alice, { listingId: LISTING, clientBotId: 'k1' }),
    ).rejects.toMatchObject({
      code: 'trade.signal_listing_not_found',
    });
    expect(await new SignalBots(db.sql, access(null), '100').list(alice)).toEqual([]);
  });

  it('refuses every create while the owner cap is blank, before asking for access', async () => {
    const source = access({ access: true, title: 'TEST signal' });
    await expect(new SignalBots(db.sql, source, null).create(alice, { listingId: LISTING, clientBotId: 'k1' })).rejects.toMatchObject({
      code: 'trade.signal_bot_cap_unset',
    });
    expect(source.calls).toBe(0);
  });

  it('makes one bot per client bot id, awaiting its first signal, with the owner cap', async () => {
    const bots = new SignalBots(db.sql, access({ access: true, title: 'TEST signal' }), '100');
    const [a, b] = await Promise.all([
      bots.create(alice, { listingId: LISTING, clientBotId: 'k1' }),
      bots.create(alice, { listingId: LISTING, clientBotId: 'k1' }),
    ]);
    expect(b.botId).toBe(a.botId);
    expect(a).toMatchObject({ listingId: LISTING, title: 'TEST signal', state: 'awaiting_signal', cap: { amount: '100', asset: 'USDC' } });
    expect(await bots.list(alice)).toHaveLength(1);
    await expect(bots.create(alice, { listingId: OTHER, clientBotId: 'k1' })).rejects.toMatchObject({
      code: 'trade.signal_bot_key_conflict',
    });
    expect(await bots.list(principalFor(OTHER))).toEqual([]);
  });

  it('reads the cap as an amount above zero, or blank', () => {
    expect(parseSignalBotCap('')).toBeNull();
    expect(parseSignalBotCap(' 100 ')).toBe('100');
    expect(() => parseSignalBotCap('0')).toThrow(/TRADE_SIGNAL_BOT_CAP/);
    expect(() => parseSignalBotCap('ten')).toThrow(/TRADE_SIGNAL_BOT_CAP/);
  });
});

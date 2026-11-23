import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlAutoTopUpStore } from './auto-top-up-store.js';

// trade.user_venue_auto_top_up_* (J-derivatives-06 #4): a crossing is claimed once against both caps, a top-up's key is
// never reused, and a top-up row is never deleted and settles once.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The auto top-up store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111e6';
const VENUE = 'test-venue-sim';
const OWNER = '0x00000000000000000000000000000000000000e6';
const AGENT = '0x00000000000000000000000000000000000000a6';
const key = (symbol: string) => (n: number) => `margin:${OWNER}:${symbol.toLowerCase()}:auto:${n}`;

describe('SqlAutoTopUpStore on Postgres (trade.user_venue_auto_top_up_*)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('claims each crossing once, within the position cap and the permission cap shared by every position', async () => {
    const store = new SqlAutoTopUpStore(db!.sql);
    const at = new Date('2026-11-23T12:00:00Z');
    await store.createPermissionOnce({
      userId: USER,
      venueId: VENUE,
      owner: OWNER,
      agentAddress: AGENT,
      asset: 'USDC',
      cap: a('25'),
      createdAt: at,
    });
    // The permission's cap is set once.
    const again = await store.createPermissionOnce({
      userId: USER,
      venueId: VENUE,
      owner: OWNER,
      agentAddress: AGENT,
      asset: 'USDC',
      cap: a('999'),
      createdAt: at,
    });
    expect(again.cap).toBe(a('25'));

    const btc = await store.save({
      id: '0b0b0b0b-0000-4000-8000-0000000000e6',
      userId: USER,
      venueId: VENUE,
      owner: OWNER,
      symbol: 'BTC-PERP',
      triggerLevel: a('100'),
      amountEach: a('10'),
      cap: a('15'),
      at,
    });
    const eth = await store.save({
      id: '0e0e0e0e-0000-4000-8000-0000000000e6',
      userId: USER,
      venueId: VENUE,
      owner: OWNER,
      symbol: 'ETH-PERP',
      triggerLevel: a('50'),
      amountEach: a('10'),
      cap: a('100'),
      at,
    });
    expect(btc).toMatchObject({ enabled: true, run: 1, armed: true, nextSequence: 1, stopped: null });

    // Two claims of the same crossing at once: one top-up.
    const [x, y] = await Promise.all([
      store.claim({ settingId: btc.id, marginAt: a('99'), changeKeyOf: key('BTC-PERP'), at }),
      store.claim({ settingId: btc.id, marginAt: a('99'), changeKeyOf: key('BTC-PERP'), at }),
    ]);
    expect([x.kind, y.kind].sort()).toEqual(['claimed', 'none']);
    const first = x.kind === 'claimed' ? x.add : y.kind === 'claimed' ? y.add : null;
    expect(first).toMatchObject({ sequence: 1, changeKey: `margin:${OWNER}:btc-perp:auto:1`, state: 'sending', amount: a('10') });
    // Not armed again until the margin was read above the level.
    expect((await store.claim({ settingId: btc.id, marginAt: a('99'), changeKeyOf: key('BTC-PERP'), at })).kind).toBe('none');
    await store.setArmed(btc.id, true, at);
    // 10 added, and 10 more would pass the position's cap of 15.
    expect(await store.claim({ settingId: btc.id, marginAt: a('99'), changeKeyOf: key('BTC-PERP'), at })).toEqual({
      kind: 'stopped',
      reason: 'cap',
    });
    expect(await store.settingById(btc.id)).toMatchObject({ armed: false, stopped: 'cap', nextSequence: 2 });

    // ETH: 10 more is 20 under the permission's 25; then 30 would pass it.
    expect((await store.claim({ settingId: eth.id, marginAt: a('49'), changeKeyOf: key('ETH-PERP'), at })).kind).toBe('claimed');
    await store.setArmed(eth.id, true, at);
    expect(await store.claim({ settingId: eth.id, marginAt: a('49'), changeKeyOf: key('ETH-PERP'), at })).toEqual({
      kind: 'stopped',
      reason: 'permission_cap',
    });
    expect(await store.used({ userId: USER, venueId: VENUE, owner: OWNER, agentAddress: AGENT })).toBe(a('20'));

    // A refused top-up moved nothing and stops counting; a settled row settles once and is never deleted.
    expect(await store.settle({ settingId: btc.id, sequence: 1, state: 'refused', refusal: 'TEST: the venue refused it', at })).toBe(true);
    expect(await store.settle({ settingId: btc.id, sequence: 1, state: 'added', refusal: null, at })).toBe(false);
    expect(await store.used({ userId: USER, venueId: VENUE, owner: OWNER, agentAddress: AGENT })).toBe(a('10'));
    await expect(db!.sql`DELETE FROM trade.user_venue_auto_top_up_adds WHERE setting_id = ${btc.id}`).rejects.toThrow(/never deleted/);

    // Off, then on again: a new run whose cap counts afresh, armed, and the next key is 2, never 1 again.
    await store.turnOff(btc.id, at);
    expect(await store.enabled()).toHaveLength(1);
    const on = await store.save({
      id: 'ffffffff-0000-4000-8000-0000000000e6',
      userId: USER,
      venueId: VENUE,
      owner: OWNER,
      symbol: 'BTC-PERP',
      triggerLevel: a('100'),
      amountEach: a('10'),
      cap: a('15'),
      at,
    });
    expect(on).toMatchObject({ id: btc.id, run: 2, armed: true, stopped: null, nextSequence: 2 });
    const next = await store.claim({ settingId: btc.id, marginAt: a('99'), changeKeyOf: key('BTC-PERP'), at });
    expect(next).toMatchObject({ kind: 'claimed', add: { sequence: 2, run: 2, changeKey: `margin:${OWNER}:btc-perp:auto:2` } });
    expect((await store.adds(btc.id)).map((r) => [r.sequence, r.state])).toEqual([
      [1, 'refused'],
      [2, 'sending'],
    ]);
  });
});

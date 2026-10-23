/**
 * Start copying (CB-copy-03, CB-copy-04; J-copy-bots-otc-01 #5 and #7): who may follow, the fixed amount, the reserve
 * held from the follower's own free spot balance, and the same request returning the same follow. Every refusal is
 * checked to write nothing; the reserve is checked to post nothing to the ledger.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyTestAdmission } from '../controls/test-admission.js';
import { CopyService } from './copy-service.js';
import type { CopyDisclosureLaw } from './disclosure.js';
import { CopyError } from './errors.js';
import { assertMayFollow, assertReserveFits, copyFollowIdFor, copyQuoteAsset, parseCopyMinTier } from './follow-gate.js';
import { MemoryCopyFollowStore, SqlCopyFollowStore, type CopyFollowStore } from './follow-store.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const FOLLOWER = '00000000-0000-4000-8000-0000000000f1';
const LEADER = '00000000-0000-4000-8000-0000000000c1';
const LEADER_2 = '00000000-0000-4000-8000-0000000000c2';
const SESSION = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date('2026-10-23T00:00:00.000Z');
const LAW: CopyDisclosureLaw = { published: true, version: 'TEST-v1', text: 'TEST disclosure' };
const fee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 1000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 0,
  decayShareBps: 1000,
};
const jur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  } as Principal;
}

const input = (over: Record<string, unknown> = {}) => ({
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC/USDT'],
  maxNotionalPerOrder: '100',
  maxAggregateExposure: '500',
  fixedOrderSize: '25',
  expiresAt: '2026-12-01T00:00:00.000Z',
  clientRequestId: 'start-copy-0001',
  ...over,
});

async function setup(
  opts: { store?: CopyFollowStore; minTier?: 'basic' | 'full' | null; usdt?: string; disclosure?: CopyDisclosureLaw } = {},
) {
  const ledger = new MemoryLedger();
  if (opts.usdt) {
    await ledger.post(
      recipes.deposit({ userId: FOLLOWER, assetId: 'USDT', amount: parseAmount(opts.usdt), rail: 'test', railRef: 'gate-fund' }),
    );
  }
  const store = opts.store ?? new MemoryCopyFollowStore();
  const copy = new CopyService(ledger, {
    accountAdmission: readyTestAdmission(),
    feeShareLaw: fee,
    jurisdictionLaw: jur,
    disclosureLaw: opts.disclosure ?? LAW,
    minTier: opts.minTier === undefined ? 'full' : opts.minTier,
    store,
    now: () => NOW,
  });
  return { copy, ledger, store };
}

async function accepted(copy: CopyService, p = principal()) {
  await copy.acceptDisclosure(p, { version: 'TEST-v1', clientAcceptId: 'accept-gate' });
}

async function refusedWithNothingWritten(ctx: Awaited<ReturnType<typeof setup>>, run: () => Promise<unknown>, code: string): Promise<void> {
  const journalBefore = (await ctx.ledger.balances('user', FOLLOWER)).map((b) => `${b.accountId}:${b.amount}`);
  await expect(run()).rejects.toMatchObject({ code });
  expect(await ctx.store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  expect(await ctx.store.sumHeldReserves(FOLLOWER, 'USDT')).toBe(0n);
  expect((await ctx.ledger.balances('user', FOLLOWER)).map((b) => `${b.accountId}:${b.amount}`)).toEqual(journalBefore);
}

describe('who may start copying', () => {
  it('refuses a tier below the owner level before anything is written', async () => {
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy, principal({ tier: 'basic' }));
    await refusedWithNothingWritten(ctx, () => ctx.copy.startFollow(principal({ tier: 'basic' }), input()), 'trade.tier_insufficient');
    await refusedWithNothingWritten(ctx, () => ctx.copy.startFollow(principal({ tier: 'none' }), input()), 'trade.tier_insufficient');
  });

  it('refuses every follow while the owner has set no copy tier', async () => {
    const ctx = await setup({ usdt: '1000', minTier: null });
    await accepted(ctx.copy);
    await refusedWithNothingWritten(
      ctx,
      () => ctx.copy.startFollow(principal({ tier: 'institutional' }), input()),
      'trade.copy_tier_unset',
    );
  });

  it('refuses a sub-account', async () => {
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy);
    const sub = principal({ sub_account: '00000000-0000-4000-8000-0000000000e1' } as Partial<Principal>);
    await refusedWithNothingWritten(ctx, () => ctx.copy.startFollow(sub, input()), 'trade.copy_subaccount_refused');
  });

  it('refuses every follow while the country list is blank, and a country off the list', async () => {
    const ledger = new MemoryLedger();
    const blank = new CopyService(ledger, {
      accountAdmission: readyTestAdmission(),
      feeShareLaw: fee,
      jurisdictionLaw: { published: false },
      disclosureLaw: LAW,
      minTier: 'full',
    });
    await expect(blank.startFollow(principal(), input())).rejects.toMatchObject({ code: 'trade.copy_jurisdiction_blank' });
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy);
    await refusedWithNothingWritten(
      ctx,
      () => ctx.copy.startFollow(principal(), input({ region: 'US' })),
      'trade.copy_jurisdiction_blocked',
    );
  });

  it('refuses until the current disclosure is accepted, and while none is published', async () => {
    const ctx = await setup({ usdt: '1000' });
    await refusedWithNothingWritten(ctx, () => ctx.copy.startFollow(principal(), input()), 'trade.copy_disclosure_required');
    const unpublished = await setup({ usdt: '1000', disclosure: { published: false } });
    await refusedWithNothingWritten(
      unpublished,
      () => unpublished.copy.startFollow(principal(), input()),
      'trade.copy_disclosure_unpublished',
    );
  });
});

describe('the fixed amount and the reserve', () => {
  it('refuses a zero fixed amount and one above the per-order cap, naming the cap', async () => {
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy);
    await refusedWithNothingWritten(
      ctx,
      () => ctx.copy.startFollow(principal(), input({ fixedOrderSize: '0' })),
      'trade.copy_envelope_invalid',
    );
    await expect(ctx.copy.startFollow(principal(), input({ fixedOrderSize: '100.01' }))).rejects.toThrow(/most per order, 100/);
    await refusedWithNothingWritten(
      ctx,
      () => ctx.copy.startFollow(principal(), input({ fixedOrderSize: '100.01' })),
      'trade.copy_fixed_size_above_cap',
    );
  });

  it('stores no fixed size when none is given', async () => {
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy);
    const follow = await ctx.copy.startFollow(principal(), input({ fixedOrderSize: undefined }));
    expect(follow.fixedOrderSize).toBeNull();
  });

  it('refuses a reserve above the free balance, counting what other follows already reserve', async () => {
    const ctx = await setup({ usdt: '700' });
    await accepted(ctx.copy);
    await refusedWithNothingWritten(
      ctx,
      () => ctx.copy.startFollow(principal(), input({ maxAggregateExposure: '700.01' })),
      'trade.copy_reserve_exceeds_balance',
    );
    await ctx.copy.startFollow(principal(), input());
    await expect(
      ctx.copy.startFollow(principal(), input({ leaderId: LEADER_2, clientRequestId: 'start-copy-0002', maxAggregateExposure: '300' })),
    ).rejects.toMatchObject({ code: 'trade.copy_reserve_exceeds_balance', message: expect.stringContaining('200 USDT is free') });
    expect(await ctx.store.listFollowsByFollower(FOLLOWER)).toHaveLength(1);
  });

  it('holds one reserve per follow, posts nothing, and a second press with the same key returns the same follow', async () => {
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy);
    const before = await ctx.ledger.balances('user', FOLLOWER);
    const first = await ctx.copy.startFollow(principal(), input());
    const again = await ctx.copy.startFollow(principal(), input());
    expect(again.followId).toBe(first.followId);
    expect(first).toMatchObject({ fixedOrderSize: '25', reserve: { asset: 'USDT', amount: '500', released: false } });
    expect(await ctx.store.listFollowsByFollower(FOLLOWER)).toHaveLength(1);
    expect(await ctx.store.sumHeldReserves(FOLLOWER, 'USDT')).toBe(parseAmount('500'));
    // The reserve is a limit row: the follower's ledger balance is exactly what it was.
    expect(await ctx.ledger.balances('user', FOLLOWER)).toEqual(before);
    // A different request key for the same leader is a second follow, which is refused as one.
    await expect(ctx.copy.startFollow(principal(), input({ clientRequestId: 'start-copy-0003' }))).rejects.toMatchObject({
      code: 'trade.copy_already_following',
    });
  });

  it('releases the reserve when the follow is detached or removed, and posts nothing', async () => {
    const ctx = await setup({ usdt: '1000' });
    await accepted(ctx.copy);
    const before = await ctx.ledger.balances('user', FOLLOWER);
    const first = await ctx.copy.startFollow(principal(), input());
    await ctx.copy.detach(principal(), { followId: first.followId });
    expect(await ctx.store.sumHeldReserves(FOLLOWER, 'USDT')).toBe(0n);
    const second = await ctx.copy.startFollow(principal(), input({ leaderId: LEADER_2, clientRequestId: 'start-copy-0004' }));
    expect(await ctx.store.sumHeldReserves(FOLLOWER, 'USDT')).toBe(parseAmount('500'));
    await ctx.copy.unfollow(principal(), { followId: second.followId });
    expect(await ctx.store.sumHeldReserves(FOLLOWER, 'USDT')).toBe(0n);
    expect(await ctx.ledger.balances('user', FOLLOWER)).toEqual(before);
  });
});

describe('follow-gate helpers', () => {
  it('parses the owner tier and refuses anything else', () => {
    expect(parseCopyMinTier('')).toBeNull();
    expect(parseCopyMinTier(' full ')).toBe('full');
    expect(() => parseCopyMinTier('none')).toThrow(/TRADE_COPY_MIN_TIER/);
  });

  it('derives a stable UUID-shaped follow id per follower, leader and key, and refuses a bad key', () => {
    const id = copyFollowIdFor(FOLLOWER, LEADER, 'start-copy-0001');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(copyFollowIdFor(FOLLOWER, LEADER, 'start-copy-0001')).toBe(id);
    expect(copyFollowIdFor(FOLLOWER, LEADER_2, 'start-copy-0001')).not.toBe(id);
    expect(() => copyFollowIdFor(FOLLOWER, LEADER, 'short')).toThrow(CopyError);
  });

  it('needs one quote asset across the markets', () => {
    expect(copyQuoteAsset(['BTC/USDT', 'ETH-USDT'])).toBe('USDT');
    expect(() => copyQuoteAsset(['BTC/USDT', 'BTC/EUR'])).toThrow(expect.objectContaining({ code: 'trade.copy_market_quote_mixed' }));
  });

  it('allows exactly what is free after other reserves', () => {
    expect(() => assertReserveFits({ amount: 50n, free: 100n, reservedElsewhere: 50n, asset: 'USDT' })).not.toThrow();
    expect(() => assertReserveFits({ amount: 51n, free: 100n, reservedElsewhere: 50n, asset: 'USDT' })).toThrow(CopyError);
    expect(() => assertMayFollow({ tier: 'full', sub_account: undefined }, 'full')).not.toThrow();
  });
});

describe('the reserve row on Postgres', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. The copy reserve test does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'trade', url: url.toString(), migrations });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('writes one row under copy.reserve:<followId> with the follow, survives a new store, and is released, not deleted', async () => {
    const ctx = await setup({ usdt: '1000', store: new SqlCopyFollowStore(db!.sql) });
    await accepted(ctx.copy);
    const first = await ctx.copy.startFollow(principal(), input());
    const again = await ctx.copy.startFollow(principal(), input());
    expect(again.followId).toBe(first.followId);

    const rows = await db!.sql<Array<{ reserve_key: string; amount: string; released_at: Date | null }>>`
      SELECT reserve_key, amount::text AS amount, released_at FROM copy_follow_reserves WHERE follower_id = ${FOLLOWER}
    `;
    expect(rows).toEqual([{ reserve_key: `copy.reserve:${first.followId}`, amount: '500.000000000000000000', released_at: null }]);
    const restarted = new SqlCopyFollowStore(db!.sql);
    expect((await restarted.getFollow(first.followId))?.envelope.fixedOrderSize).toBe(parseAmount('25'));
    expect(await restarted.sumHeldReserves(FOLLOWER, 'USDT')).toBe(parseAmount('500'));

    await ctx.copy.unfollow(principal(), { followId: first.followId });
    const after = await db!.sql<Array<{ released: boolean }>>`
      SELECT released_at IS NOT NULL AS released FROM copy_follow_reserves WHERE follower_id = ${FOLLOWER}
    `;
    expect(after).toEqual([{ released: true }]);
    expect(await restarted.sumHeldReserves(FOLLOWER, 'USDT')).toBe(0n);
  });

  it('refuses a fixed size above the per-order cap in the table itself', async () => {
    await expect(db!.sql`
      INSERT INTO copy_follows (follow_id, follower_id, leader_id, region, permitted_markets, max_notional_per_order,
                                max_aggregate_exposure, expires_at, fixed_order_size)
      VALUES ('cap-check', ${FOLLOWER}, ${LEADER}, 'SG', '[]'::jsonb, 10, 100, now() + interval '1 day', 11)
    `).rejects.toThrow(/copy_follows_fixed_order_size_ck/);
  });
});

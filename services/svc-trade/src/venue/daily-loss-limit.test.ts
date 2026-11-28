import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { type PlaceUserOrderIntent, type PreparedVenueAction } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError, type BuilderFeeValue } from './user-venue-door.js';
import { DailyLossGuard, LOOSENING_WAIT_MS, VenueDailyLossLimits, changed, inForce, loosens } from './daily-loss-limit.js';
import { InMemoryDailyLossLimitStore, type DailyLossRecord } from './daily-loss-limit-store.js';

// The person's opt-in daily loss limit on their own venue account: advisory warns, blocking refuses a new
// opening order once today's realised loss reaches the limit; a reduce-only exit always passes; a stricter change applies
// at once and a looser one only after 24 hours. Against the TEST venue simulator over loopback HTTP. Every figure is TEST.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111d1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333d1',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade daily loss limit')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b9', feeBps: a('1') };

let n = 0;
const order = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'ETH-PERP',
  side: 'buy',
  type: 'limit',
  amount: a('0.1'),
  price: a('2000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:dl-${++n}`,
  builderFee: null,
  ...over,
});

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Today's count on a view that read the venue (every read here but the desk's `terms` read of a limit never set). */
function todayOf(view: { today: { loss: string | null; since: string; asOf: string | null; resetsAt: string; reached: boolean } | null }) {
  if (!view.today) throw new Error('the view counted no loss: only a terms read of a limit never set has none');
  return view.today;
}

describe('the daily loss limit rules', () => {
  const T0 = new Date('2026-11-27T10:00:00Z');
  const rec = (active: DailyLossRecord['active']): DailyLossRecord => ({
    userId: USER,
    venueId: 'v',
    owner,
    asset: 'USDC',
    active,
    pending: null,
    createdAt: T0,
    updatedAt: T0,
  });
  const adv = (limit: string) => ({ mode: 'advisory' as const, limit: a(limit) });
  const blk = (limit: string) => ({ mode: 'blocking' as const, limit: a(limit) });

  it('turning it on, a lower limit and advisory to blocking are stricter; a higher limit, blocking to advisory and off are looser', () => {
    expect(loosens(null, adv('100'))).toBe(false);
    expect(loosens(adv('100'), adv('50'))).toBe(false);
    expect(loosens(adv('100'), blk('100'))).toBe(false);
    expect(loosens(adv('100'), adv('100'))).toBe(false);
    expect(loosens(adv('100'), adv('150'))).toBe(true);
    expect(loosens(blk('100'), adv('100'))).toBe(true);
    expect(loosens(adv('100'), null)).toBe(true);
    // Partly looser is looser: a lower limit that also drops blocking waits.
    expect(loosens(blk('100'), adv('50'))).toBe(true);
  });

  it('a tightening applies at once; a loosening waits exactly 24 hours, then applies', () => {
    const on = changed(rec(null), blk('100'), T0);
    expect(on.active).toEqual(blk('100'));
    expect(on.pending).toBeNull();

    const looser = changed(on, adv('300'), T0);
    expect(looser.active).toEqual(blk('100'));
    expect(looser.pending).toEqual({ terms: adv('300'), effectiveAt: new Date(T0.getTime() + LOOSENING_WAIT_MS) });
    expect(inForce(looser, new Date(T0.getTime() + LOOSENING_WAIT_MS - 1)).active).toEqual(blk('100'));
    expect(inForce(looser, new Date(T0.getTime() + LOOSENING_WAIT_MS))).toMatchObject({ active: adv('300'), pending: null });

    const off = changed(on, null, T0);
    expect(off.active).toEqual(blk('100'));
    expect(inForce(off, new Date(T0.getTime() + LOOSENING_WAIT_MS)).active).toBeNull();
  });

  it('a tightening while a loosening waits applies at once and drops it; asking for the terms in force cancels it', () => {
    const waiting = changed(changed(rec(null), adv('100'), T0), adv('500'), T0);
    const later = new Date(T0.getTime() + 60_000);
    expect(changed(waiting, blk('80'), later)).toMatchObject({ active: blk('80'), pending: null });
    expect(changed(waiting, adv('100'), later)).toMatchObject({ active: adv('100'), pending: null });
    // A second loosening restarts the wait from when it was asked.
    expect(changed(waiting, adv('600'), later).pending?.effectiveAt).toEqual(new Date(later.getTime() + LOOSENING_WAIT_MS));
  });
});

describe('the daily loss limit at the door, on the TEST venue', { timeout: 60_000 }, () => {
  let venue: { server: http.Server; sim: TestVenueSimulator; url: string };
  let d: UserVenueDoor;
  let limits: VenueDailyLossLimits;
  // One clock for the door and the TEST venue, starting at 01:00 UTC on a fixed day, so "today" never depends on when
  // the run happens; `at` moves it, and real time still runs on from there.
  const DAY1 = Date.parse('2026-11-27T01:00:00Z');
  let offset = DAY1 - Date.now();
  const now = () => new Date(Date.now() + offset);
  const at = (t: number) => {
    offset = t - Date.now();
  };
  const store = new InMemoryDailyLossLimitStore();
  const actions = new InMemoryPreparedActionStore();
  const account = () => ({ venueId: venue.sim.venue.id, owner, subAccount: null });

  async function run(intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey?: string) {
    const prepared = await d.prepare(principal, { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
    return d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
  }
  const prepare = (intent: PlaceUserOrderIntent) => d.prepare(principal, { owner, signer, intent });
  const refusalOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => {
        if (e instanceof UserVenueDoorError) return { code: e.code, status: e.status, message: e.message };
        throw e;
      },
    );

  beforeAll(async () => {
    venue = await startTestVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      chainId: 84532,
      ordersPerAction: 10,
      clock: now,
    });
    await seedTestVenue(venue.sim);
    venue.sim.deposit(account(), 'USDC', a('100000'), 'deposit:test:daily-loss');
    d = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: venue.url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: actions,
      stepUp: noStepUp,
      builder: BUILDER,
      now,
      listings: new StoreVenueRoutingGate(listedTestStore(['ETH-PERP'])),
      slippageCapBps: 1000,
      closeSlippageBps: 1000,
      dailyLoss: new DailyLossGuard({ store, now }),
    });
    limits = new VenueDailyLossLimits({ door: d, store, now });
    await run({ kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') }, `builder:${owner}:dl`);
    await run({ kind: 'update_leverage', symbol: 'ETH-PERP', leverageBps: 50_000, marginMode: 'isolated' }, `leverage:${owner}:dl`);
    // TEST: a long of 1 ETH-PERP bought at the TEST book's 3001, then half of it sold at its 2999: a realised loss of 1
    // USDC plus fees, on the venue's own fills. Half stays open, for the reduce-only exits below.
    const entry = order({ type: 'market', timeInForce: 'IOC', amount: a('1'), price: a('3100') });
    expect((await run(entry)).outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
    const half = order({ side: 'sell', type: 'market', timeInForce: 'IOC', amount: a('0.5'), price: a('2700'), reduceOnly: true });
    expect((await run(half)).outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
  });
  afterAll(async () => closeServer(venue.server));

  it("reads today's realised loss from the venue's own fills", async () => {
    const view = await limits.get(principal, owner);
    expect(view.asset).toBe('USDC');
    expect(view.active).toBeNull();
    // TEST: the venue's realised -1 on the half closed, plus its fees and our builder fee on both fills.
    expect(view.today).toMatchObject({ loss: '3.475275', reached: false });
    // The venue's as-of time for the fills it was counted from, and the next 00:00 UTC, when the count starts again.
    expect(todayOf(view).asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(todayOf(view).resetsAt).toBe(new Date(Date.parse(todayOf(view).since) + 86_400_000).toISOString());
  });

  it("the desk's terms read of an account that never set a limit asks the venue nothing", async () => {
    const venueNow = await d.venue();
    const markets = vi.spyOn(venueNow, 'markets');
    const fills = vi.spyOn(venueNow, 'fills');
    try {
      expect(await limits.get(principal, owner, { terms: true })).toMatchObject({
        owner,
        asset: null,
        active: null,
        pending: null,
        today: null,
      });
      expect(markets).not.toHaveBeenCalled();
      expect(fills).not.toHaveBeenCalled();
    } finally {
      markets.mockRestore();
      fills.mockRestore();
    }
  });

  it('off (the default), an opening order is prepared with no warning', async () => {
    const answer = await prepare(order());
    expect(answer.warnings).toBeUndefined();
  });

  it('below the limit, an opening order is prepared with no warning', async () => {
    const view = await limits.set(principal, { owner, limit: '1000', mode: 'blocking' });
    expect(view).toMatchObject({ active: { mode: 'blocking', limit: '1000' }, pending: null, today: { reached: false } });
    expect((await prepare(order())).warnings).toBeUndefined();
  });

  it('blocking, at the limit: a new opening order is refused before anything is prepared; a reduce-only exit passes', async () => {
    // Lowering 1000 to 3 is stricter: it applies at once.
    const view = await limits.set(principal, { owner, limit: '3', mode: 'blocking' });
    expect(view).toMatchObject({ active: { mode: 'blocking', limit: '3' }, pending: null, today: { reached: true } });
    const opening = order();
    const refused = await refusalOf(prepare(opening));
    expect(refused).toMatchObject({ code: 'trade.daily_loss_limit_reached', status: 422 });
    expect(refused!.message).toContain('reaching your daily loss limit of 3 USDC');
    expect(refused!.message).toContain('reduce-only orders that close a position still go through');
    expect(refused!.message).toContain(`until the day resets at ${todayOf(view).resetsAt} (00:00 UTC); nothing was sent`);
    expect(await actions.find(USER, opening.clientOrderKey)).toBeNull();
    // The other side of an open position is refused too unless it is reduce-only.
    expect(await refusalOf(prepare(order({ side: 'sell', price: a('3500') })))).toMatchObject({ code: 'trade.daily_loss_limit_reached' });
    // A reduce-only close at the limit passes, with no warning, and the venue takes it.
    const exit = order({ side: 'sell', type: 'market', timeInForce: 'IOC', amount: a('0.2'), price: a('2700'), reduceOnly: true });
    const answer = await prepare(exit);
    expect(answer.warnings).toBeUndefined();
    const sent = await d.submit(principal, answer.actionKey, await sign(answer.prepared));
    expect(sent.outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
  });

  it('blocking to advisory waits 24 hours: still refused a second before, warned (not refused) once the 24 hours are up', async () => {
    const asked = now().getTime();
    const view = await limits.set(principal, { owner, limit: '3', mode: 'advisory' });
    const answered = now().getTime();
    expect(view).toMatchObject({ active: { mode: 'blocking', limit: '3' }, pending: { terms: { mode: 'advisory', limit: '3' } } });
    // 24 hours from when the service took the ask: the real clock runs while it answers, so the time is read from it.
    const due = Date.parse(view.pending!.effectiveAt);
    expect(due).toBeGreaterThanOrEqual(asked + LOOSENING_WAIT_MS);
    expect(due).toBeLessThanOrEqual(answered + LOOSENING_WAIT_MS);
    // The next UTC day, a minute before the 24 hours are up: today's loss starts at zero, so an opening order passes.
    // TEST: 1 ETH-PERP bought at 3001 and all 1.3 held sold reduce-only at 2999, a loss past the limit of 3 again.
    at(due - 60_000);
    expect((await limits.get(principal, owner)).today).toMatchObject({ loss: '0', reached: false });
    const buy = order({ type: 'market', timeInForce: 'IOC', amount: a('1'), price: a('3100') });
    expect((await run(buy)).outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
    const sell = order({ side: 'sell', type: 'market', timeInForce: 'IOC', amount: a('1.3'), price: a('2700'), reduceOnly: true });
    expect((await run(sell)).outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
    expect(todayOf(await limits.get(principal, owner)).reached).toBe(true);
    // A second before the 24 hours are up, blocking still holds.
    at(due - 1000);
    expect(await refusalOf(prepare(order()))).toMatchObject({ code: 'trade.daily_loss_limit_reached' });
    at(due);
    const later = await limits.get(principal, owner);
    expect(later).toMatchObject({ active: { mode: 'advisory', limit: '3' }, pending: null, today: { reached: true } });
    const answer = await prepare(order());
    expect(answer.warnings).toEqual([
      expect.objectContaining({ code: 'trade.daily_loss_limit_reached', asset: 'USDC', limit: '3', loss: todayOf(later).loss }),
    ]);
    expect(answer.warnings![0]!.message).toContain('reaching your daily loss limit of 3 USDC');
    // Advisory never stops the order: it is prepared, and the venue takes it.
    const sent = await d.submit(principal, answer.actionKey, await sign(answer.prepared));
    expect(sent.outcome).toMatchObject({ accepted: true });
  });

  it('turning it off waits 24 hours too; a blocking limit whose loss cannot be read refuses an opening order (fail closed)', async () => {
    // Its own store, so this case starts from no limit whatever ran before it.
    const own = new InMemoryDailyLossLimitStore();
    const mine = new VenueDailyLossLimits({ door: d, store: own, now });
    expect(await mine.set(principal, { owner, limit: '50' })).toMatchObject({ active: { mode: 'advisory', limit: '50' }, pending: null });
    const off = await mine.off(principal, owner);
    expect(off).toMatchObject({ active: { mode: 'advisory' }, pending: { terms: null } });
    // Tightening back to blocking applies at once and drops the waiting off.
    expect(await mine.set(principal, { owner, limit: '50', mode: 'blocking' })).toMatchObject({
      active: { mode: 'blocking', limit: '50' },
      pending: null,
    });
    const guard = new DailyLossGuard({ store: own, now });
    const v = await d.venue();
    const unreadable = { ...v, fills: async () => Promise.reject(new Error('TEST venue down')) } as typeof v;
    const refused = await refusalOf(
      guard.admit({ principal, venue: unreadable, account: account(), intent: order(), kindOf: async () => 'perpetual' }),
    );
    expect(refused).toMatchObject({ code: 'trade.daily_loss_unreadable', status: 503 });
    // A reduce-only exit is never held, even then: the fills are not read at all.
    expect(
      await guard.admit({
        principal,
        venue: unreadable,
        account: account(),
        intent: order({ side: 'sell', reduceOnly: true }),
        kindOf: async () => 'perpetual',
      }),
    ).toEqual([]);
  });
});

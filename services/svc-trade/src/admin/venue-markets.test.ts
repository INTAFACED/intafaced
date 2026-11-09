/**
 * J-cex-spot-16: the venue markets desk and the user-venue door it governs, against the TEST venue simulator in process.
 * Two operators list a venue market before it shows (a blank opening window refuses), set our routing state and a stop,
 * our largest routed order (never above the venue's, a blank refused by name) and a delisting with one dated notice.
 * Every refusal branch is here, and the invariant: no write cancels an order, touches an open venue order or reaches the
 * ledger (nothing on this path imports a ledger write).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, UserVenue, VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, seedTestVenue, type TestVenueTypedData } from '@intafaced/venue-sim';
import { principalFor } from '../spot/testing.js';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from '../venue/user-venue-door.js';
import { MemoryVenueListingStore, delistingNoticeKey } from '../venue/venue-listing-store.js';
import {
  LOCAL_TEST_SEED_OPERATOR,
  StoreVenueRoutingGate,
  assertTestListingsAllowed,
  parseTestListings,
  seedTestListings,
  type VenueDelistingNotices,
} from '../venue/venue-listing.js';
import { MemoryApprovalBook } from './common.js';
import {
  VENUE_DELISTING_SCHEDULE_ACTION,
  VENUE_LIMITS_SET_ACTION,
  VENUE_LISTING_SET_ACTION,
  VENUE_ROUTING_SET_ACTION,
  VenueMarketsAdmin,
  canonicalVenueDecimal,
  canonicalVenueTime,
  venueDelistingPayloadHash,
  venueLimitsPayloadHash,
  venueLimitsTarget,
  venueListingPayloadHash,
  venueListingTarget,
  venueRoutingPayloadHash,
} from './venue-markets.js';

const a = parseAmount;
const VENUE = 'test-venue-sim';
const PROPOSER = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const writer = () => principalFor(PROPOSER, ['admin:read', 'admin:write']);
const reader = () => principalFor(PROPOSER, ['admin:read']);
const REASON = 'TEST: J-cex-spot-16 review';

const USER = '11111111-1111-4111-8111-1111111111c1';
const customer = { ...principalFor(USER, ['trade:read', 'trade:write']), sid: '33333333-3333-4333-8333-3333333333c3' } as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue markets desk')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') };

let n = 0;
const order = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'ETH-USDC',
  side: 'buy',
  type: 'limit',
  amount: a('1'),
  price: a('2000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${USER}:venue-desk:${(n += 1)}`,
  builderFee: null,
  ...over,
});

describe('venue markets desk (J-cex-spot-16)', () => {
  let now: Date;
  let sim: TestVenueSimulator;
  let store: MemoryVenueListingStore;
  let book: MemoryApprovalBook;
  let published: Array<{ noticeKey: string; symbol: string; delistsAt: Date }>;
  let busDown: boolean;
  let desk: VenueMarketsAdmin;
  let door: UserVenueDoor;
  let approvalSeq: number;

  beforeEach(async () => {
    now = new Date('2026-11-09T12:00:00.000Z');
    sim = new TestVenueSimulator({ clock: () => now, markets: TEST_VENUE_MARKETS, chainId: 84532 });
    await seedTestVenue(sim);
    sim.deposit({ venueId: VENUE, owner, subAccount: null }, 'USDC', a('10000000'), 'deposit:test:venue-desk');
    store = new MemoryVenueListingStore();
    book = new MemoryApprovalBook();
    published = [];
    busDown = false;
    approvalSeq = 0;
    const notices: VenueDelistingNotices = {
      async publish(x) {
        if (busDown) throw new Error('TEST bus down');
        published.push(x);
      },
    };
    desk = new VenueMarketsAdmin({ venue: async () => sim, store, approvals: book, notices, now: () => now });
    door = new UserVenueDoor({
      connect: async () => sim,
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
      builder: BUILDER,
      now: () => now,
      listings: new StoreVenueRoutingGate(store),
    });
    const approve = await door.prepare(customer, {
      owner,
      signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
      actionKey: `approve-builder:${USER}:venue-desk`,
    });
    expect((await door.submit(customer, approve.actionKey, await sign(approve.prepared))).outcome).toMatchObject({ accepted: true });
  });

  /** A second operator approved exactly this, as identity would hand it back. */
  function approved(actionType: string, targetId: string, expectedVersion: string, payloadHash: string, approverId = APPROVER) {
    const approvalId = `approval-${(approvalSeq += 1)}`;
    book.put({
      approvalId,
      actionType,
      targetService: 'svc-trade',
      targetId,
      expectedVersion,
      payloadHash,
      requesterId: PROPOSER,
      approverId,
      operationId: `op-${approvalId}`,
    });
    return { approvalId, operationId: `op-${approvalId}` };
  }

  async function list(symbol = 'ETH-USDC', opensAt = '2026-11-09T12:00:00.000Z', expectedVersion = '0') {
    const ids = approved(
      VENUE_LISTING_SET_ACTION,
      venueListingTarget(VENUE, symbol),
      expectedVersion,
      venueListingPayloadHash({ venueId: VENUE, symbol, opensAt, expectedVersion, reason: REASON }),
    );
    return desk.listingSet(writer(), { symbol, opensAt, expectedVersion, reason: REASON, ...ids });
  }
  async function route(routing: string, expectedVersion: string, symbol = 'ETH-USDC') {
    const ids = approved(
      VENUE_ROUTING_SET_ACTION,
      venueListingTarget(VENUE, symbol),
      expectedVersion,
      venueRoutingPayloadHash({ venueId: VENUE, symbol, routing, expectedVersion, reason: REASON }),
    );
    return desk.routingSet(writer(), { symbol, routing, expectedVersion, reason: REASON, ...ids });
  }
  async function limit(maxOrderQty: string, maxOrderNotional: string, expectedVersion = '0', symbol = 'ETH-USDC') {
    const ids = approved(
      VENUE_LIMITS_SET_ACTION,
      venueLimitsTarget(VENUE, symbol),
      expectedVersion,
      venueLimitsPayloadHash({
        venueId: VENUE,
        symbol,
        maxOrderQty: canonicalVenueDecimal(maxOrderQty),
        maxOrderNotional: canonicalVenueDecimal(maxOrderNotional),
        expectedVersion,
        reason: REASON,
      }),
    );
    return desk.limitsSet(writer(), { symbol, maxOrderQty, maxOrderNotional, expectedVersion, reason: REASON, ...ids });
  }
  async function delist(delistsAt: string, expectedVersion: string, symbol = 'ETH-USDC') {
    const ids = approved(
      VENUE_DELISTING_SCHEDULE_ACTION,
      venueListingTarget(VENUE, symbol),
      expectedVersion,
      venueDelistingPayloadHash({ venueId: VENUE, symbol, delistsAt, expectedVersion, reason: REASON }),
    );
    return desk.delistingSchedule(writer(), { symbol, delistsAt, expectedVersion, reason: REASON, ...ids });
  }
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'no refusal',
      (e: unknown) => (e as { code?: string }).code,
    );
  async function place(intent: PlaceUserOrderIntent) {
    const prepared = await door.prepare(customer, { owner, signer, intent });
    return door.submit(customer, prepared.actionKey, await sign(prepared.prepared));
  }
  async function cancel(symbol: string, clientOrderKey: string) {
    const intent: VenueIntent = { kind: 'cancel_order', symbol, clientOrderKey };
    const prepared = await door.prepare(customer, { owner, signer, intent });
    return door.submit(customer, prepared.actionKey, await sign(prepared.prepared));
  }
  const account = { venueId: VENUE, owner, subAccount: null };
  const openOrders = async () => (await sim.openOrders(account)).value.map((o) => [o.venueClientOrderId, o.status, o.remaining]);

  // ── #1 the listing ──────────────────────────────────────────────────────

  it('#1 shows a venue market only once a second operator approved its listing, with the venue state beside ours', async () => {
    const before = await desk.list(reader());
    expect(before).toMatchObject({ venueId: VENUE, test: true, label: 'TEST' });
    const eth = before.markets.find((m) => m.symbol === 'ETH-USDC')!;
    expect(eth).toMatchObject({
      listing: null,
      venue: { listed: true, status: 'trading', maxOrderQty: '500', maxOrderNotional: '2000000' },
    });
    expect((await door.markets()).value.map((m) => m.symbol)).toEqual([]);
    expect(await code(door.preview(customer, owner, order()))).toBe('trade.venue_market_not_listed');
    expect(await code(door.prepare(customer, { owner, signer, intent: order() }))).toBe('trade.venue_market_not_listed');

    const written = await list();
    expect(written.listing).toMatchObject({ version: 1, change: 'listing', routing: 'show', proposerId: PROPOSER, approverId: APPROVER });
    const shown = (await door.markets()).value;
    expect(shown.map((m) => m.symbol)).toEqual(['ETH-USDC']);
    expect(shown[0]).toMatchObject({
      status: 'trading',
      listing: { version: 1, routing: 'show', open: true, delisted: false, maxOrderQty: null },
    });
    const after = (await desk.list(reader())).markets.find((m) => m.symbol === 'ETH-USDC')!;
    expect(after.listingHistory).toHaveLength(1);
    expect(after.listing).toMatchObject({ approverId: APPROVER, open: true });
  });

  it('#1 a listing with a blank opening window is refused by name and writes nothing; the approval is not spent', async () => {
    for (const blank of [null, '', '   ']) {
      const ids = approved(VENUE_LISTING_SET_ACTION, venueListingTarget(VENUE, 'ETH-USDC'), '0', 'sha256:whatever');
      expect(
        await code(desk.listingSet(writer(), { symbol: 'ETH-USDC', opensAt: blank, expectedVersion: '0', reason: REASON, ...ids })),
      ).toBe('trade.venue_listing_opening_window_blank');
      // Still consumable: the refusal came before the approval.
      expect(
        (
          await book.consume({
            ...ids,
            actionType: VENUE_LISTING_SET_ACTION,
            targetId: venueListingTarget(VENUE, 'ETH-USDC'),
            expectedVersion: '0',
            payloadHash: 'sha256:whatever',
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await code(
        desk.listingSet(writer(), {
          symbol: 'ETH-USDC',
          opensAt: 'tomorrow',
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'x',
          operationId: 'y',
        }),
      ),
    ).toBe('trade.venue_listing_opening_window_invalid');
    expect(await store.listingVersions(VENUE)).toEqual([]);
    expect((await door.markets()).value).toEqual([]);
  });

  it('#1 refuses a market the venue does not list, an approval bound to anything else, a stale version, and a reader', async () => {
    expect(await code(list('SOL-USDC'))).toBe('trade.venue_market_unknown');
    const ids = approved(VENUE_LISTING_SET_ACTION, venueListingTarget(VENUE, 'ETH-USDC'), '0', 'sha256:other-payload');
    expect(
      await code(
        desk.listingSet(writer(), {
          symbol: 'ETH-USDC',
          opensAt: '2026-11-09T12:00:00.000Z',
          expectedVersion: '0',
          reason: REASON,
          ...ids,
        }),
      ),
    ).toBe('approval_mismatch');
    expect(
      await code(
        desk.listingSet(writer(), {
          symbol: 'ETH-USDC',
          opensAt: '2026-11-09T12:00:00.000Z',
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'none',
          operationId: 'op',
        }),
      ),
    ).toBe('approval_missing');
    expect(await store.listingVersions(VENUE)).toEqual([]);
    await list();
    expect(await code(list('ETH-USDC', '2026-11-10T00:00:00.000Z', '0'))).toBe('trade.venue_listing_stale');
    expect(
      await code(
        desk.listingSet(reader(), {
          symbol: 'ETH-USDC',
          opensAt: '2026-11-10T00:00:00.000Z',
          expectedVersion: '1',
          reason: REASON,
          approvalId: 'a',
          operationId: 'b',
        }),
      ),
    ).toBe('scope.denied');
  });

  it('#3 an approval the proposer approved themselves is never applied (identity refuses it action_approval.same_person first)', async () => {
    const opensAt = '2026-11-09T12:00:00.000Z';
    const ids = approved(
      VENUE_LISTING_SET_ACTION,
      venueListingTarget(VENUE, 'ETH-USDC'),
      '0',
      venueListingPayloadHash({ venueId: VENUE, symbol: 'ETH-USDC', opensAt, expectedVersion: '0', reason: REASON }),
      PROPOSER,
    );
    expect(await code(desk.listingSet(writer(), { symbol: 'ETH-USDC', opensAt, expectedVersion: '0', reason: REASON, ...ids }))).toBe(
      'approval_mismatch',
    );
    expect(await store.listingVersions(VENUE)).toEqual([]);
  });

  it('a retry of an approved write writes nothing new and answers the version it wrote; the same approval for another change refuses', async () => {
    const opensAt = '2026-11-09T12:00:00.000Z';
    const ids = approved(
      VENUE_LISTING_SET_ACTION,
      venueListingTarget(VENUE, 'ETH-USDC'),
      '0',
      venueListingPayloadHash({ venueId: VENUE, symbol: 'ETH-USDC', opensAt, expectedVersion: '0', reason: REASON }),
    );
    const first = await desk.listingSet(writer(), { symbol: 'ETH-USDC', opensAt, expectedVersion: '0', reason: REASON, ...ids });
    const again = await desk.listingSet(writer(), { symbol: 'ETH-USDC', opensAt, expectedVersion: '0', reason: REASON, ...ids });
    expect(again).toEqual(first);
    expect(await store.listingVersions(VENUE)).toHaveLength(1);
    expect(
      await code(
        desk.listingSet(writer(), {
          symbol: 'ETH-USDC',
          opensAt: '2026-11-11T00:00:00.000Z',
          expectedVersion: '0',
          reason: REASON,
          ...ids,
        }),
      ),
    ).toBe('approval_reused');
  });

  it('#1 a market opening later shows, and refuses orders until it opens', async () => {
    await list('ETH-USDC', '2026-11-10T00:00:00.000Z');
    expect((await door.markets()).value[0]!.listing).toMatchObject({ open: false });
    expect(await code(door.prepare(customer, { owner, signer, intent: order() }))).toBe('trade.venue_market_not_open');
    now = new Date('2026-11-10T00:00:01.000Z');
    expect(await place(order())).toMatchObject({ outcome: { definite: true, accepted: true } });
  });

  // ── #2 #4 routing ───────────────────────────────────────────────────────

  it('#2 a routing state needs a listing, a known state and a change; it shows once approved, with the venue state beside it', async () => {
    expect(await code(route('stop', '0'))).toBe('trade.venue_listing_missing');
    await list();
    expect(await code(route('paused', '1'))).toBe('trade.venue_routing_invalid');
    expect(await code(route('show', '1'))).toBe('trade.venue_routing_unchanged');
    expect(await code(route('stop', '0'))).toBe('trade.venue_listing_stale');
    const written = await route('close_only', '1');
    expect(written.listing).toMatchObject({
      version: 2,
      change: 'routing',
      routing: 'close_only',
      proposerId: PROPOSER,
      approverId: APPROVER,
    });
    sim.setMarketStatus('ETH-USDC', 'halted');
    expect((await door.markets()).value[0]).toMatchObject({ status: 'halted', listing: { routing: 'close_only' } });
    expect((await desk.list(reader())).markets.find((m) => m.symbol === 'ETH-USDC')).toMatchObject({
      venue: { status: 'halted' },
      listing: { routing: 'close_only', version: 2 },
    });
  });

  it('#4 stop routing: new orders refuse with our state, cancels still work, the in-flight order keeps its venue state; nothing is cancelled', async () => {
    await list();
    const resting = order({ price: a('1900'), amount: a('2') });
    expect(await place(resting)).toMatchObject({ outcome: { accepted: true, order: { status: 'open' } } });
    // Prepared while routing showed, sent after the stop: refused at first send, and nothing reaches the venue.
    const early = await door.prepare(customer, { owner, signer, intent: order({ price: a('1800') }) });
    const before = await openOrders();

    await route('stop', '1');
    expect(await openOrders()).toEqual(before);
    expect(await code(door.prepare(customer, { owner, signer, intent: order() }))).toBe('trade.venue_routing_stopped');
    expect(await code(door.preview(customer, owner, order()))).toBe('trade.venue_routing_stopped');
    expect(await code(door.prepare(customer, { owner, signer, intent: order({ reduceOnly: true }) }))).toBe('trade.venue_routing_stopped');
    expect(await code(door.submit(customer, early.actionKey, await sign(early.prepared)))).toBe('trade.venue_routing_stopped');
    expect(await openOrders()).toEqual(before);
    // The venue's own state beside ours, and the in-flight order as the venue has it.
    expect((await door.markets()).value[0]).toMatchObject({ status: 'trading', listing: { routing: 'stop' } });
    expect((await sim.orderByClientId(account, before[0]![0] as string)).value).toMatchObject({ status: 'open' });
    // Cancels are never checked against our state.
    expect(await cancel('ETH-USDC', resting.clientOrderKey)).toMatchObject({ outcome: { accepted: true, order: { status: 'canceled' } } });
  });

  it('#2 close-only routes reduce-only orders only', async () => {
    await list('BTC-PERP');
    await route('close_only', '1', 'BTC-PERP');
    const gate = new StoreVenueRoutingGate(store);
    const perp = order({ symbol: 'BTC-PERP', price: a('60000'), amount: a('0.1') });
    await expect(gate.admitPlace(VENUE, perp, now)).rejects.toMatchObject({ code: 'trade.venue_routing_close_only' });
    await expect(gate.admitPlace(VENUE, { ...perp, reduceOnly: true }, now)).resolves.toBeUndefined();
  });

  // ── #6 our routed-order limits ──────────────────────────────────────────

  it('#6 a limit edit refuses blank, inexact, above-the-venue, unknown-venue-max and stale values by name, before any approval is spent', async () => {
    expect(await code(limit('10', '10000'))).toBe('trade.venue_listing_missing');
    await list();
    for (const [qty, notional] of [
      ['', '1000'],
      ['10', ''],
    ]) {
      const ids = approved(VENUE_LIMITS_SET_ACTION, venueLimitsTarget(VENUE, 'ETH-USDC'), '0', 'sha256:x');
      expect(
        await code(
          desk.limitsSet(writer(), {
            symbol: 'ETH-USDC',
            maxOrderQty: qty!,
            maxOrderNotional: notional!,
            expectedVersion: '0',
            reason: REASON,
            ...ids,
          }),
        ),
      ).toBe('trade.venue_limit_blank');
    }
    expect(
      await code(
        desk.limitsSet(writer(), {
          symbol: 'ETH-USDC',
          maxOrderQty: null,
          maxOrderNotional: '1',
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'a',
          operationId: 'b',
        }),
      ),
    ).toBe('trade.venue_limit_blank');
    for (const bad of ['1e3', '-1', '0', '0.0', '1.0000000000000000001', '1,5']) {
      expect(await code(limit(bad, '1000'))).toBe('trade.venue_limit_not_exact');
    }
    expect(await code(limit('500.1', '1000'))).toBe('trade.venue_limit_above_venue');
    expect(await code(limit('10', '2000000.5'))).toBe('trade.venue_limit_above_venue');
    sim.setMarketLimits('ETH-USDC', { maxOrderQty: a('500'), maxOrderNotional: null });
    expect(await code(limit('10', '1000'))).toBe('trade.venue_limit_unknown');
    sim.setMarketLimits('ETH-USDC', { maxOrderQty: a('500'), maxOrderNotional: a('2000000') });
    expect(await code(limit('10', '1000', '1'))).toBe('trade.venue_limit_stale');
    expect(await store.limitVersions(VENUE)).toEqual([]);
  });

  it('#6 an approved limit records who approved it, refuses larger orders, and leaves open orders as they were', async () => {
    await list();
    // With no limit of ours written, orders pass on the venue's own largest order.
    expect(await place(order({ price: a('1500'), amount: a('20') }))).toMatchObject({
      outcome: { accepted: true, order: { status: 'open' } },
    });
    const before = await openOrders();
    const written = await limit('5.50', '15000');
    expect(written.limits).toMatchObject({
      version: 1,
      maxOrderQty: '5.5',
      maxOrderNotional: '15000',
      venueMaxOrderQtyAtWrite: '500',
      venueMaxOrderNotionalAtWrite: '2000000',
      proposerId: PROPOSER,
      approverId: APPROVER,
      executorId: PROPOSER,
    });
    expect(await openOrders()).toEqual(before);
    expect(await code(door.prepare(customer, { owner, signer, intent: order({ amount: a('6') }) }))).toBe('trade.venue_order_above_limit');
    expect(await code(door.prepare(customer, { owner, signer, intent: order({ amount: a('5'), price: a('3000.1') }) }))).toBe(
      'trade.venue_order_above_limit',
    );
    expect(await place(order({ amount: a('5'), price: a('1500') }))).toMatchObject({ outcome: { accepted: true } });
    expect((await door.markets()).value[0]!.listing).toMatchObject({ maxOrderQty: a('5.5'), maxOrderNotional: a('15000') });
    // A second version replaces it; the history keeps both, each with its approver.
    await limit('8', '20000', '1');
    const row = (await desk.list(reader())).markets.find((m) => m.symbol === 'ETH-USDC')!;
    expect(row.limitHistory.map((l) => [l.version, l.maxOrderQty, l.approverId])).toEqual([
      [1, '5.5', APPROVER],
      [2, '8', APPROVER],
    ]);
    // The oversized order placed before the limit is still open, as the venue has it.
    expect((await openOrders()).find((o) => o[0] === before[0]![0])).toEqual(before[0]);
  });

  // ── #8 delisting ────────────────────────────────────────────────────────

  it('#8 a delisting refuses blank, malformed and past dates; once approved customers get one dated notice, and opens refuse after the date', async () => {
    expect(await code(delist('2026-12-01T00:00:00.000Z', '0'))).toBe('trade.venue_listing_missing');
    await list();
    const ids = approved(VENUE_DELISTING_SCHEDULE_ACTION, venueListingTarget(VENUE, 'ETH-USDC'), '1', 'sha256:x');
    for (const blank of [null, '']) {
      expect(
        await code(
          desk.delistingSchedule(writer(), { symbol: 'ETH-USDC', delistsAt: blank, expectedVersion: '1', reason: REASON, ...ids }),
        ),
      ).toBe('trade.venue_delisting_date_blank');
    }
    expect(await code(delist('1 Dec', '1'))).toBe('trade.venue_delisting_date_invalid');
    expect(await code(delist('2026-11-09T11:00:00.000Z', '1'))).toBe('trade.venue_delisting_not_future');

    const resting = order({ price: a('1900'), amount: a('1') });
    await place(resting);
    const before = await openOrders();
    const delistsAt = '2026-12-01T00:00:00.000Z';
    const written = await delist(delistsAt, '1');
    expect(written.listing).toMatchObject({ version: 2, change: 'delisting', delistsAt, approverId: APPROVER });
    const key = delistingNoticeKey(VENUE, 'ETH-USDC', new Date(delistsAt));
    expect(published.map((p) => [p.noticeKey, p.symbol, p.delistsAt.toISOString()])).toEqual([[key, 'ETH-USDC', delistsAt]]);
    expect(written.delistingNotice).toMatchObject({ noticeKey: key, publishedAt: now.toISOString() });
    expect(await openOrders()).toEqual(before);
    // A replay, a read and a second schedule send nothing new.
    expect(await code(delist('2026-12-15T00:00:00.000Z', '2'))).toBe('trade.venue_delisting_already_scheduled');
    await desk.list(reader());
    expect(published).toHaveLength(1);

    // Before the date orders still route; after it only closing orders and cancels.
    expect(await place(order({ price: a('1800') }))).toMatchObject({ outcome: { accepted: true } });
    now = new Date('2026-12-01T00:00:00.000Z');
    expect(await code(door.prepare(customer, { owner, signer, intent: order() }))).toBe('trade.venue_market_delisted');
    expect((await door.markets()).value[0]!.listing).toMatchObject({ delisted: true, delistsAt: new Date(delistsAt) });
    expect(await cancel('ETH-USDC', resting.clientOrderKey)).toMatchObject({ outcome: { accepted: true } });
    await expect(new StoreVenueRoutingGate(store).admitPlace(VENUE, order({ reduceOnly: true }), now)).resolves.toBeUndefined();
  });

  it('#8 a notice the bus did not take stays pending and is sent once by the next run', async () => {
    await list();
    busDown = true;
    const written = await delist('2026-12-01T00:00:00.000Z', '1');
    expect(written.delistingNotice).toMatchObject({ publishedAt: null });
    expect(published).toEqual([]);
    busDown = false;
    await desk.list(reader());
    await desk.list(reader());
    expect(published).toHaveLength(1);
    expect((await store.pendingNotices(10)).length).toBe(0);
  });

  // ── the money invariant ─────────────────────────────────────────────────

  it('no write cancels an order or touches an open one, and nothing on this path imports a ledger write', async () => {
    await list();
    await place(order({ price: a('1700'), amount: a('3') }));
    const before = await openOrders();
    const balancesBefore = (await sim.balances(account)).value;
    await route('close_only', '1');
    await route('stop', '2');
    await limit('2', '4000');
    await route('show', '3');
    await delist('2026-12-01T00:00:00.000Z', '4');
    expect(await openOrders()).toEqual(before);
    expect((await sim.balances(account)).value).toEqual(balancesBefore);

    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['admin/venue-markets.ts', 'venue/venue-listing.ts', 'venue/venue-listing-store.ts']) {
      const src = readFileSync(join(here, '..', file), 'utf8');
      const imports = [...src.matchAll(/from '(@intafaced\/ledger-client[^']*)'/g)].map((m) => m[1]);
      expect(imports.every((i) => i === '@intafaced/ledger-client/money')).toBe(true);
      expect(src).not.toMatch(/recipes|ledger\.post|cancelOrder/);
    }
  });

  it('every door refuses trade.user_venue_off when the venue door is off', async () => {
    const off = new VenueMarketsAdmin({ venue: null, store, approvals: book, notices: { publish: async () => {} }, now: () => now });
    expect(await code(off.list(reader()))).toBe('trade.user_venue_off');
    expect(
      await code(
        off.listingSet(writer(), {
          symbol: 'ETH-USDC',
          opensAt: '2026-11-09T12:00:00.000Z',
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'a',
          operationId: 'b',
        }),
      ),
    ).toBe('trade.user_venue_off');
  });
});

describe('the approval hashes the console computes', () => {
  it('match apps/admin/src/lib/trade-ops/venue-markets-hash.test.ts, which pins the same four values', () => {
    const b = { venueId: VENUE, symbol: 'ETH-USDC', expectedVersion: '1', reason: 'TEST reason' };
    expect(venueListingPayloadHash({ ...b, opensAt: canonicalVenueTime('2026-11-09T20:00:00+08:00')! })).toBe(
      'sha256:e8d529fa1d849cf5f91827ce42dad8148253637ab42f6a8746804f13dbb82bb8',
    );
    expect(venueRoutingPayloadHash({ ...b, routing: 'stop' })).toBe(
      'sha256:cdd1279a90ea828669d27d13cb9b15f949e03e5799d900f914b0697d97e2986c',
    );
    expect(venueLimitsPayloadHash({ ...b, maxOrderQty: canonicalVenueDecimal('5.50'), maxOrderNotional: '15000' })).toBe(
      'sha256:435bd21d255c0c1612cc271ef29494226ef5477269261b2dd9f8cd979ab91923',
    );
    expect(venueDelistingPayloadHash({ ...b, delistsAt: canonicalVenueTime('2026-12-01T00:00:00Z')! })).toBe(
      'sha256:d592d613ecbdfaead7241fdb46479484f36bf6400debd4cc6c09c156916d23f1',
    );
  });
});

describe('the canonical forms every approval hash binds', () => {
  it('decimals keep one spelling, times one ISO form', () => {
    expect(canonicalVenueDecimal('5.50')).toBe('5.5');
    expect(canonicalVenueDecimal('5.000')).toBe('5');
    expect(canonicalVenueDecimal('15000')).toBe('15000');
    expect(canonicalVenueTime('2026-12-01T08:00:00+08:00')).toBe('2026-12-01T00:00:00.000Z');
    expect(canonicalVenueTime('2026-12-01')).toBeNull();
    expect(canonicalVenueTime('next week')).toBeNull();
  });
});

describe('the LOCAL TEST listing seed', () => {
  const sim = () => new TestVenueSimulator({ clock: () => new Date('2026-11-09T12:00:00.000Z'), markets: TEST_VENUE_MARKETS });
  const at = new Date('2026-11-09T12:00:00.000Z');

  it('lists exactly the named markets the venue lists, as LOCAL TEST seed, once', async () => {
    const store = new MemoryVenueListingStore();
    expect(await seedTestListings(store, sim(), parseTestListings('BTC-USDC,BTC-PERP,SOL-USDC'), 'dev', at)).toEqual([
      'BTC-USDC',
      'BTC-PERP',
    ]);
    expect(await seedTestListings(store, sim(), ['BTC-USDC', 'BTC-PERP'], 'test', at)).toEqual([]);
    const rows = await store.listingVersions(VENUE);
    expect(rows.map((r) => [r.symbol, r.version, r.routing, r.approvalId, r.proposerId])).toEqual([
      ['BTC-PERP', 1, 'show', `test-stack-listing:${VENUE}:BTC-PERP`, LOCAL_TEST_SEED_OPERATOR],
      ['BTC-USDC', 1, 'show', `test-stack-listing:${VENUE}:BTC-USDC`, LOCAL_TEST_SEED_OPERATOR],
    ]);
    expect(await store.latestListing(VENUE, 'ETH-USDC')).toBeNull();
  });

  it('is refused outside APP_ENV dev or test and on a venue that is not a TEST venue; blank lists nothing', async () => {
    for (const appEnv of [undefined, '', 'prod', 'staging', ' dev']) {
      expect(() => assertTestListingsAllowed(['BTC-USDC'], appEnv)).toThrow(/LOCAL TEST seed/);
      await expect(seedTestListings(new MemoryVenueListingStore(), sim(), ['BTC-USDC'], appEnv, at)).rejects.toThrow(/LOCAL TEST seed/);
    }
    expect(() => assertTestListingsAllowed([], 'prod')).not.toThrow();
    const s = sim();
    const live = Object.assign(Object.create(s) as UserVenue, { venue: { ...s.venue, proofLevel: 'live' as const } });
    await expect(seedTestListings(new MemoryVenueListingStore(), live, ['BTC-USDC'], 'dev', at)).rejects.toThrow(/not a TEST venue/);
    expect(parseTestListings('')).toEqual([]);
    expect(() => parseTestListings('btc usdc')).toThrow(/comma list/);
    expect(() => parseTestListings('BTC-USDC,,')).toThrow(/comma list/);
  });
});

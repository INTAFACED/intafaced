import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { createP2pRouter } from './router.js';

/**
 * J-p2p-12: following a trader (one notice per follower per new ad, none on an edit), blocking (no chat for a blocked
 * pair, no block while an order between them is open) and support's one decision on a completion appeal
 * (P-ads-merchant-22, P-trade-orders-21). Postgres is the shared test server (TEST_DATABASE_URL). No balance is invented.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const STAFF = '44444444-4444-4444-8444-444444444444';
const ASSET = 'USDT';
const DEADLINES = {
  escrowSeconds: 120,
  paymentSeconds: 900,
  releaseSeconds: 1800,
  disputeSeconds: 604_800,
  escalationRecheckSeconds: 3_600,
};

describe('svc-p2p follow, block and appeal decisions (J-p2p-12)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let p2p!: P2pService;
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let bus!: MemoryEventBus;
  let posted: Array<{ payload: Record<string, unknown>; key: string | undefined }>;

  const service = (followerNoticesPerDay?: number) =>
    new P2pService(sql, ledger, bus, {
      instruments,
      feeBps: 100,
      appealReviewHours: 48,
      ...(followerNoticesPerDay === undefined ? {} : { followerNoticesPerDay }),
      deadlines: DEADLINES,
    });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
    posted = [];
    const publish = bus.publish.bind(bus);
    bus.publish = (async (name: string, payload: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
      if (name === 'p2pTraderPosted') posted.push({ payload, key: options?.idempotencyKey });
      return publish(name as never, payload as never, options as never);
    }) as typeof bus.publish;
    instruments = new InstrumentService(sql);
    p2p = service(5);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    for (const ownerId of [MAKER, TAKER, OTHER]) {
      await instruments.createInstrument({
        ownerId,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'sepa',
        details: { account_reference: `ref-${ownerId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('1000'), rail: 'test', railRef: `${MAKER}:1000` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const sell = (overrides: Partial<Parameters<P2pService['createOffer']>[0]> = {}) =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'pay within 15 minutes',
      ...overrides,
    });

  const contact = (ownerId: string, peerId: string, kind: 'follow' | 'block', present = true) =>
    p2p.setContact({ ownerId, peerId, kind, present, idempotencyKey: `${ownerId}:${kind}:${present}:${crypto.randomUUID()}` });

  const SECRET = 'p2p-follow-block-edge-secret-long-ok';
  function caller(userId: string, scopes: string[] = ['p2p:read', 'p2p:write'], mfa = false) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-follow-block');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: userId,
      userId,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes,
      tier: 'basic',
      mfa,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-follow-block',
      }),
    );
  }

  const owed = async () => sql<Array<{ follower_id: string; handed_at: Date | null }>>`SELECT * FROM p2p.follower_notices`;

  describe('a followed trader posts (P-ads-merchant-22)', () => {
    it('owes and hands one notice per follower, and an edit sends none', async () => {
      await contact(TAKER, MAKER, 'follow');
      await contact(OTHER, MAKER, 'follow');
      const offer = await sell();
      expect(posted.map((p) => p.payload.followerId).sort()).toEqual([TAKER, OTHER].sort());
      expect(posted.map((p) => p.key).sort()).toEqual(
        [`p2p.trader.posted:${offer.id}:${OTHER}`, `p2p.trader.posted:${offer.id}:${TAKER}`].sort(),
      );
      expect(posted[0]!.payload).toMatchObject({ offerId: offer.id, traderId: MAKER, side: 'sell', asset: ASSET, fiatCurrency: 'USD' });
      expect((await owed()).every((row) => row.handed_at !== null)).toBe(true);

      await p2p.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: `edit:${offer.id}`, price: parseAmount('1.01') });
      await p2p.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: `edit2:${offer.id}`, terms: 'edited terms' });
      expect(posted).toHaveLength(2);
      expect(await p2p.sweepFollowerNotices(100)).toEqual({ sent: 0, failures: [] });
      expect(await owed()).toHaveLength(2);
    });

    it('a replayed post is the same ad, so no second notice is owed', async () => {
      await contact(TAKER, MAKER, 'follow');
      const first = await sell({ idempotencyKey: 'post-once-0001' });
      const again = await sell({ idempotencyKey: 'post-once-0001' });
      expect(again.id).toBe(first.id);
      expect(await owed()).toHaveLength(1);
      expect(posted).toHaveLength(1);
    });

    it('owes nothing to a non-follower, a blocked follower, or for a private ad', async () => {
      await contact(TAKER, MAKER, 'follow');
      await contact(OTHER, MAKER, 'follow');
      await contact(MAKER, OTHER, 'block');
      await sell({ visibility: 'private' });
      expect(await owed()).toHaveLength(0);
      await sell();
      expect((await owed()).map((row) => row.follower_id)).toEqual([TAKER]);
    });

    it('a blank daily figure sends no notice; the ad still posts', async () => {
      p2p = service(undefined);
      await contact(TAKER, MAKER, 'follow');
      const offer = await sell();
      expect(offer.status).toBe('active');
      expect(await owed()).toHaveLength(0);
      expect(posted).toHaveLength(0);
    });

    it('past the owner’s daily figure, a new ad reaches no follower', async () => {
      p2p = service(2);
      await contact(TAKER, MAKER, 'follow');
      await sell();
      await sell();
      await sell();
      expect(await owed()).toHaveLength(2);
    });

    it('a notice the bus did not take is handed over by the sweep, once', async () => {
      await contact(TAKER, MAKER, 'follow');
      const publish = bus.publish;
      // The bus refuses this one notice; the ad's own event goes out as usual.
      bus.publish = (async (name: string, ...rest: unknown[]) => {
        if (name === 'p2pTraderPosted') throw new Error('bus down');
        return (publish as (...args: unknown[]) => Promise<unknown>)(name, ...rest);
      }) as typeof bus.publish;
      const offer = await sell();
      expect(offer.status).toBe('active');
      expect((await owed())[0]!.handed_at).toBeNull();
      bus.publish = publish;
      expect(await p2p.sweepFollowerNotices(100)).toEqual({ sent: 1, failures: [] });
      expect(posted).toHaveLength(1);
      expect(await p2p.sweepFollowerNotices(100)).toEqual({ sent: 0, failures: [] });
    });
    it('drops, never sends, a notice whose pair blocked each other or whose ad came down before it was handed over', async () => {
      await contact(TAKER, MAKER, 'follow');
      await contact(OTHER, MAKER, 'follow');
      const publish = bus.publish;
      bus.publish = (async (name: string, ...rest: unknown[]) => {
        if (name === 'p2pTraderPosted') throw new Error('bus down');
        return (publish as (...args: unknown[]) => Promise<unknown>)(name, ...rest);
      }) as typeof bus.publish;
      const first = await sell();
      bus.publish = publish;
      await contact(MAKER, TAKER, 'block');
      expect(await p2p.sweepFollowerNotices(100)).toEqual({ sent: 1, failures: [] });
      expect(posted.map((p) => p.payload.followerId)).toEqual([OTHER]);
      const rows = await sql<Array<{ follower_id: string; handed_at: Date | null; dropped_at: Date | null }>>`
        SELECT follower_id, handed_at, dropped_at FROM p2p.follower_notices WHERE offer_id = ${first.id}
      `;
      expect(rows.find((r) => r.follower_id === TAKER)).toMatchObject({ handed_at: null, dropped_at: expect.any(Date) });

      bus.publish = (async (name: string, ...rest: unknown[]) => {
        if (name === 'p2pTraderPosted') throw new Error('bus down');
        return (publish as (...args: unknown[]) => Promise<unknown>)(name, ...rest);
      }) as typeof bus.publish;
      const second = await sell();
      bus.publish = publish;
      await p2p.closeOffer(second.id, MAKER);
      expect(await p2p.sweepFollowerNotices(100)).toEqual({ sent: 0, failures: [] });
      expect(posted).toHaveLength(1);
    });
  });

  describe('a blocked pair (P-ads-merchant-22)', () => {
    async function released() {
      const offer = await sell();
      const t = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await p2p.markFiatSent(t.id, TAKER);
      await p2p.confirmFiatReceived(t.id, MAKER);
      return t;
    }

    it('cannot chat either way; the history stays readable; unblock lets them talk again', async () => {
      const t = await released();
      const say = (senderId: string, text: string) =>
        p2p.sendChatMessage({ tradeId: t.id, senderId, clientId: crypto.randomUUID(), text, asModerator: false });
      await say(TAKER, 'before');
      await contact(TAKER, MAKER, 'block');
      await expect(say(TAKER, 'hello')).rejects.toMatchObject({ code: 'p2p.blocked' });
      await expect(say(MAKER, 'hello')).rejects.toMatchObject({ code: 'p2p.blocked' });
      const read = await p2p.listChatMessages({ tradeId: t.id, viewerId: MAKER, asModerator: false, limit: 50 });
      expect(read.messages.map((m) => m.text)).toEqual(['before']);
      await contact(TAKER, MAKER, 'block', false);
      await say(MAKER, 'after');
    });

    it('an order still open from a block made before the open-order rule keeps its chat until it ends', async () => {
      const offer = await sell();
      const open = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await sql`INSERT INTO p2p.contacts (owner_id, peer_id, kind) VALUES (${TAKER}, ${MAKER}, 'block')`;
      const sent = await p2p.sendChatMessage({
        tradeId: open.id,
        senderId: TAKER,
        clientId: crypto.randomUUID(),
        text: 'paying now',
        asModerator: false,
      });
      expect(sent.created).toBe(true);
      await p2p.cancelTrade(open.id, TAKER);
      await expect(
        p2p.sendChatMessage({ tradeId: open.id, senderId: MAKER, clientId: crypto.randomUUID(), text: 'after', asModerator: false }),
      ).rejects.toMatchObject({ code: 'p2p.blocked' });
    });

    it('cannot be made while an order between them is open, and refuses the take after it is', async () => {
      const offer = await sell();
      const open = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await expect(contact(TAKER, MAKER, 'block')).rejects.toMatchObject({ code: 'p2p.block_open_order' });
      await expect(contact(MAKER, TAKER, 'block')).rejects.toMatchObject({ code: 'p2p.block_open_order' });
      await expect(caller(TAKER).contacts.block({ peerId: MAKER, idempotencyKey: 'block-open-0001' })).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: expect.objectContaining({ code: 'p2p.block_open_order' }),
      });
      expect((await p2p.listContacts(TAKER)).blocking).toEqual([]);
      await p2p.cancelTrade(open.id, TAKER);
      await contact(TAKER, MAKER, 'block');
      await expect(
        p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: parseAmount('10'), method: 'sepa', tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: 'p2p.blocked' });
    });
  });

  describe('support decides a completion appeal once (P-trade-orders-21)', () => {
    async function cancelled() {
      const offer = await sell();
      const t = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await p2p.cancelTrade(t.id, TAKER);
      return t;
    }
    const staff = () => caller(STAFF, ['admin:compliance'], true);
    const rate = async () => (await caller(OTHER, ['p2p:read']).reputation.get({ userId: TAKER })).completionRateTotal;

    it('an accepted appeal changes the rate once and keeps who decided, when and why', async () => {
      const done = await sell();
      const t = await p2p.takeOffer({
        offerId: done.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await p2p.markFiatSent(t.id, TAKER);
      await p2p.confirmFiatReceived(t.id, MAKER);
      const c = await cancelled();
      const appeal = await caller(TAKER).reputation.appeal({ tradeId: c.id, reason: 'the seller asked me to cancel' });
      expect(await rate()).toBe('50.00');
      const decided = await staff().reputation.decideAppeal({ appealId: appeal.id, decision: 'accepted', reason: 'seller confirmed' });
      expect(decided).toMatchObject({ id: appeal.id, status: 'accepted', decidedBy: STAFF, decisionReason: 'seller confirmed' });
      expect(decided.decidedAt).not.toBeNull();
      expect(await rate()).toBe('100.00');
      // The same decision again is the same decision; any other is refused, and the rate stays where it moved once.
      expect((await staff().reputation.decideAppeal({ appealId: appeal.id, decision: 'accepted', reason: 'seller confirmed' })).id).toBe(
        appeal.id,
      );
      await expect(
        staff().reputation.decideAppeal({ appealId: appeal.id, decision: 'rejected', reason: 'second look' }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: expect.objectContaining({ code: 'p2p.appeal_decided' }),
      });
      expect(await rate()).toBe('100.00');
      await expect(caller(TAKER).reputation.appeal({ tradeId: t.id, reason: 'another' })).rejects.toMatchObject({
        cause: expect.objectContaining({ code: 'p2p.appeal_used' }),
      });
    });

    it('a rejected appeal leaves the rate and still uses the one appeal', async () => {
      const c = await cancelled();
      const appeal = await caller(TAKER).reputation.appeal({ tradeId: c.id, reason: 'rail outage' });
      await staff().reputation.decideAppeal({ appealId: appeal.id, decision: 'rejected', reason: 'no outage on record' });
      expect(await rate()).toBe('0.00');
      expect((await caller(TAKER).reputation.myAppeal())?.status).toBe('rejected');
    });

    it('refuses a blank reason, an unknown appeal, the appellant, a caller without the scope, and no second factor', async () => {
      const c = await cancelled();
      const appeal = await caller(TAKER).reputation.appeal({ tradeId: c.id, reason: 'rail outage' });
      await expect(staff().reputation.decideAppeal({ appealId: appeal.id, decision: 'accepted', reason: '  ' })).rejects.toMatchObject({
        cause: expect.objectContaining({ code: 'p2p.reason_required' }),
      });
      await expect(
        staff().reputation.decideAppeal({ appealId: crypto.randomUUID(), decision: 'accepted', reason: 'x' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', cause: expect.objectContaining({ code: 'p2p.appeal_not_found' }) });
      await expect(
        caller(TAKER, ['admin:compliance'], true).reputation.decideAppeal({ appealId: appeal.id, decision: 'accepted', reason: 'mine' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', cause: expect.objectContaining({ code: 'p2p.appeal_self_decision' }) });
      await expect(caller(OTHER).reputation.decideAppeal({ appealId: appeal.id, decision: 'accepted', reason: 'x' })).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
        },
      );
      await expect(
        caller(STAFF, ['admin:compliance'], false).reputation.decideAppeal({ appealId: appeal.id, decision: 'accepted', reason: 'x' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect((await caller(TAKER).reputation.myAppeal())?.status).toBe('submitted');
    });
  });
});

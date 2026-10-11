import { OtcDeskService } from '../controls/test-admission.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  formatAmount,
  marketMaker,
  MemoryLedger,
  parseAmount,
  recipes,
  userAvailable,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';

import { describeOtcPolicy } from './otc-policy.js';
import { FixedOtcStake } from './stake-source.js';
import { UNPUBLISHED_OTC_DESK_LAW, type OtcDeskLaw } from './desk-law.js';
import { createConfigOtcMidSource, createObservedOtcMidSource } from './mid-source.js';
import { planOtcSettle, postOtcSettle } from './settle.js';
import { otcSettleIdsFor } from '../spot/ids.js';

/**
 * CAN ANYBODY ACTUALLY CALL THE OTC DESK? (`trade.otc` / D-S-02 Part A)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE EXISTS ALONGSIDE `otc-service.test.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `otc-service.test.ts` proves the desk's logic. It cannot prove the desk is
 * REACHABLE, because it reaches it the one way a customer never can — by
 * calling `new OtcDeskService(...).quote(principal, ...)` directly.
 *
 * `copy/router-mount.test.ts` goes one step further and uses
 * `router.createCaller(...)`, which is closer but still not the port: it never
 * serialises a body, never runs the zod input schema against JSON that came off
 * a socket, and never proves `fastifyTRPCPlugin` is mounted at all. A router
 * built in a test and a router registered on a listening port present
 * identically right up to the moment nobody has registered it.
 *
 * So this file enters over HTTP. A Fastify instance, `fastifyTRPCPlugin` at
 * `/trpc`, and `createEdgeContext` over real signed principal headers — the
 * exact three lines `index.ts` composes. Every assertion below travels as JSON
 * through `app.inject`. If the plugin stops being registered, if a procedure
 * stops being mounted, if a scope drifts, or if the input schema grows a field
 * the customer must not be able to set, these go red.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS CAREFUL NOT TO CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That the desk is open for business. It is not, and cannot be from config
 * alone: `TRADE_OTC_DESK_LAW` is blank in every deployment, so the shipped
 * posture is the refusal asserted in §1. The published law used from §2 onward
 * is a TEST FIXTURE standing in for a DIRECTION §8 owner ruling that has not
 * been made. Nothing here is evidence of a spread, a tier threshold, or a
 * decision to act as principal.
 *
 * Mid freshness uses an observed source tied to the desk clock (not a boot
 * stamp from module load). `socket.otc-mid-feed` stays open in production —
 * `TRADE_OTC_MIDS` must stay empty until a live feed refreshes `asOf`.
 */

const SECRET = 'a-trade-otc-mount-reachability-edge-secret-long';
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const SESSION = '22222222-2222-4222-8222-222222222222';

/**
 * Owner-published desk law — A FIXTURE, not a ruling. See the header.
 * 50 bps on a 200 mid, so one unit of base carries exactly 1 of spread.
 */
const PUBLISHED: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
};

/** Pair map only — `asOf` is bound to the desk clock inside `buildDesk`. */
const MID_RAW = 'BTC/USDT:200';

/**
 * A ledger that remembers what was asked of it.
 *
 * Idempotency is a property of the KEYS, so it is asserted on the keys. Counting
 * calls would pass just as happily against three posts that all carried the same
 * key, or three that each carried a fresh `randomUUID()` — the two failures this
 * desk has already had.
 */
class RecordingLedger extends MemoryLedger {
  readonly posted: PostRequest[] = [];

  override async post(request: PostRequest): Promise<LedgerTx> {
    this.posted.push(request);
    return super.post(request);
  }
}

function principal(userId = USER, scopes: Principal['scopes'] = ['trade:read', 'trade:write']): Principal {
  return {
    sub: userId,
    userId,
    sid: SESSION,
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

/**
 * API-key principal the edge forwards after `apiKeys.exchange` (§9).
 * `kid` is the attribution — not a second HMAC invented on the desk.
 */
const API_KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function apiKeyPrincipal(userId = USER): Principal {
  return {
    sub: userId,
    userId,
    sid: API_KEY_ID,
    kid: API_KEY_ID,
    key_env: 'live',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

/** Headers the EDGE signed. An unsigned principal stays anonymous — asserted in §1. */
function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'content-type': 'application/json',
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
    'x-intafaced-region': 'SG',
  };
}

interface Desk {
  app: Awaited<ReturnType<typeof buildDesk>>['app'];
  ledger: RecordingLedger;
  setNow: (d: Date) => void;
}

/**
 * Exactly the composition `index.ts` performs: router → `fastifyTRPCPlugin` at
 * `/trpc` → context from `createEdgeContext` over request headers.
 */
async function buildDesk(
  opts: {
    law?: OtcDeskLaw;
    mids?: ReturnType<typeof createConfigOtcMidSource> | ReturnType<typeof createObservedOtcMidSource>;
    stake?: string;
    mount?: boolean;
  } = {},
) {
  const ledger = new RecordingLedger();
  let now = new Date('2026-08-10T12:00:00.000Z');

  const otc =
    opts.mount === false
      ? undefined
      : new OtcDeskService(ledger, new FixedOtcStake(parseAmount(opts.stake ?? '1000')), {
          law: opts.law ?? UNPUBLISHED_OTC_DESK_LAW,
          // Observed mid tied to desk `now` — a boot-stamped config mid from
          // module load sits in the future vs the fixture clock and trips the
          // age gate (`ageSeconds < -30`).
          midSource: opts.mids ?? createObservedOtcMidSource(MID_RAW, () => now),
          now: () => now,
        });

  const appRouter = createTradeRouter({} as unknown as TradeService, otc, undefined);
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

  const app = Fastify();
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<typeof appRouter>['trpcOptions'],
  });
  await app.ready();

  return { app, ledger, setNow: (d: Date) => void (now = d) };
}

/** POST a mutation the way a client does — input is the JSON body itself. */
async function callMutation(desk: Desk, path: string, input: unknown, p: Principal = principal()) {
  return desk.app.inject({ method: 'POST', url: `/trpc/${path}`, headers: signedHeaders(p), payload: input as object });
}

/** GET a query. No input on any of the desk's reads. */
async function callQuery(desk: Desk, path: string, p: Principal = principal()) {
  return desk.app.inject({ method: 'GET', url: `/trpc/${path}`, headers: signedHeaders(p) });
}

/** tRPC error envelope → the code an integrator branches on. */
function errorCode(res: { json(): unknown }): string | undefined {
  return (res.json() as { error?: { data?: { code?: string } } }).error?.data?.code;
}

function errorMessage(res: { json(): unknown }): string {
  return (res.json() as { error?: { message?: string } }).error?.message ?? '';
}

function resultData<T>(res: { json(): unknown }): T {
  return (res.json() as { result: { data: T } }).result.data;
}

async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
  await ledger.post(
    recipes.deposit({ userId, assetId, amount: parseAmount(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
  );
}

async function balance(ledger: MemoryLedger, userId: string, assetId: string): Promise<string> {
  return formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · THE SHIPPED POSTURE — over the port, with nothing published.
// ═══════════════════════════════════════════════════════════════════════════════

describe('the OTC desk is mounted, and what is mounted refuses', () => {
  /**
   * THE ONE THAT PROVES THE PLUGIN IS THERE.
   *
   * A 200 with a refusal in the body, not a 404. Those two are the states the
   * `reachability` gate exists to tell apart: a desk that says "I am closed and
   * here is who can open me" versus a route nobody registered.
   */
  it('answers deskStatus over HTTP, and says it is refuse-closed rather than 404', async () => {
    const desk = await buildDesk();
    const res = await callQuery(desk, 'otc.deskStatus');

    expect(res.statusCode).toBe(200);
    const status = resultData<{ published: boolean; residual: string | null; statusLine: string }>(res);
    expect(status.published).toBe(false);
    expect(status.residual).toContain('DIRECTION §8');
    // It names all three unpublished numbers, so nobody has to read the code.
    expect(status.residual).toContain('spread');
    expect(status.statusLine).toContain('published=0');

    await desk.app.close();
  });

  it('deskStatus midFeed boot wiring matches policy over HTTP (D43)', async () => {
    const desk = await buildDesk();
    const res = await callQuery(desk, 'otc.deskStatus');
    expect(res.statusCode).toBe(200);
    const status = resultData<{ midFeed: ReturnType<typeof describeOtcPolicy>['bootMidFeedWiring'] }>(res);
    expect(status.midFeed).toEqual(describeOtcPolicy().bootMidFeedWiring);
    await desk.app.close();
  });

  it('otc.policy bootMidFeedWiring matches describeOtcPolicy over HTTP (D44)', async () => {
    const desk = await buildDesk();
    const res = await callQuery(desk, 'otc.policy');
    expect(res.statusCode).toBe(200);
    const policy = resultData<ReturnType<typeof describeOtcPolicy>>(res);
    expect(policy.bootMidFeedWiring).toEqual(describeOtcPolicy().bootMidFeedWiring);
    expect(policy.midFeedWiringHonest).toBe(true);
    await desk.app.close();
  });

  /** Quote, accept and settle are all really there. Refusing is still answering. */
  it('mounts quote, accept and settle — none of them 404', async () => {
    const desk = await buildDesk();

    const quote = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    const accept = await callMutation(desk, 'otc.accept', { quoteId: randomUUID() });
    const settle = await callMutation(desk, 'otc.settle', { quoteId: randomUUID() });

    for (const res of [quote, accept, settle]) {
      expect(res.statusCode).not.toBe(404);
      // PLATFORM missing a ruling, not the caller getting something wrong.
      expect(errorCode(res)).toBe('PRECONDITION_FAILED');
      expect(errorMessage(res)).toContain('DIRECTION §8');
    }

    await desk.app.close();
  });

  /**
   * AN UNSET SPREAD REFUSES BY CODE.
   *
   * `DIRECTION` §8 item 6: the spread is owner-only. The standing ruling is that
   * a surface whose rate is unset is refuse-closed and says so — never a zero,
   * never a "sensible default". A 0 bps desk would quote at mid and give the
   * house's inventory away at cost, which is why the absence must refuse rather
   * than degrade.
   */
  it('refuses to quote at all while the spread is unpublished, and names the ruling', async () => {
    const desk = await buildDesk({ law: UNPUBLISHED_OTC_DESK_LAW });
    const res = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });

    expect(errorCode(res)).toBe('PRECONDITION_FAILED');
    expect(errorMessage(res)).toMatch(/spread/i);
    // Nothing resembling a price came back.
    expect(res.json()).not.toHaveProperty('result');
    // And no rate was invented on the way to refusing.
    expect(desk.ledger.posted).toHaveLength(0);

    await desk.app.close();
  });

  /** A deployment that never passed the desk to the router still answers honestly. */
  it('is refuse-closed rather than broken when the composition root mounts no desk', async () => {
    const desk = await buildDesk({ mount: false });

    const status = await callQuery(desk, 'otc.deskStatus');
    expect(resultData<{ published: boolean }>(status).published).toBe(false);

    const quote = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    expect(errorCode(quote)).toBe('PRECONDITION_FAILED');

    await desk.app.close();
  });

  /** The edge signature is what makes a principal real. Self-assertion buys nothing. */
  it('refuses an unsigned principal — the desk is not open to anonymous callers', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    const res = await desk.app.inject({
      method: 'POST',
      url: '/trpc/otc.quote',
      headers: { 'content-type': 'application/json', 'x-intafaced-region': 'SG' },
      payload: { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' },
    });

    expect(errorCode(res)).toBe('UNAUTHORIZED');
    await desk.app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE GATE — who may ask, before anything is priced.
// ═══════════════════════════════════════════════════════════════════════════════

describe('the staked-tier gate stands at the port', () => {
  /**
   * A BELOW-TIER CALLER IS REFUSED.
   *
   * FORBIDDEN and not PRECONDITION_FAILED, and the distinction is the caller's:
   * this one is short of stake, which is a thing they can change, unlike an
   * unpublished spread which is not.
   */
  it('refuses a caller under the published minimum stake, and prices nothing for them', async () => {
    const desk = await buildDesk({ law: PUBLISHED, stake: '100' });
    const res = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });

    expect(errorCode(res)).toBe('FORBIDDEN');
    expect(errorMessage(res)).toMatch(/stake/i);
    // The refusal does not leak what the desk could have quoted.
    expect(errorMessage(res)).not.toContain('200');
    expect(desk.ledger.posted).toHaveLength(0);

    await desk.app.close();
  });

  /** Exactly at the minimum is inside it. A threshold that excludes its own boundary is a different threshold. */
  it('admits a caller holding exactly the minimum', async () => {
    const desk = await buildDesk({ law: PUBLISHED, stake: '500' });
    const res = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });

    expect(res.statusCode).toBe(200);
    expect(resultData<{ midPrice: string }>(res).midPrice).toBe('200');

    await desk.app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3 · THE PRICE — the desk names it, over the wire, or refuses.
// ═══════════════════════════════════════════════════════════════════════════════

describe('a price that moves money is never supplied by the party it pays', () => {
  /**
   * THE #1097 REGRESSION, GUARDED AT THE PORT.
   *
   * `otc.quote` once took `midPrice` as a required wire input under `trade:read`:
   * a staked caller quoted 10 BTC at a mid of 1, accepted their own quote, and
   * settled the house's market-maker inventory at the number they had just named.
   *
   * The service suite asserts the desk sources its own mid. It cannot assert
   * that the WIRE refuses to carry the customer's — that is a property of the
   * zod input schema, and it only exists where JSON meets it. So this sends
   * every spelling of a customer price and proves the quote is unmoved.
   */
  it('refuses a body that carries a customer price, under every name it could use', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-mount-price' }));
    await fund(desk.ledger, USER, 'USDT', '10000');

    // Every name the old field had, or might be reintroduced under.
    for (const field of ['midPrice', 'price', 'quotedPrice', 'mid', 'spreadBps', 'limitPrice']) {
      const res = await callMutation(desk, 'otc.quote', {
        side: 'buy',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: '1',
        [field]: field === 'spreadBps' ? 0 : '1',
      });

      // Refused, not accepted-and-ignored. A 200 here would tell a client its
      // price was taken, and would read identically to the #1097 behaviour.
      expect(errorCode(res), `${field} must be refused`).toBe('BAD_REQUEST');
      expect(errorMessage(res)).toMatch(/unrecognized|unrecognised/i);
    }

    // Nothing was priced and nothing moved on the way to refusing.
    expect(await balance(desk.ledger, USER, 'USDT')).toBe('10000');
    expect(await balance(desk.ledger, USER, 'BTC')).toBe('0');

    await desk.app.close();
  });

  /**
   * AND THE DESK'S OWN NUMBER IS THE ONE THAT SURVIVES.
   *
   * The clean body — size and instrument only, which is all the customer is
   * entitled to name — comes back priced off the published mid at the owner's
   * spread. This is the positive half of the same rule.
   */
  it('prices a clean body off the desk mid at the owner spread', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    const res = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });

    expect(res.statusCode).toBe(200);
    const quote = resultData<{ midPrice: string; quotedPrice: string; userNotional: string; spreadBps: number }>(res);

    expect(quote.midPrice).toBe('200');
    // A per-unit price at the scale of the notional it charges — not
    // `0.000000000000000201`, which is what raw bigint division produced.
    expect(quote.quotedPrice).toBe('201');
    expect(quote.userNotional).toBe('201');
    expect(quote.spreadBps).toBe(50);

    await desk.app.close();
  });

  /**
   * A QUOTE THAT CANNOT BE PRICED REFUSES.
   *
   * `SOL/USDT` is not in the published map. A dark feed is a refusal, never a
   * fallback and never a stale number — there is no widening, no last-traded,
   * and no zero.
   */
  it('refuses a pair it can source no mark for, and moves nothing', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await fund(desk.ledger, USER, 'USDT', '10000');

    const res = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'SOL', quoteAsset: 'USDT', qty: '1' });

    expect(errorCode(res)).toBe('PRECONDITION_FAILED');
    expect(errorMessage(res)).toMatch(/SOL\/USDT/);
    // The customer's balance is untouched — read off the ledger, not the status code.
    expect(await balance(desk.ledger, USER, 'USDT')).toBe('10000');

    await desk.app.close();
  });

  /** No mid source at all is the production default, and it refuses every pair. */
  it('refuses every pair when no mid is published anywhere', async () => {
    const desk = await buildDesk({ law: PUBLISHED, mids: createConfigOtcMidSource('') });
    const res = await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });

    expect(errorCode(res)).toBe('PRECONDITION_FAILED');
    expect(errorMessage(res)).toMatch(/refuses rather than quote/);

    await desk.app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4 · THE MONEY — balances, not status codes.
// ═══════════════════════════════════════════════════════════════════════════════

describe('a quote the desk gave is a quote the desk honours', () => {
  /**
   * THE WHOLE PATH, OVER HTTP, MEASURED ON THE LEDGER.
   *
   * quote → accept → settle without a single direct service call. Amounts are
   * read from `ledger.balance`, which is the only thing entitled to answer
   * "how much" — a 200 on the settle response proves nothing about who holds
   * what afterwards.
   */
  it('fills a buy at the quoted notional and the ledger agrees', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-mount-btc' }));
    await fund(desk.ledger, USER, 'USDT', '10000');

    const quoted = resultData<{ quoteId: string; quotedPrice: string; userNotional: string; expiresAt: string; counterparty: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );

    // A1: counterparty, size and expiry are on the quote, not inferred by a screen.
    expect(quoted.counterparty).toBe('platform');
    expect(quoted.expiresAt).toBeTruthy();
    expect(quoted.userNotional).toBe('201');

    const accepted = resultData<{ fillPrice: string; fillNotional: string }>(
      await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId }),
    );
    // A4.2: an accepted unexpired quote fills at the quoted price.
    expect(accepted.fillPrice).toBe(quoted.quotedPrice);
    expect(accepted.fillNotional).toBe('201');

    const settled = await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId });
    expect(settled.statusCode).toBe(200);

    // 10000 − 201 paid, 1 BTC received. The house kept the disclosed 1 of spread.
    expect(await balance(desk.ledger, USER, 'USDT')).toBe('9799');
    expect(await balance(desk.ledger, USER, 'BTC')).toBe('1');
    expect(formatAmount((await desk.ledger.balance(marketMaker('USDT'))).amount)).toBe('201');
    expect(desk.ledger.reconcile()).toEqual({ ok: true });

    await desk.app.close();
  });

  /**
   * LAST LOOK IS IMPOSSIBLE (A4.2).
   *
   * The standard abuse in this product: the maker requotes on acceptance,
   * precisely when the market has moved in the taker's favour. An accept that
   * names any price other than the quoted one is refused rather than honoured
   * at the new number.
   */
  it('refuses an accept that names a price other than the one quoted, and moves nothing', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-mount-ll' }));
    await fund(desk.ledger, USER, 'USDT', '10000');

    const quoted = resultData<{ quoteId: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );

    const res = await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId, assertedPrice: '1' });
    expect(errorCode(res)).toBe('BAD_REQUEST');
    expect(errorMessage(res)).toMatch(/last look/i);

    expect(await balance(desk.ledger, USER, 'USDT')).toBe('10000');
    expect(await balance(desk.ledger, USER, 'BTC')).toBe('0');

    await desk.app.close();
  });

  /**
   * AN EXPIRED QUOTE CANNOT BE FILLED.
   *
   * A quote that survives its own expiry is a free option written against the
   * house: the taker waits, and accepts only if the market moved their way. The
   * bound here is `quoteTtlMs` off the quote's own `createdAt`.
   */
  it('cannot be filled after it expires, and nothing moves when it is tried', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-mount-exp' }));
    await fund(desk.ledger, USER, 'USDT', '10000');

    const quoted = resultData<{ quoteId: string; expiresAt: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );

    // One second past the expiry the desk itself published.
    desk.setNow(new Date(Date.parse(quoted.expiresAt) + 1_000));

    const res = await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId });
    expect(errorCode(res)).toBe('BAD_REQUEST');
    expect(errorMessage(res)).toMatch(/expired/i);

    // And it cannot be settled either — expiry is not a step that can be skipped.
    const settle = await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId });
    expect(errorCode(settle)).toBe('NOT_FOUND');

    expect(await balance(desk.ledger, USER, 'USDT')).toBe('10000');
    expect(await balance(desk.ledger, USER, 'BTC')).toBe('0');
    expect(desk.ledger.posted.filter((p) => p.reason?.startsWith('trade.'))).toHaveLength(0);

    await desk.app.close();
  });

  /** A quote is the quoted user's. Nobody else can accept it. */
  it('refuses an accept from a caller who is not the one quoted', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    const quoted = resultData<{ quoteId: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );

    const res = await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId }, principal(OTHER));
    expect(errorCode(res)).toBe('FORBIDDEN');

    await desk.app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5 · REPLAY — one business event, one settlement.
// ═══════════════════════════════════════════════════════════════════════════════

describe('a fill is idempotent per business event', () => {
  /**
   * ASSERTED ON THE KEYS, NOT ON A CALL COUNT.
   *
   * The failure #1097 fixed was `randomUUID()` ids: a settle that threw after
   * the taker hold posted left the bound fill in place, and the retry computed
   * FRESH keys, so the ledger's dedupe saw a new transaction and posted a second
   * hold that nothing ever released. A call-count assertion is blind to that —
   * three calls is three calls whether the keys collide, repeat, or differ.
   *
   * So two things are asserted. First, the three posts of one settle carry three
   * DISTINCT keys: one shared key would make the mm hold, the taker hold and the
   * fill collapse into whichever posted first. Second, replaying the same
   * business event resolves to the same transactions and moves nothing further.
   */
  it('posts three distinct idempotency keys, all derived from the quote id', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-mount-idem' }));
    await fund(desk.ledger, USER, 'USDT', '10000');

    const quoted = resultData<{ quoteId: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );
    await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId });

    const before = desk.ledger.posted.length;
    await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId });
    const settlePosts = desk.ledger.posted.slice(before);

    const keys = settlePosts.map((p) => p.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    // Every one of them is a function of the quote, so a retry recomputes them.
    const ids = otcSettleIdsFor(quoted.quoteId);
    expect(keys.some((k) => k.includes(ids.fillId))).toBe(true);
    expect(keys.some((k) => k.includes(ids.takerOrderId))).toBe(true);
    expect(keys.some((k) => k.includes(ids.makerOrderId))).toBe(true);

    await desk.app.close();
  });

  /**
   * THE REPLAY ITSELF.
   *
   * Bound fills stay in the durable store after settle, so a second `otc.settle`
   * over HTTP is a no-op present of the same fill ids — it must not move
   * balances. The ledger business event is also re-posted by key: same
   * transactions, same balances.
   */
  it('re-posting the same settle plan changes no balance and reuses every transaction', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-mount-replay' }));
    await fund(desk.ledger, USER, 'USDT', '10000');

    const quoted = resultData<{ quoteId: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );
    const accepted = resultData<{ fillNotional: string; fillPrice: string }>(
      await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId }),
    );

    const before = desk.ledger.posted.length;
    const firstSettle = resultData<{ fillId: string; takerOrderId: string; makerOrderId: string }>(
      await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId }),
    );
    const firstKeys = desk.ledger.posted.slice(before).map((p) => p.idempotencyKey);
    const firstTxIds = await Promise.all(firstKeys.map(async (k) => (await desk.ledger.getTxByKey(k))?.id));
    expect(firstTxIds.every((id) => typeof id === 'string')).toBe(true);

    const settledUsdt = await balance(desk.ledger, USER, 'USDT');
    const settledBtc = await balance(desk.ledger, USER, 'BTC');
    expect(settledUsdt).toBe('9799');
    expect(settledBtc).toBe('1');

    // Durable replay: second HTTP settle re-presents the same ids, no new posts.
    const replayHttp = resultData<{ fillId: string; takerOrderId: string; makerOrderId: string }>(
      await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId }),
    );
    expect(replayHttp).toEqual(firstSettle);
    expect(desk.ledger.posted.length).toBe(before + firstKeys.length);

    // THE REPLAY: recompute the same business event and post it again.
    const ids = otcSettleIdsFor(quoted.quoteId);
    const replay = planOtcSettle({
      law: PUBLISHED,
      bound: {
        quoteId: quoted.quoteId,
        userId: USER,
        side: 'buy',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: parseAmount('1'),
        fillPrice: parseAmount(accepted.fillPrice),
        fillNotional: parseAmount(accepted.fillNotional),
        spreadBps: PUBLISHED.published ? PUBLISHED.spreadBps : 0,
        counterparty: 'platform',
        counterpartyId: 'platform:otc-desk',
        acceptedAt: '2026-08-10T12:00:00.000Z',
      },
      takerOrderId: ids.takerOrderId,
      makerOrderId: ids.makerOrderId,
      fillId: ids.fillId,
    });
    await postOtcSettle(desk.ledger, replay);

    // Not a second fill. The same three transactions, and the same balances.
    const replayTxIds = await Promise.all(firstKeys.map(async (k) => (await desk.ledger.getTxByKey(k))?.id));
    expect(replayTxIds).toEqual(firstTxIds);
    expect(await balance(desk.ledger, USER, 'USDT')).toBe(settledUsdt);
    expect(await balance(desk.ledger, USER, 'BTC')).toBe(settledBtc);
    expect(formatAmount((await desk.ledger.balance(marketMaker('USDT'))).amount)).toBe('201');
    expect(desk.ledger.reconcile()).toEqual({ ok: true });

    await desk.app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6 · LEFTOVER LIE — settle is the customer trade:write door, not a missing HMAC mill.
// ═══════════════════════════════════════════════════════════════════════════════

describe('otc.settle attribution is the existing trade:write path', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  /**
   * THE NAMED LEFTOVER WAS "HMAC NOT MILLED".
   *
   * Settle is a customer money mutate on the same door as `orders.create`:
   * edge-signed principal + `scopedProcedure('trade:write')`. Session JWT and
   * API-key exchange both become that principal. Inventing `serviceProcedure`
   * HMAC on this user RFQ would be a second money door.
   */
  it('source pin: otc.settle is scopedProcedure trade:write, not serviceProcedure', () => {
    const src = readFileSync(join(here, '../router.ts'), 'utf8');
    const start = src.indexOf('OTC RFQ desk');
    const end = src.indexOf('Professional RFQ');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const otcBlock = src.slice(start, end);
    expect(otcBlock).toContain("settle: scopedProcedure('trade:write'");
    expect(otcBlock).not.toMatch(/settle:\s*serviceProcedure/);
    expect(otcBlock).not.toContain('serviceProcedure');
  });

  it('source pin: orders.create uses the same trade:write guard settle uses', () => {
    const src = readFileSync(join(here, '../router.ts'), 'utf8');
    expect(src).toMatch(/create:\s*scopedProcedure\('trade:write'/);
    expect(src).toMatch(/settle:\s*scopedProcedure\('trade:write'/);
  });

  it('source pin: trade:write is not INTERACTIVE_ONLY — API keys may hold it', () => {
    const src = readFileSync(join(here, '../../../../packages/auth/src/scopes.ts'), 'utf8');
    const match = src.match(/export const INTERACTIVE_ONLY_SCOPES[^=]*=\s*\[([^\]]+)\]/);
    expect(match?.[1]).toBeTruthy();
    const listed = match![1]!;
    expect(listed).toContain("'trade:withdraw'");
    expect(listed).not.toContain("'trade:write'");
  });

  it('source pin: REST_ROUTES has no OTC — do not invent a CCXT HMAC settle door', () => {
    const src = readFileSync(join(here, '../../../../packages/exchange-contract/src/api.ts'), 'utf8');
    const start = src.indexOf('export const REST_ROUTES');
    const end = src.indexOf('export type RestRouteName');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end).toLowerCase()).not.toContain('otc');
  });

  /** Edge HMAC is the attribution. Self-asserted settle is anonymous. */
  it('refuses an unsigned settle — edge principal HMAC is required', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    const res = await desk.app.inject({
      method: 'POST',
      url: '/trpc/otc.settle',
      headers: { 'content-type': 'application/json', 'x-intafaced-region': 'SG' },
      payload: { quoteId: randomUUID() },
    });
    expect(errorCode(res)).toBe('UNAUTHORIZED');
    expect(desk.ledger.posted).toHaveLength(0);
    await desk.app.close();
  });

  it('refuses settle when the caller holds only trade:read', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    const quoted = resultData<{ quoteId: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }),
    );
    await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId });
    const res = await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId }, principal(USER, ['trade:read']));
    expect(errorCode(res)).toBe('FORBIDDEN');
    expect(desk.ledger.posted.filter((p) => p.reason?.startsWith('trade.'))).toHaveLength(0);
    await desk.app.close();
  });

  /**
   * The existing HMAC/API-key path: identity exchanges `ifc_…` for a JWT with
   * `kid`, edge HMAC-signs that principal, svc-trade settles on trade:write.
   */
  it('settles for an API-key principal (kid) the same way a session does', async () => {
    const desk = await buildDesk({ law: PUBLISHED });
    await desk.ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-hmac-kid' }));
    await fund(desk.ledger, USER, 'USDT', '10000');
    const key = apiKeyPrincipal();

    const quoted = resultData<{ quoteId: string }>(
      await callMutation(desk, 'otc.quote', { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }, key),
    );
    await callMutation(desk, 'otc.accept', { quoteId: quoted.quoteId }, key);
    const settled = await callMutation(desk, 'otc.settle', { quoteId: quoted.quoteId }, key);
    expect(settled.statusCode).toBe(200);
    expect(await balance(desk.ledger, USER, 'USDT')).toBe('9799');
    expect(await balance(desk.ledger, USER, 'BTC')).toBe('1');
    expect(desk.ledger.reconcile()).toEqual({ ok: true });
    await desk.app.close();
  });
});

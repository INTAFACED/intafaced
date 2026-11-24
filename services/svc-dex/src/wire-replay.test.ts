import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  REGION_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNSIGNED_SANCTIONS_ROWS_ENV,
} from '@intafaced/config';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';

import { parseAmount as amt, type Amount } from '@intafaced/ledger-client/money';
import { createDexRouter, type DexRouterDeps } from './router.js';
import { MarketDataSource } from './quote/market-data-source.js';
import type { BookLevel, TimestampedBook, VenueKind } from './quote/venue.js';
import { OrderBook } from './order/order-book.js';

/** The edge principal's own types, read off `encodePrincipal` (svc-dex does not depend on `@intafaced/auth`). */
type Principal = Parameters<typeof encodePrincipal>[0];
type Scope = Principal['scopes'][number];

/**
 * The wire replay for svc-dex: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-dex's tRPC router answered (main 2026-11-19, as it is, bugs included) to a
 * matrix of requests: every procedure of the router `index.ts` mounts, each call's own inputs and six generic ones,
 * five callers, and two set-ups (every owner value blank, as on a stack nobody configured; and every owner value set,
 * with one live fake venue, a read hide list and the internal book on), sent through the production Fastify adapter
 * with the edge context `index.ts` builds. A later move of these calls must answer each one byte for byte the same; a
 * wrong door, a changed refusal code, a widened input or a reshaped envelope shows here as a difference.
 *
 * The clock is fixed and the screening list is set here, so the recording does not change with the calendar or the
 * machine's environment. The order session stays unset in both set-ups: a set one seals random nonces into its answers.
 * `/health` and `/ready` are plain Fastify routes written inline in `index.ts`, which starts a server when imported; they
 * answer `dexHealthHonesty` and `dexReadyHonesty`, which the tRPC `health` call recorded here also answers.
 *
 * The recording is one file per set-up and one for the callers, so each new file stays under the size one review part
 * reads whole. `WIRE_REPLAY_WRITE=1` rewrites the golden files. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/**
 * Error replies no longer carry tRPC's stack. Recordings made before that hold `"stack":"<stack>"` in their error bodies;
 * it is dropped on reading, while the live side still turns any stack into `<stack>`, so a stack that comes back fails.
 */
const RECORDED_STACK = '\\"stack\\":\\"<stack>\\",';
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
const SECRET = 'a-dex-wire-replay-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-19T00:00:00.000Z');
const WALLET = '0x' + 'a'.repeat(40);
const TOKEN_IN = '0x' + 'b'.repeat(40);
const TOKEN_OUT = '0x' + 'c'.repeat(40);
const HASH = '0x' + 'd'.repeat(64);

/** The screening list and its fail-closed switches, fixed for the run: KP is screened out, every other region is not. */
const SCREENING_ENV: Record<string, string | undefined> = {
  APP_ENV: 'test',
  [SANCTIONS_REGIONS_ENV]: 'KP',
  [SANCTIONS_SOURCE_ENV]: 'wire-replay-fixture',
  [UNSIGNED_SANCTIONS_ROWS_ENV]: undefined,
  [SCREENING_FAIL_CLOSED_ENV]: undefined,
  [REGION_FAIL_CLOSED_ENV]: undefined,
};
beforeAll(() => {
  for (const [name, value] of Object.entries(SCREENING_ENV)) vi.stubEnv(name, value);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const level = (price: string, qty: string): BookLevel => [amt(price), amt(qty)];

/** One venue with depth on both sides, read at `NOW`. */
class ReplayVenue extends MarketDataSource {
  readonly id = 'intachain-clob';
  readonly kind: VenueKind = 'external-dex';
  readonly feeBps = 5;
  readonly settlementCost: Amount = 0n;

  constructor() {
    super({ quoteTtlMs: 2_000 });
  }

  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
    return {
      venueId: this.id,
      symbol,
      bids: [level('99', '10')],
      asks: [level('101', '10')],
      observedAt: NOW,
      sequence: 1,
      chainFinality: 'finalized',
    };
  }
}

/** Every owner value blank, as `index.ts` builds the router from an empty environment. */
function blankDeps(): DexRouterDeps {
  return {
    venues: () => [],
    now: () => NOW,
    internalBookEnabled: false,
    ammVenueWired: false,
    externalVenueWired: false,
    triggerOrders: { settings: {}, book: new OrderBook() },
  };
}

/** Every owner value set: a live venue, a read hide list that hides one market, the trigger settings, the internal book on. */
function setDeps(): DexRouterDeps {
  return {
    venues: () => [new ReplayVenue()],
    maxAgeMs: 2_000,
    depth: 50,
    hideList: { read: async () => ({ asOf: NOW.toISOString(), pools: [], markets: [{ symbol: 'HIDDEN-USD' }] }) },
    now: () => NOW,
    internalBookEnabled: true,
    ammVenueWired: false,
    externalVenueWired: true,
    triggerOrders: {
      settings: {
        minSize: amt('1'),
        restrictedTokens: [],
        warnTokens: [],
        slippageBps: 50,
        oracleMaxAgeMs: 1_000,
        orderDomain: { name: 'INTAFACED', version: '1', chainId: 1, verifyingContract: `0x${'e'.repeat(40)}` },
      },
      book: new OrderBook(),
    },
  };
}

const SETUPS: ReadonlyArray<[string, () => DexRouterDeps]> = [
  ['blank', blankDeps],
  ['set', setDeps],
];

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });

async function serve(deps: DexRouterDeps) {
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createDexRouter(deps), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
  return app;
}

const typedOrder = {
  variant: 'buy_below',
  maker: WALLET,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountIn: '10',
  triggerPrice: '100',
  minOut: '0.09',
  expiry: '2026-11-20T00:00:00Z',
};
const trigger = { typedOrder, signature: '0x' + '1'.repeat(130) };

/** Each call with its own inputs: the valid one first, then the ones that reach its own refusals. */
const CALLS: ReadonlyArray<{ path: string; kind: 'query' | 'mutation'; own: Array<[string, unknown]> }> = [
  { path: 'health', kind: 'query', own: [['valid', undefined]] },
  {
    path: 'quote',
    kind: 'query',
    own: [
      ['valid', { symbol: 'IFC-USD', side: 'buy', qty: '1' }],
      ['sell', { symbol: 'IFC-USD', side: 'sell', qty: '1' }],
      ['too-big', { symbol: 'IFC-USD', side: 'buy', qty: '1000' }],
      ['hidden', { symbol: 'HIDDEN-USD', side: 'buy', qty: '1' }],
      ['bad-qty', { symbol: 'IFC-USD', side: 'buy', qty: '1.0000000000000000001' }],
    ],
  },
  {
    path: 'routePreview',
    kind: 'query',
    own: [
      [
        'valid',
        {
          side: 'buy',
          qty: '2',
          quotes: [
            { venue: 'a', kind: 'book', fillableQty: '1', quoteAmount: '100', feeBps: 5, settlementCost: '0' },
            { venue: 'b', kind: 'pool', fillableQty: '5', quoteAmount: '510', feeBps: 30, settlementCost: '0.1' },
          ],
        },
      ],
      ['no-quotes', { side: 'sell', qty: '1', quotes: [] }],
      [
        'bad-fee',
        {
          side: 'buy',
          qty: '1',
          quotes: [{ venue: 'a', kind: 'book', fillableQty: '1', quoteAmount: '1', feeBps: 10_000, settlementCost: '0' }],
        },
      ],
    ],
  },
  {
    path: 'limitOrder',
    kind: 'mutation',
    own: [
      [
        'valid',
        {
          symbol: 'IFC-USD',
          side: 'buy',
          price: '100',
          size: '1',
          window: { startsAt: '2026-11-19T00:00:00Z', endsAt: '2026-11-20T00:00:00Z' },
        },
      ],
      ['blank-price', { symbol: 'IFC-USD', side: 'buy', size: '1' }],
      ['blank-window', { symbol: 'IFC-USD', side: 'sell', price: '100', size: '1', window: '' }],
      ['negative-size', { symbol: 'IFC-USD', side: 'buy', price: '100', size: '-1' }],
    ],
  },
  {
    path: 'order.validate',
    kind: 'mutation',
    own: [
      ['valid', trigger],
      ['unsigned', { typedOrder }],
      ['no-expiry', { typedOrder: { ...typedOrder, expiry: undefined }, signature: trigger.signature }],
      ['past-expiry', { typedOrder: { ...typedOrder, expiry: '2026-01-01T00:00:00Z' }, signature: trigger.signature }],
      ['bad-variant', { typedOrder: { ...typedOrder, variant: 'sideways' }, signature: trigger.signature }],
    ],
  },
  {
    path: 'order.createTrigger',
    kind: 'mutation',
    own: [
      ['valid', trigger],
      ['unsigned', { typedOrder }],
    ],
  },
  {
    path: 'order.get',
    kind: 'query',
    own: [
      ['valid', { orderHash: HASH }],
      ['bad-hash', { orderHash: 'nope' }],
    ],
  },
  {
    path: 'order.attempts',
    kind: 'query',
    own: [
      ['valid', { orderHash: HASH }],
      ['bad-hash', { orderHash: 'nope' }],
    ],
  },
  { path: 'auth.challenge', kind: 'mutation', own: [['valid', { address: WALLET, chainId: 1 }]] },
  { path: 'auth.verify', kind: 'mutation', own: [['valid', { challenge: 'placeholder', signature: '0xab' }]] },
  { path: 'auth.refresh', kind: 'mutation', own: [['valid', { refreshToken: 'placeholder' }]] },
  { path: 'auth.logout', kind: 'mutation', own: [['valid', { accessToken: 'placeholder' }]] },
  { path: 'auth.logoutAll', kind: 'mutation', own: [['valid', { accessToken: 'placeholder' }]] },
  {
    path: 'orders.count',
    kind: 'mutation',
    own: [
      ['valid', { wallet: WALLET }],
      ['bad-wallet', { wallet: 'nope' }],
    ],
  },
];

/** Every call also gets: nothing; null; a wrong type; an empty object; its valid input plus a key; its valid input with every field null. */
function inputs(call: (typeof CALLS)[number]): Array<[string, unknown]> {
  const valid = call.own[0]![1];
  const isObject = valid !== null && typeof valid === 'object' && !Array.isArray(valid);
  return [
    ...call.own,
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['extra-key', isObject ? { ...(valid as object), extra: 1 } : { extra: 1 }],
    ['all-null', isObject ? Object.fromEntries(Object.keys(valid as object).map((k) => [k, null])) : null],
  ];
}

/** Nobody; a signed-in person in a served region, in an unserved one and in a screened one; a principal with no signature. */
const CALLERS: ReadonlyArray<[string, Scope[] | null, string, 'signed' | 'forged' | 'none']> = [
  ['anon', null, 'DE', 'none'],
  ['signed', [], 'DE', 'signed'],
  ['signed-US', [], 'US', 'signed'],
  ['signed-KP', [], 'KP', 'signed'],
  ['forged', ['admin:treasury'], 'DE', 'forged'],
];

function headers(scopes: Scope[] | null, region: string, how: 'signed' | 'forged' | 'none'): Record<string, string> {
  if (how === 'none' || scopes === null) return { 'x-intafaced-region': region };
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    ...(how === 'signed' ? { 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region) } : {}),
    'x-intafaced-region': region,
  };
}

async function hit(app: Awaited<ReturnType<typeof serve>>, call: (typeof CALLS)[number], input: unknown, h: Record<string, string>) {
  const url = `/trpc/${call.path}${call.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  const res =
    call.kind === 'query'
      ? await app.inject({ method: 'GET', url, headers: h })
      : await app.inject({
          method: 'POST',
          url,
          headers: { ...h, 'content-type': 'application/json' },
          payload: input === undefined ? '' : JSON.stringify(input),
        });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit; a venue's `latencyMs` is the
  // wall-clock time its read took, which moves with the machine. Each keeps its place and type in the recording.
  return {
    status: res.statusCode,
    body: res.body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"').replace(/"latencyMs":\d+/g, '"latencyMs":0'),
  };
}

interface Golden {
  readonly callers: unknown;
  readonly answers: Record<string, { status: number; body: string }>;
}

async function replay(): Promise<Golden> {
  const answers: Golden['answers'] = {};
  for (const [setup, deps] of SETUPS) {
    const app = await serve(deps());
    try {
      for (const call of CALLS)
        for (const [inputName, input] of inputs(call))
          for (const [callerName, scopes, region, how] of CALLERS) {
            answers[`${setup} ${call.path} ${inputName} ${callerName}`] = await hit(app, call, input, headers(scopes, region, how));
          }
    } finally {
      await app.close();
    }
  }
  return { callers: procedureCallers(createDexRouter(blankDeps()) as never), answers };
}

describe('the wire replay: svc-dex answers as main did on 2026-11-19', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const now = await replay();
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.WIRE_REPLAY_WRITE === '1') {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(goldenJson('callers'), json(now.callers));
      for (const [setup] of SETUPS)
        writeFileSync(
          goldenJson(setup),
          json(Object.fromEntries(Object.entries(now.answers).filter(([key]) => key.startsWith(`${setup} `)))),
        );
    }
    const read = (name: string): unknown => JSON.parse(readFileSync(goldenJson(name), 'utf8').replaceAll(RECORDED_STACK, ''));
    const golden: Golden = {
      callers: read('callers'),
      answers: Object.assign({}, ...SETUPS.map(([setup]) => read(setup))) as Golden['answers'],
    };
    expect(Object.keys(golden.answers)).toHaveLength(Object.keys(now.answers).length);
    expect(now.callers).toEqual(golden.callers);
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
      .map(
        ([key, was]) =>
          `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
      );
    expect(diffs).toEqual([]);
  });
});

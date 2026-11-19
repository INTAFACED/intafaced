import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, serviceAuthHeaders, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createSbeCodec } from '@intafaced/sbe-codec';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MatchingEngine, MemorySnapshotSink } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { installCodFence } from './engine/cod-fence.js';
import { installAuctionUncross } from './engine/auction-uncross.js';
import { installCollars } from './engine/collars.js';
import { installHaltLaw } from './engine/halt-law.js';
import { installBulkItems } from './engine/bulk-items.js';
import { installCoreTif } from './engine/core-tif.js';
import { installIfmCrash } from './engine/ifm-crash.js';
import { installL3Queue } from './engine/l3-queue.js';
import { installCertRefuse } from './engine/cert-refuse.js';
import { installComboBook } from './engine/combo-book.js';
import { installSpreadBook } from './engine/spread-book.js';
import { installMassQuote } from './engine/mass-quote.js';
import { installMmp } from './engine/mmp.js';
import { installSurveillancePersist } from './engine/surveillance-persist.js';
import { installRulebookRefuse } from './engine/rulebook-refuse.js';
import { installLiquidity } from './engine/liquidity.js';
import { spreadFillPublisherFor } from './spread-fill-publisher.js';
import { registerHealth } from './health.js';
import { OperationLatency, registerOperationLatency } from './operation-latency.js';
import { registerRoutes, type MatchingRouteOptions } from './router.js';
import { parseOperatorIds, stubApprovalConsumer, unwiredApprovalConsumer } from './action-approval-consume.js';
import { openAfterReplay } from './open-after-replay.js';
import { createReplayHoldLookup, unwiredReplayHoldLookup } from './replay-hold.js';

/**
 * The wire replay for svc-matching: every door's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-matching answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests: every HTTP door `registerRoutes` and `registerHealth` mount, each door's own inputs plus the generic ones,
 * nine callers (nobody; svc-trade, svc-execution and svc-ledger signing over the body; svc-trade with an unbound v1
 * signature and with the wrong secret; an edge-signed founder with admin:write and MFA, an admin:read principal, and a
 * founder signed with the wrong edge secret), and two set-ups. `blank` is `index.ts` on an empty environment: no
 * approvals, no operator list, no edge secret, no ledger. `set` has every owner value set: a two-person approval that
 * always consumes, the operator list, the edge secret, a ledger hold lookup, and one open market with a resting order.
 * The engine is the real one with the same `install*` modules `index.ts` installs, on a memory journal and bus.
 *
 * The doors run in a fixed order and the engine keeps its state between them, so the recording also pins what each
 * door does to the book (a valid submit rests, a halt halts, a delist delists). Only `Date` is frozen, so the recording
 * does not move with the calendar; `/health`'s latency percentiles are wall-clock bucket bounds and are recorded as 0.
 *
 * The SBE doors run on the codec with no Java bridge, so the recording does not depend on the shaded jar being built.
 *
 * Not recorded: `GET /ready`, written inline in `index.ts`, which connects to NATS and listens when imported; and
 * `GET /metrics`, whose histograms are wall-clock timings.
 *
 * One file per door, so each file stays under the size one review part reads whole. `WIRE_REPLAY_WRITE=1` rewrites
 * the golden files. Only for a change that is meant to change the wire, named in its PR.
 */

installCodFence();
installAuctionUncross();
installCollars();
installHaltLaw();
installBulkItems();
installCoreTif();
installIfmCrash();
installL3Queue();
installCertRefuse();
installComboBook();
installSpreadBook();
installMassQuote();
installMmp();
installSurveillancePersist();
installRulebookRefuse();
installLiquidity();

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);

const SECRET = 'matching-wire-replay-internal-secret-32c';
const WRONG_SECRET = 'matching-wire-replay-wrong-secret-xx-32c';
const EDGE_SECRET = 'matching-wire-replay-edge-secret-at-least-32';
const WRONG_EDGE_SECRET = 'matching-wire-replay-wrong-edge-secret-32ch';
const REGION = 'XX';
const NOW = new Date('2026-11-19T00:00:00.000Z');
const MARKET = 'BTC-USDT';
const UNKNOWN = 'NOPE-USD';
const SPREAD = 'BTC-CAL-MAR-JUN';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const ORDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESTING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SPREAD_ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

type Action = 'PLACE' | 'PLACE_POST_ONLY' | 'AMEND';

function proof(marketId: string, action: Action) {
  const at = NOW.toISOString();
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: at,
      observedAt: at,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY', 'AMEND'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    action,
  );
}

interface Setup {
  readonly engine: MatchingEngine;
  readonly journal: MemoryJournal;
  readonly options: MatchingRouteOptions;
  readonly seed: (engine: MatchingEngine) => Promise<void>;
  readonly ledger: boolean;
}

function engineParts(): Pick<Setup, 'engine' | 'journal'> {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({
    journal,
    bus,
    clock: () => new Date(),
    snapshotEvery: 0,
    snapshotSink: new MemorySnapshotSink(),
    spreadFills: spreadFillPublisherFor(bus),
  });
  return { engine, journal };
}

/** `index.ts` on an empty environment: approvals unwired, nobody on the operator list, no edge secret, no ledger. */
function blankSetup(): Setup {
  return {
    ...engineParts(),
    options: { bodyBind: 'require', approvals: unwiredApprovalConsumer(), operatorIds: parseOperatorIds(undefined) },
    seed: async () => {},
    ledger: false,
  };
}

/** Every owner value set: an approval that always consumes, both operators listed, the edge secret, one open market with a resting sell. */
function setSetup(): Setup {
  return {
    ...engineParts(),
    options: {
      bodyBind: 'require',
      approvals: stubApprovalConsumer(CONFIRM, OPERATOR),
      operatorIds: parseOperatorIds(`${OPERATOR}, ${CONFIRM}`),
      edgePrincipalSecret: EDGE_SECRET,
    },
    seed: async (engine) => {
      await engine.open(MARKET, { operatorId: OPERATOR, confirmOperatorId: CONFIRM });
      await engine.submit(
        MARKET,
        {
          orderId: RESTING,
          accountId: 'mm',
          type: 'limit',
          side: 'sell',
          qty: parseAmount('2'),
          price: parseAmount('30100'),
          stopPrice: null,
          tif: 'GTC',
        },
        proof(MARKET, 'PLACE'),
      );
    },
    ledger: true,
  };
}

const SETUPS: ReadonlyArray<[string, () => Setup]> = [
  ['blank', blankSetup],
  ['set', setSetup],
];

/** The process `index.ts` builds, minus NATS, the journal file, telemetry, `/ready` and `/metrics`. */
async function serve(setup: Setup): Promise<FastifyInstance> {
  const { engine, journal } = setup;
  const app = Fastify({ logger: false, genReqId: () => 'replay-request' });
  // Every door the process mounts, and every door a request of the matrix reached, so a new door can't go unrecorded.
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') mounted.add(`${method} ${route.url}`);
  });
  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.url) reached.add(`${req.method} ${req.routeOptions.url}`);
  });
  const latency = new OperationLatency(new Date());
  registerOperationLatency(app, latency, (marketId) => engine.markets.includes(marketId));
  registerHealth(app, 'svc-matching', engine, journal, latency);
  // The SBE doors run on the codec with no Java bridge: whether the shaded jar is on a machine must not change the
  // recording. The octets a linked codec writes are `@intafaced/sbe-codec`'s own tests; here the doors' refusal is.
  registerRoutes(app, engine, SECRET, { ...setup.options, sbe: createSbeCodec({ java: null }) });
  const holds = setup.ledger ? createReplayHoldLookup({ balances: async () => [] }) : unwiredReplayHoldLookup();
  await openAfterReplay({ engine, holds, listen: async () => void (await app.ready()) });
  await setup.seed(engine);
  return app;
}

// ── The doors, in the order they run ───────────────────────────────────────

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** One request a door gets: a name, the URL (path and query), and the body (undefined sends none). */
type Input = readonly [name: string, url: string, body?: unknown];
interface Door {
  /** The golden file this door's answers go in. */
  readonly file: string;
  readonly method: Method;
  readonly own: readonly Input[];
  /** Whether the door reads a JSON body, so it also gets the six generic bodies. */
  readonly body: boolean;
}

const submitBody = {
  orderId: ORDER,
  accountId: 'acct-1',
  type: 'limit',
  side: 'buy',
  qty: '1.5',
  price: '30000',
  tif: 'GTC',
  lifecycleProof: proof(MARKET, 'PLACE'),
};
const kill = { operatorId: OPERATOR, confirmOperatorId: CONFIRM, approvalId: 'appr-1', operationId: 'op-1' };
const killDoor = (file: string, url: string): Door => ({
  file,
  method: 'POST',
  body: true,
  own: [
    ['valid', url, kill],
    ['no-approval', url, { operatorId: OPERATOR, confirmOperatorId: CONFIRM }],
    ['not-operator', url, { ...kill, operatorId: 'someone-else' }],
    ['blank-operator', url, { ...kill, operatorId: '' }],
  ],
});
const founder = (door: string, marketId?: string) => ({
  ...(marketId === undefined ? {} : { marketId }),
  approvalId: 'appr-9',
  operationId: 'op-9',
  idempotencyKey: `wire-replay-${door}`,
});
const founderDoor = (file: string, url: string, market: boolean): Door => {
  const valid = founder(file, market ? MARKET : undefined);
  return {
    file,
    method: 'POST',
    body: true,
    own: [
      ['valid', url, valid],
      ['replay-same-key', url, valid],
      ['same-key-other-request', url, { ...valid, operationId: 'op-other' }],
      ['short-key', url, { ...valid, idempotencyKey: 'short' }],
      ['no-market', url, { approvalId: 'appr-8', operationId: 'op-8', idempotencyKey: `wire-replay-${file}-no-market` }],
    ],
  };
};
const limits = (path: string, extra: readonly Input[] = []): readonly Input[] => [
  ['limit-10', `${path}?limit=10`],
  ['no-limit', path],
  ['limit-0', `${path}?limit=0`],
  ['limit-501', `${path}?limit=501`],
  ['limit-word', `${path}?limit=ten`],
  ...extra,
];
const sections = (version: string) => ({
  participation: `${version} TEST participation.`,
  matching: `${version} TEST matching.`,
  cancellation: `${version} TEST cancellation.`,
  settlement: `${version} TEST settlement.`,
  liquidation: `${version} TEST liquidation.`,
  fees: `${version} TEST fees.`,
  market_data: `${version} TEST market data.`,
});
const draft = { version: 'TEST-v1', effectiveAt: '2026-11-20T00:00:00.000Z', sections: sections('TEST-v1') };
const spreadListing = {
  kind: 'calendar',
  legs: [
    { symbol: 'BTC-27MAR', side: 'sell', ratio: '1' },
    { symbol: 'BTC-26JUN', side: 'buy', ratio: '1' },
  ],
  tick: '0.5',
  lot: '0.001',
  ...kill,
};
const spreadOrder = {
  orderId: SPREAD_ORDER,
  accountId: 'mm',
  side: 'sell',
  qty: '2',
  price: '150',
  tif: 'GTC',
  anchorReference: '60000',
  lifecycleProof: proof(SPREAD, 'PLACE'),
};
const quoteSide = (orderId: string, price: string) => ({ orderId, type: 'limit', qty: '1', price, tif: 'GTC' });

const DOORS: readonly Door[] = [
  { file: 'health', method: 'GET', body: false, own: [['valid', '/health']] },
  { file: 'markets', method: 'GET', body: false, own: [['valid', '/markets']] },
  {
    file: 'depth',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/depth`, [
      ['format-sbe', `/markets/${MARKET}/depth?limit=10&format=sbe`],
      ['format-l3', `/markets/${MARKET}/depth?limit=10&format=l3`],
      ['unknown-market', `/markets/${UNKNOWN}/depth?limit=10`],
    ]),
  },
  {
    file: 'depth-l3',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/depth/l3`, [['unknown-market', `/markets/${UNKNOWN}/depth/l3?limit=10`]]),
  },
  {
    file: 'depth-sbe',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/depth/sbe`, [['unknown-market', `/markets/${UNKNOWN}/depth/sbe?limit=10`]]),
  },
  {
    file: 'orders-submit',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/orders`, submitBody],
      ['market-mismatch', `/markets/${UNKNOWN}/orders`, submitBody],
      ['post-only-ioc', `/markets/${MARKET}/orders`, { ...submitBody, tif: 'IOC', postOnly: true }],
      ['post-only-wrong-proof', `/markets/${MARKET}/orders`, { ...submitBody, postOnly: true }],
      ['number-qty', `/markets/${MARKET}/orders`, { ...submitBody, qty: 1.5 }],
      ['too-precise', `/markets/${MARKET}/orders`, { ...submitBody, qty: '1.0000000000000000001' }],
      ['market-buy', `/markets/${MARKET}/orders`, { ...submitBody, type: 'market', price: null, tif: 'IOC' }],
    ],
  },
  {
    file: 'orders-list',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/orders`, [['unknown-market', `/markets/${UNKNOWN}/orders?limit=10`]]),
  },
  {
    file: 'orders-amend',
    method: 'PATCH',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/orders/${ORDER}`, { expectedVersion: 1, qty: '1', lifecycleProof: proof(MARKET, 'AMEND') }],
      ['nothing-changed', `/markets/${MARKET}/orders/${ORDER}`, { expectedVersion: 1, lifecycleProof: proof(MARKET, 'AMEND') }],
      ['place-proof', `/markets/${MARKET}/orders/${ORDER}`, { expectedVersion: 1, qty: '1', lifecycleProof: proof(MARKET, 'PLACE') }],
      [
        'unknown-order',
        `/markets/${MARKET}/orders/${SPREAD_ORDER}`,
        { expectedVersion: 1, qty: '1', lifecycleProof: proof(MARKET, 'AMEND') },
      ],
    ],
  },
  {
    file: 'mark',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/mark`, { mark: '30050' }],
      ['negative', `/markets/${MARKET}/mark`, { mark: '-1' }],
    ],
  },
  {
    file: 'positions-read',
    method: 'GET',
    body: false,
    own: [
      ['valid', `/markets/${MARKET}/positions/acct-1`],
      ['unknown-market', `/markets/${UNKNOWN}/positions/acct-1`],
      ['long-account', `/markets/${MARKET}/positions/${'a'.repeat(129)}`],
    ],
  },
  {
    file: 'positions-close',
    method: 'POST',
    body: true,
    own: [
      [
        'valid',
        `/markets/${MARKET}/positions/close`,
        { orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountId: 'acct-1', lifecycleProof: proof(MARKET, 'PLACE') },
      ],
      [
        'amend-proof',
        `/markets/${MARKET}/positions/close`,
        { orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountId: 'acct-1', lifecycleProof: proof(MARKET, 'AMEND') },
      ],
    ],
  },
  {
    file: 'mass-quote',
    method: 'POST',
    body: true,
    own: [
      [
        'valid',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: 'set-1',
          accountId: 'mm-2',
          bid: quoteSide('f1111111-1111-4111-8111-111111111111', '29000'),
          ask: quoteSide('f2222222-2222-4222-8222-222222222222', '31000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
      [
        'one-side-unflagged',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: 'set-2',
          accountId: 'mm-2',
          bid: quoteSide('f3333333-3333-4333-8333-333333333333', '29000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
      [
        'blank-set',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: '',
          accountId: 'mm-2',
          oneSided: true,
          bid: quoteSide('f4444444-4444-4444-8444-444444444444', '29000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
      [
        'mmp-blank',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: 'set-3',
          accountId: 'mm-2',
          oneSided: true,
          mmp: true,
          mmpMaxQuote: '',
          bid: quoteSide('f5555555-5555-4555-8555-555555555555', '29000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
    ],
  },
  {
    file: 'orders-cancel',
    method: 'DELETE',
    body: false,
    own: [
      ['valid', `/markets/${MARKET}/orders/${ORDER}`],
      ['unknown-order', `/markets/${MARKET}/orders/${SPREAD_ORDER}`],
      ['unknown-market', `/markets/${UNKNOWN}/orders/${ORDER}`],
    ],
  },
  {
    file: 'mass-cancel',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/orders/mass-cancel`, { accountId: 'mm-2' }],
      ['one-side', `/markets/${MARKET}/orders/mass-cancel`, { accountId: 'mm', side: 'sell' }],
      ['session', `/markets/${MARKET}/orders/mass-cancel`, { accountId: 'mm', sessionId: 'sess-1' }],
    ],
  },
  {
    file: 'session-dead',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/session/dead', { sessionId: 'sess-1' }],
      ['blank', '/session/dead', { sessionId: '' }],
    ],
  },
  {
    file: 'reconcile',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/reconcile', { orders: [{ orderId: RESTING, marketId: MARKET, state: 'open', remaining: '2', funded: true }] }],
      ['unknown-order', '/reconcile', { orders: [{ orderId: 'ghost', marketId: MARKET, state: 'open', remaining: '1', funded: false }] }],
      ['none', '/reconcile', { orders: [] }],
    ],
  },
  { file: 'spreads', method: 'GET', body: false, own: [['valid', '/spreads']] },
  {
    file: 'spread-list',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/spreads/${SPREAD}/list`, spreadListing],
      ['blank-tick', `/spreads/${SPREAD}/list`, { ...spreadListing, tick: '' }],
      ['no-approval', `/spreads/${SPREAD}/list`, { ...spreadListing, approvalId: undefined, operationId: undefined }],
    ],
  },
  {
    file: 'spread-orders',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/spreads/${SPREAD}/orders`, spreadOrder],
      [
        'no-anchor',
        `/spreads/${SPREAD}/orders`,
        { ...spreadOrder, orderId: 'dddddddd-dddd-4ddd-8ddd-000000000001', anchorReference: null },
      ],
      ['negative-price', `/spreads/${SPREAD}/orders`, { ...spreadOrder, orderId: 'dddddddd-dddd-4ddd-8ddd-000000000002', price: '-5' }],
      ['unlisted', `/spreads/NOPE-SPREAD/orders`, { ...spreadOrder, lifecycleProof: proof('NOPE-SPREAD', 'PLACE') }],
    ],
  },
  {
    file: 'spread-book',
    method: 'GET',
    body: false,
    own: limits(`/spreads/${SPREAD}/book`, [['unlisted', '/spreads/NOPE-SPREAD/book?limit=10']]),
  },
  { file: 'rulebook', method: 'GET', body: false, own: [['valid', '/rulebook']] },
  { file: 'rulebook-versions', method: 'GET', body: false, own: [['valid', '/rulebook/versions']] },
  {
    file: 'operator-rulebook-check',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/operator/rulebook/check', draft],
      ['section-unset', '/operator/rulebook/check', { ...draft, sections: { ...sections('TEST-v1'), fees: '' } }],
      ['no-version', '/operator/rulebook/check', { sections: sections('TEST-v1') }],
    ],
  },
  {
    file: 'operator-rulebook-publish',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/operator/rulebook/publish', { ...draft, approvalId: 'appr-r1', operationId: 'op-r1' }],
      ['same-again', '/operator/rulebook/publish', { ...draft, approvalId: 'appr-r2', operationId: 'op-r2' }],
      [
        'other-text',
        '/operator/rulebook/publish',
        { ...draft, sections: { ...sections('TEST-v1'), fees: 'TEST other fees.' }, approvalId: 'appr-r3', operationId: 'op-r3' },
      ],
    ],
  },
  {
    file: 'rulebook-after',
    method: 'GET',
    body: false,
    own: [
      ['valid', '/rulebook'],
      ['versions', '/rulebook/versions'],
    ],
  },
  { file: 'surveillance-cases', method: 'GET', body: false, own: limits('/surveillance/cases') },
  {
    file: 'surveillance-adjudicate',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/surveillance/adjudicate', { reason: 'TEST reviewed' }],
      ['no-reason', '/surveillance/adjudicate', {}],
    ],
  },
  { file: 'surveillance-fine', method: 'POST', body: true, own: [['valid', '/surveillance/fine', { amount: '10' }]] },
  { file: 'operator-in-flight', method: 'GET', body: false, own: [['valid', '/operator/in-flight']] },
  killDoor('post-only', `/markets/${MARKET}/post-only`),
  killDoor('post-only-resume', `/markets/${MARKET}/post-only/resume`),
  killDoor('reduce-only', `/markets/${MARKET}/reduce-only`),
  killDoor('reduce-only-resume', `/markets/${MARKET}/reduce-only/resume`),
  killDoor('prelaunch', `/markets/ETH-USDT/prelaunch`),
  killDoor('open', `/markets/ETH-USDT/open`),
  killDoor('halt', `/markets/${MARKET}/halt`),
  killDoor('resume', `/markets/${MARKET}/resume`),
  founderDoor('operator-halt', '/operator/halt', true),
  founderDoor('operator-resume', '/operator/resume', true),
  killDoor('halt-all', '/halt-all'),
  killDoor('resume-all', '/resume-all'),
  founderDoor('operator-halt-all', '/operator/halt-all', false),
  founderDoor('operator-resume-all', '/operator/resume-all', false),
  killDoor('expire', `/markets/ETH-USDT/expire`),
  killDoor('delist', `/markets/ETH-USDT/delist`),
  {
    file: 'after',
    method: 'GET',
    body: false,
    own: [
      ['markets', '/markets'],
      ['spreads', '/spreads'],
      ['health', '/health'],
      ['depth', `/markets/${MARKET}/depth?limit=10`],
      ['in-flight', '/operator/in-flight'],
    ],
  },
];

/** A body door also gets: none; null; a wrong type; an empty object; its valid body plus a key; its valid body with every field null. */
function inputs(door: Door): readonly Input[] {
  if (!door.body) return door.own;
  const [, url, valid] = door.own[0]!;
  const object = valid !== null && typeof valid === 'object' ? (valid as Record<string, unknown>) : {};
  return [
    ...door.own,
    ['absent', url, undefined],
    ['null', url, null],
    ['wrong-type', url, 7],
    ['empty', url, {}],
    ['extra-key', url, { ...object, extra: 1 }],
    ['all-null', url, Object.fromEntries(Object.keys(object).map((k) => [k, null]))],
  ];
}

// ── The callers ────────────────────────────────────────────────────────────

type Caller = (payload: string) => Record<string, string>;

function edge(scopes: string[], mfa: boolean, secret: string): Record<string, string> {
  const principal: Principal = {
    sub: OPERATOR,
    userId: OPERATOR,
    scopes,
    tier: 'institutional',
    mfa,
    sid: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, REGION),
    'x-intafaced-region': REGION,
  };
}

const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', () => ({})],
  ['svc-trade', (payload) => serviceAuthHeadersForBody('svc-trade', SECRET, payload, { now: NOW })],
  ['svc-execution', (payload) => serviceAuthHeadersForBody('svc-execution', SECRET, payload, { now: NOW })],
  ['svc-ledger', (payload) => serviceAuthHeadersForBody('svc-ledger', SECRET, payload, { now: NOW })],
  ['svc-trade-unbound', () => serviceAuthHeaders('svc-trade', SECRET, { now: NOW })],
  ['svc-trade-wrong-secret', (payload) => serviceAuthHeadersForBody('svc-trade', WRONG_SECRET, payload, { now: NOW })],
  ['founder', () => edge(['admin:read', 'admin:write'], true, EDGE_SECRET)],
  ['reader', () => edge(['admin:read'], false, EDGE_SECRET)],
  ['founder-wrong-secret', () => edge(['admin:read', 'admin:write'], true, WRONG_EDGE_SECRET)],
];

// ── Replay ─────────────────────────────────────────────────────────────────

interface Answer {
  readonly status: number;
  readonly type: string | null;
  readonly body: string;
}

async function hit(app: FastifyInstance, method: Method, url: string, body: unknown, caller: Caller): Promise<Answer> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const res = await app.inject({
    method,
    url,
    headers: { ...caller(payload), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload }),
  });
  const type = res.headers['content-type'];
  const binary = typeof type === 'string' && type.startsWith('application/octet-stream');
  // `/health`'s latency percentiles are the bucket bound a wall-clock reply time fell in, which moves with the machine.
  return {
    status: res.statusCode,
    type: typeof type === 'string' ? type : null,
    body: binary ? `base64:${res.rawPayload.toString('base64')}` : res.body.replace(/"p(50|99)Ms":\d+/g, '"p$1Ms":0'),
  };
}

const mounted = new Set<string>();
const reached = new Set<string>();

async function replay(): Promise<Record<string, Record<string, Answer>>> {
  const byFile: Record<string, Record<string, Answer>> = {};
  for (const [setupName, make] of SETUPS) {
    const setup = make();
    const app = await serve(setup);
    try {
      for (const door of DOORS) {
        const answers = (byFile[door.file] ??= {});
        for (const [inputName, url, body] of inputs(door))
          for (const [callerName, caller] of CALLERS) {
            answers[`${setupName} ${door.method} ${url} ${inputName} ${callerName}`] = await hit(app, door.method, url, body, caller);
          }
      }
    } finally {
      await app.close();
    }
  }
  return byFile;
}

describe('the wire replay: svc-matching answers as main did on 2026-11-19', () => {
  it('every request in the matrix gets the recorded status, content type and body, byte for byte', async () => {
    const now = await replay();
    expect([...mounted].filter((door) => !reached.has(door)).sort()).toEqual([]);
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.WIRE_REPLAY_WRITE === '1') {
      mkdirSync(GOLDEN, { recursive: true });
      for (const [file, answers] of Object.entries(now)) writeFileSync(goldenJson(file), json(answers));
    }
    const files = readdirSync(GOLDEN)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(Object.keys(now).sort());
    const diffs: string[] = [];
    for (const file of files) {
      const golden = JSON.parse(readFileSync(goldenJson(file), 'utf8')) as Record<string, Answer>;
      const answers = now[file]!;
      expect(Object.keys(answers)).toEqual(Object.keys(golden));
      for (const [key, was] of Object.entries(golden)) {
        const is = answers[key];
        if (is?.status !== was.status || is?.type !== was.type || is?.body !== was.body)
          diffs.push(`${key}: ${was.status} ${was.body.slice(0, 160)} != ${is?.status} ${is?.body.slice(0, 160)}`);
      }
    }
    expect(diffs).toEqual([]);
  });
});

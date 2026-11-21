import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, serviceAuthHeaders, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createSbeCodec } from '@intafaced/sbe-codec';
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
import { CONFIRM, DOORS, MARKET, type Method, NOW, OPERATOR, RESTING, inputs, proof } from './wire-replay-matrix.js';

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

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

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

import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import {
  QUANT_LIBRARY_BROWSE,
  QUANT_LIBRARY_CHECK,
  QUANT_LIBRARY_CLONE,
  QUANT_LIBRARY_GET,
  QUANT_LIBRARY_GRANT,
  QUANT_LIBRARY_LINEAGE,
  QUANT_LIBRARY_MINE,
  QUANT_LIBRARY_PREVIEW,
  QUANT_LIBRARY_PROCEDURES,
  QUANT_LIBRARY_PUBLISH,
  QUANT_LIBRARY_REQUEST,
  QUANT_LIBRARY_REVIEW,
  QUANT_LIBRARY_REVOKE,
} from '@intafaced/contracts/quant-library-procedures';
import { tradeFeePort, tradeHistoryPort } from '../engine/ports.js';
import { createMemoryLibraryRepository } from '../library/memory-repository.js';
import { openLibraryRepository } from '../library/open.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { openStrategyRepository } from '../studio/open.js';

/**
 * The mounted side of each strategy library record (`library.*`): sent through the production Fastify adapter by a
 * signed customer, a refused sample is answered 400 (the input is malformed) with no refusal of svc-quant's own, and an
 * accepted one is answered or refused only by a refusal its record lists. Each refusal svc-quant sends leaves with the
 * status its record lists, under the strict check that fails on one the record does not list. The record's zod schema
 * and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-quant-library-samples-edge-secret-long-enough';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

function headers(userId: string): Record<string, string> {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  return { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') };
}
const signed = (userId: string) => edgeContext({ headers: headers(userId), id: `req-library-samples-${userId}` } as never);

/** The HTTP status tRPC gives each status a record lists. */
const HTTP: Record<string, number> = { BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 };

/** `index.ts`'s wiring from an empty environment: no database and no owner licences or checklist. */
const app = Fastify();

beforeAll(async () => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createQuantRouter({
        wired: true,
        venueVaultSet: false,
        limits: { maxOps: undefined, maxSource: undefined },
        library: { repository: openLibraryRepository({}).repository, licences: null, checklist: null },
      }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

type LibraryRecord = (typeof QUANT_LIBRARY_PROCEDURES)[number];

async function send(record: LibraryRecord, input: unknown) {
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: headers(OWNER) })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...headers(OWNER), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}
/** svc-quant's own refusal code on a tRPC error reply, if it carries one. */
const causeOf = (body: string): string | undefined =>
  (JSON.parse(body) as { error?: { data?: { cause?: { code?: string } } } }).error?.data?.cause?.code;

const cases = QUANT_LIBRARY_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-quant's library routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') {
      expect(res.statusCode, res.body).toBe(400);
      expect(causeOf(res.body), res.body).toBeUndefined();
    } else if (res.statusCode !== 200) {
      const code = causeOf(res.body);
      expect(code, res.body).toBeDefined();
      expect(res.statusCode, res.body).toBe(HTTP[record.refusals[code!]!]);
    }
  });
});

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const NOW = T0 + 48 * HOUR;
const CLOSES = ['100', '100', '100', '110', '120', '130', '115', '100'];
const LICENCES = ['TEST open licence'];
const CHECKLIST = { version: 'TEST v1', items: ['TEST results are simulated'] };
const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const candles = () =>
  CLOSES.map((close, i) => {
    const open = i === 0 ? close : CLOSES[i - 1]!;
    return [T0 + i * HOUR, open, String(Math.max(+open, +close)), String(Math.min(+open, +close)), close, '1'];
  });
const fetch = async (url: string) => {
  const path = url.replace('http://trade.test', '').split('?')[0]!;
  const body =
    path === '/api/v1/ohlcv/BTC%2FUSDT' ? candles() : { version: 'local-test:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } };
  return { ok: true, status: 200, json: async () => body };
};

describe('each refusal leaves with the status its record lists', () => {
  function wired(owner: { licences?: string[] | null; checklist?: typeof CHECKLIST | null } = {}) {
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(),
      runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES),
      history: tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch }),
      fees: tradeFeePort({ tradeUrl: 'http://trade.test', fetch }),
      now: () => NOW,
      library: {
        repository: createMemoryLibraryRepository(),
        licences: owner.licences === undefined ? LICENCES : owner.licences,
        checklist: owner.checklist === undefined ? CHECKLIST : owner.checklist,
      },
    });
    return { owner: router.createCaller(signed(OWNER)), reader: router.createCaller(signed(READER)) };
  }
  type Caller = ReturnType<typeof wired>['owner'];
  const save = (who: Caller, name: string) =>
    who.studio.save({
      name,
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `client:${name}`,
      idempotencyKey: `studio.save:${name}`,
    });
  const backtest = (who: Caller, strategyId: string, strategyVersion = 1) =>
    who.backtest.start({
      strategyId,
      strategyVersion,
      cash: '1000',
      from: new Date(T0).toISOString(),
      to: new Date(T0 + CLOSES.length * HOUR).toISOString(),
      fillTiming: 'next_open',
      costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
    });
  const details = (strategyId: string, overrides: Record<string, unknown> = {}) => ({
    strategyId,
    strategyVersion: 1,
    title: 'TEST cross',
    description: 'Buys when the fast average crosses above the slow one. Every figure is simulated.',
    tags: ['trend' as const],
    visibility: 'open' as const,
    licence: LICENCES[0]!,
    ...overrides,
  });
  const publish = (who: Caller, strategyId: string, overrides: Record<string, unknown> = {}) =>
    who.library.publish({ ...details(strategyId, overrides), checklistVersion: CHECKLIST.version, checklistAccepted: true });
  /** A saved strategy with a finished backtest, listed with these details. */
  async function listed(who: Caller, name: string, overrides: Record<string, unknown> = {}) {
    const s = await save(who, name);
    await backtest(who, s.id);
    return publish(who, s.id, overrides);
  }

  const refusal = async (call: Promise<unknown>) => {
    const err = (await call.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(err, 'the call was refused').not.toBeNull();
    return { status: err!.code, code: err!.cause?.code };
  };
  const asListed = (record: LibraryRecord, code: string) => ({ status: record.refusals[code], code });

  it('no database wired, or no pool size, refuses by name on every call that reads the library', async () => {
    for (const env of [{}, { DATABASE_URL: 'postgres://quant.test/quant' }]) {
      const code = 'DATABASE_URL' in env ? 'quant.database_pool_max_unset' : 'quant.database_url_unset';
      const router = createQuantRouter({
        wired: true,
        venueVaultSet: false,
        limits: { maxOps: 5_000, maxSource: 8_000 },
        strategies: openStrategyRepository(env).repository,
        library: { repository: openLibraryRepository(env).repository, licences: LICENCES, checklist: CHECKLIST },
      });
      const c = router.createCaller(signed(OWNER));
      const listing = { listingId: 'l-1' };
      const access = { ...listing, userId: READER, seq: 0 };
      expect(await refusal(c.library.check(details('s-1')))).toEqual(asListed(QUANT_LIBRARY_CHECK, code));
      expect(await refusal(publish(c, 's-1'))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, code));
      expect(await refusal(c.library.mine())).toEqual(asListed(QUANT_LIBRARY_MINE, code));
      expect(await refusal(c.library.browse({ limit: 10 }))).toEqual(asListed(QUANT_LIBRARY_BROWSE, code));
      expect(await refusal(c.library.preview(listing))).toEqual(asListed(QUANT_LIBRARY_PREVIEW, code));
      expect(await refusal(c.library.get(listing))).toEqual(asListed(QUANT_LIBRARY_GET, code));
      expect(await refusal(c.library.request({ ...listing, seq: 0 }))).toEqual(asListed(QUANT_LIBRARY_REQUEST, code));
      expect(await refusal(c.library.grant(access))).toEqual(asListed(QUANT_LIBRARY_GRANT, code));
      expect(await refusal(c.library.revoke(access))).toEqual(asListed(QUANT_LIBRARY_REVOKE, code));
      expect(await refusal(c.library.clone(listing))).toEqual(asListed(QUANT_LIBRARY_CLONE, code));
      expect(await refusal(c.library.lineage({ strategyId: 's-1' }))).toEqual(asListed(QUANT_LIBRARY_LINEAGE, code));
      expect(await refusal(c.library.review({ ...listing, text: 'TEST' }))).toEqual(asListed(QUANT_LIBRARY_REVIEW, code));
    }
  });

  it('a listing that is not there refuses quant.listing_not_found on every call that names one', async () => {
    const { owner } = wired();
    const listing = { listingId: 'l-missing' };
    const access = { ...listing, userId: READER, seq: 0 };
    const code = 'quant.listing_not_found';
    expect(await refusal(owner.library.preview(listing))).toEqual(asListed(QUANT_LIBRARY_PREVIEW, code));
    expect(await refusal(owner.library.get(listing))).toEqual(asListed(QUANT_LIBRARY_GET, code));
    expect(await refusal(owner.library.request({ ...listing, seq: 0 }))).toEqual(asListed(QUANT_LIBRARY_REQUEST, code));
    expect(await refusal(owner.library.grant(access))).toEqual(asListed(QUANT_LIBRARY_GRANT, code));
    expect(await refusal(owner.library.revoke(access))).toEqual(asListed(QUANT_LIBRARY_REVOKE, code));
    expect(await refusal(owner.library.clone(listing))).toEqual(asListed(QUANT_LIBRARY_CLONE, code));
    expect(await refusal(owner.library.review({ ...listing, text: 'TEST' }))).toEqual(asListed(QUANT_LIBRARY_REVIEW, code));
  });

  it('a strategy that is not the caller’s refuses quant.studio_not_found on check, publish and lineage', async () => {
    const { owner } = wired();
    const code = 'quant.studio_not_found';
    expect(await refusal(owner.library.check(details('s-missing')))).toEqual(asListed(QUANT_LIBRARY_CHECK, code));
    expect(await refusal(publish(owner, 's-missing'))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, code));
    expect(await refusal(owner.library.lineage({ strategyId: 's-missing' }))).toEqual(asListed(QUANT_LIBRARY_LINEAGE, code));
  });

  it("check's and publish's own refusals", async () => {
    const blank = wired({ licences: null, checklist: null });
    const b = await save(blank.owner, 'blank');
    const unset = 'quant.library_licences_unset';
    expect(await refusal(blank.owner.library.check(details(b.id)))).toEqual(asListed(QUANT_LIBRARY_CHECK, unset));
    expect(await refusal(publish(blank.owner, b.id))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, unset));

    const { owner } = wired();
    const s = await save(owner, 'checks');
    const bad = 'quant.params_invalid';
    expect(await refusal(owner.library.check(details(s.id, { title: '  ' })))).toEqual(asListed(QUANT_LIBRARY_CHECK, bad));
    expect(await refusal(publish(owner, s.id, { description: ' ' }))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, bad));
    // No finished backtest of version 1: the backtest check fails.
    expect(await refusal(publish(owner, s.id))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, 'quant.listing_check_failed'));
    await backtest(owner, s.id);
    expect(
      await refusal(owner.library.publish({ ...details(s.id), checklistVersion: CHECKLIST.version, checklistAccepted: false })),
    ).toEqual(asListed(QUANT_LIBRARY_PUBLISH, 'quant.realism_checklist_unaccepted'));
    // A second version makes version 1 stale.
    await owner.studio.update({
      id: s.id,
      name: 'checks v2',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      idempotencyKey: 'studio.update:checks:2',
    });
    expect(await refusal(publish(owner, s.id))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, 'quant.listing_stale'));

    const noList = wired({ checklist: null });
    const n = await save(noList.owner, 'no-checklist');
    await backtest(noList.owner, n.id);
    expect(await refusal(publish(noList.owner, n.id))).toEqual(asListed(QUANT_LIBRARY_PUBLISH, 'quant.realism_checklist_unset'));
  });

  it('browse refuses a cursor it did not give', async () => {
    const { reader } = wired();
    expect(await refusal(reader.library.browse({ limit: 10, cursor: 'nope' }))).toEqual(
      asListed(QUANT_LIBRARY_BROWSE, 'quant.list_cursor_invalid'),
    );
  });

  it('access, clone and review refuse by name', async () => {
    const { owner, reader } = wired();
    const open = await listed(owner, 'open');
    const invite = await listed(owner, 'invite', { visibility: 'invite' });
    const prot = await listed(owner, 'protected', { visibility: 'protected' });
    const bad = 'quant.params_invalid';
    const denied = 'quant.listing_access_denied';

    // Only another person's invite-only listing takes a request; only an invite-only one, and another account, a grant.
    expect(await refusal(reader.library.request({ listingId: open.listingId, seq: 0 }))).toEqual(asListed(QUANT_LIBRARY_REQUEST, bad));
    expect(await refusal(owner.library.grant({ listingId: invite.listingId, userId: OWNER, seq: 0 }))).toEqual(
      asListed(QUANT_LIBRARY_GRANT, bad),
    );
    expect(await refusal(owner.library.revoke({ listingId: open.listingId, userId: READER, seq: 0 }))).toEqual(
      asListed(QUANT_LIBRARY_REVOKE, bad),
    );

    expect(await refusal(reader.library.get({ listingId: invite.listingId }))).toEqual(asListed(QUANT_LIBRARY_GET, denied));
    expect(await refusal(reader.library.clone({ listingId: invite.listingId }))).toEqual(asListed(QUANT_LIBRARY_CLONE, denied));
    expect(await refusal(reader.library.review({ listingId: invite.listingId, text: 'TEST' }))).toEqual(
      asListed(QUANT_LIBRARY_REVIEW, denied),
    );
    expect(await refusal(reader.library.clone({ listingId: prot.listingId }))).toEqual(
      asListed(QUANT_LIBRARY_CLONE, 'quant.listing_source_protected'),
    );

    expect(await refusal(reader.library.review({ listingId: open.listingId, text: '  ' }))).toEqual(asListed(QUANT_LIBRARY_REVIEW, bad));
    expect(await refusal(reader.library.review({ listingId: open.listingId, text: 'TEST clear rules.' }))).toEqual(
      asListed(QUANT_LIBRARY_REVIEW, 'quant.review_needs_run'),
    );
    const { strategyId } = await reader.library.clone({ listingId: open.listingId });
    await backtest(reader, strategyId);
    expect(await refusal(reader.library.review({ listingId: open.listingId, text: 'It made 30% a month.' }))).toEqual(
      asListed(QUANT_LIBRARY_REVIEW, 'quant.listing_check_failed'),
    );
  });
});

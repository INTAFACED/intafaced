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
import { parseAmount } from '@intafaced/ledger-client/money';
import type { ProcedureRecord, ProcedureSample } from '@intafaced/contracts/procedure';
import { QUANT_LIVE_PROCEDURES } from '@intafaced/contracts/quant-live-procedures';
import { QUANT_PAPER_PROCEDURES } from '@intafaced/contracts/quant-paper-procedures';
import type { Bar } from '../engine/bars.js';
import type { FeePort, HistoryPort } from '../engine/ports.js';
import { createMemoryLifecycleRepository } from '../lifecycle/memory-repository.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter, type QuantRouterDeps } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { openRunRepository } from '../runs/open.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { openStrategyRepository } from '../studio/open.js';

/**
 * The mounted side of each live deploy and paper run record (`live.*`, `paper.*`): sent through the production Fastify
 * adapter by a signed customer, a refused sample is answered 400 (the input is malformed), an accepted one never is.
 * Each refusal svc-quant sends leaves with the status its record lists, under the strict check that fails on one the
 * record does not list. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-quant-live-paper-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

function headers(userId = USER, scopes = ['trade:read', 'trade:write']): Record<string, string> {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  return { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') };
}
const signed = (userId = USER, scopes?: string[]) => edgeContext({ headers: headers(userId, scopes), id: `req-${userId}` } as never);

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const HOUR = 3_600_000;

/** `index.ts`'s wiring from an empty environment: no database, so a call that reads a strategy refuses unset. */
const app = Fastify();

beforeAll(async () => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createQuantRouter({ wired: true, venueVaultSet: false, limits: { maxOps: undefined, maxSource: undefined } }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

const RECORDS = [...QUANT_LIVE_PROCEDURES, ...QUANT_PAPER_PROCEDURES] as const;
type LivePaperRecord = (typeof RECORDS)[number];

async function send(record: LivePaperRecord, input: unknown) {
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: headers() })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...headers(), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

const cases = RECORDS.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-quant's live and paper routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else if (res.statusCode !== 200) {
      // Past the input: the call reached its handler, which refused with one of its record's own refusals.
      expect(res.statusCode, res.body).not.toBe(400);
      expect(
        Object.keys((record as ProcedureRecord).refusals).some((code) => res.body.includes(code)),
        res.body,
      ).toBe(true);
    }
  });
});

describe('each refusal leaves with the status its record lists', () => {
  const [lCheck, lDeploy] = QUANT_LIVE_PROCEDURES;
  const [pStart, pStop, pList, pGet] = QUANT_PAPER_PROCEDURES;

  /** Closed hourly bars of one flat price, for any window. */
  const history: HistoryPort = {
    wired: true,
    async bars({ fromMs, toMs }) {
      const bars: Bar[] = [];
      for (let t = Math.ceil(fromMs / HOUR) * HOUR; t + HOUR <= toMs; t += HOUR) {
        const p = parseAmount('100');
        bars.push({ openTimeMs: t, open: p, high: p, low: p, close: p });
      }
      return bars;
    },
  };

  function wired(deps: Partial<QuantRouterDeps> = {}) {
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(),
      lifecycle: createMemoryLifecycleRepository(),
      ...deps,
    });
    let n = 0;
    const writer = router.createCaller(signed(OPERATOR, ['admin:write']));
    return {
      caller: router.createCaller(signed()),
      live: (value: string) =>
        writer.ops.criteria.set({ name: 'live.enabled', value, reason: 'LOCAL TEST', idempotencyKey: `live:${(n += 1)}` }),
      writer,
    };
  }
  type Caller = ReturnType<typeof wired>['caller'];
  async function saved(caller: Caller, name: string, plan: { modules?: QuantSignalRules; blocks?: boolean } = {}) {
    const out = await caller.studio.save({
      name,
      blocks: plan.blocks ? [{ side: 'buy', symbol: 'BTC/USDT', qty: '1' }] : [],
      modules: plan.blocks ? null : (plan.modules ?? RULES),
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `client-${name}`,
      idempotencyKey: `save-${name}`,
    });
    return out.id;
  }
  const start = (strategyId: string, more: Record<string, unknown> = {}) => ({
    strategyId,
    strategyVersion: 1,
    cash: '1000',
    holdings: [] as { symbol: string; qty: string }[],
    feed: 'own_venue',
    costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
    ordinal: 0,
    ...more,
  });
  const refusal = async (call: Promise<unknown>) => {
    const err = (await call.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(err, 'the call was refused').not.toBeNull();
    return { status: err!.code, code: err!.cause?.code };
  };
  const listed = (record: LivePaperRecord, code: string) => {
    expect(Object.keys(record.refusals), `${record.name} lists ${code}`).toContain(code);
    return { status: record.refusals[code], code };
  };

  it('no database wired, or wired without a pool size, refuses by name on all six', async () => {
    for (const [env, code] of [
      [{}, 'quant.database_url_unset'],
      [{ DATABASE_URL: 'postgres://local-test/none' }, 'quant.database_pool_max_unset'],
    ] as const) {
      const { caller } = wired({ strategies: openStrategyRepository(env).repository, runs: openRunRepository(env).repository });
      const id = { strategyId: 's-1', strategyVersion: 1 };
      expect(await refusal(caller.live.check(id))).toEqual(listed(lCheck, code));
      expect(await refusal(caller.live.deploy({ ...id, amount: '' }))).toEqual(listed(lDeploy, code));
      expect(await refusal(caller.paper.start(start('s-1')))).toEqual(listed(pStart, code));
      expect(await refusal(caller.paper.stop({ runId: 'run_1' }))).toEqual(listed(pStop, code));
      expect(await refusal(caller.paper.list({ strategyId: 's-1', limit: 1 }))).toEqual(listed(pList, code));
      expect(await refusal(caller.paper.get({ runId: 'run_1' }))).toEqual(listed(pGet, code));
    }
  });

  it('a missing strategy or run refuses not found', async () => {
    const { caller } = wired({ runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES) });
    const id = { strategyId: 's-missing', strategyVersion: 1 };
    expect(await refusal(caller.live.check(id))).toEqual(listed(lCheck, 'quant.studio_not_found'));
    expect(await refusal(caller.live.deploy({ ...id, amount: '10' }))).toEqual(listed(lDeploy, 'quant.studio_not_found'));
    expect(await refusal(caller.paper.start(start('s-missing')))).toEqual(listed(pStart, 'quant.studio_not_found'));
    expect(await refusal(caller.paper.stop({ runId: 'run_missing' }))).toEqual(listed(pStop, 'quant.run_not_found'));
    expect(await refusal(caller.paper.get({ runId: 'run_missing' }))).toEqual(listed(pGet, 'quant.run_not_found'));
    expect(await refusal(caller.paper.list({ strategyId: 's-missing' }))).toEqual(listed(pList, 'quant.paper_list_limit_unset'));
  });

  it('a deploy refuses with the switch off, a version the runner cannot trade, and the funding move this build lacks', async () => {
    const { caller, live } = wired();
    const blocks = await saved(caller, 'TEST blocks', { blocks: true });
    const signal = await saved(caller, 'TEST signal');
    const deploy = (strategyId: string) => caller.live.deploy({ strategyId, strategyVersion: 1, amount: '10' });
    expect(await refusal(deploy(blocks))).toEqual(listed(lDeploy, 'quant.live_disabled'));
    await live('on');
    expect(await refusal(deploy(signal))).toEqual(listed(lDeploy, 'quant.live_plan_unsupported'));
    expect(await refusal(deploy(blocks))).toEqual(listed(lDeploy, 'quant.live_deploy_unavailable'));
  });

  it("a paper start's own refusals, before anything is stored", async () => {
    const { caller } = wired({ runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES) });
    const id = await saved(caller, 'TEST paper');
    const blocks = await saved(caller, 'TEST paper blocks', { blocks: true });
    expect(await refusal(caller.paper.start(start(id, { feed: 'pigeon' })))).toEqual(listed(pStart, 'quant.params_invalid'));
    expect(await refusal(caller.paper.start(start(blocks)))).toEqual(listed(pStart, 'quant.backtest_rules_required'));
    expect(await refusal(caller.paper.start(start(id, { cash: '' })))).toEqual(listed(pStart, 'quant.paper_cash_unset'));
    expect(await refusal(caller.paper.start(start(id, { costs: { feeRole: '', slippageBps: '5', delayBars: '0' } })))).toEqual(
      listed(pStart, 'quant.cost_unset'),
    );
  });

  it("a paper start counts against the account's plan", async () => {
    const none = wired({ runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, createMemoryQuota({ defaultProfile: null }).gate) });
    expect(await refusal(none.caller.paper.start(start(await saved(none.caller, 'TEST q0'))))).toEqual(
      listed(pStart, 'quant.quota_profile_unset'),
    );

    const blank = wired({
      runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, createMemoryQuota({ defaultProfile: 'TEST default' }).gate),
    });
    expect(await refusal(blank.caller.paper.start(start(await saved(blank.caller, 'TEST q1'))))).toEqual(
      listed(pStart, 'quant.quota_unset'),
    );

    const quota = createMemoryQuota({ defaultProfile: 'TEST default' });
    const full = wired({ runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate), quota: quota.repository });
    for (const [resource, limit] of Object.entries({ concurrent_runs: '0', runs: '10', storage: '10000000', paper_runs: '10' })) {
      await full.writer.ops.quota.set({
        profile: 'TEST default',
        resource: resource as 'runs',
        limit,
        reason: 'LOCAL TEST',
        idempotencyKey: `q:${resource}:${limit}`,
      });
    }
    expect(await refusal(full.caller.paper.start(start(await saved(full.caller, 'TEST q2'))))).toEqual(
      listed(pStart, 'quant.quota_exceeded'),
    );
  });

  it("a stored version whose rules don't compile (saved before save checked them) is refused by name on a start and every read", async () => {
    for (const [rules, code] of [
      [{ ...RULES, signal: { ...RULES.signal, fast: '' } }, 'quant.param_unset'],
      [{ ...RULES, signal: { ...RULES.signal, slow: '1' } }, 'quant.param_out_of_range'],
      [{ ...RULES, signal: { ...RULES.signal, fast: 'x' } }, 'quant.params_invalid'],
      [{ ...RULES, sizing: { kind: 'quantity', value: '' } }, 'quant.sizing_rule_unset'],
    ] as const) {
      // `studio.save` compiles the rules, so the stored version is read back as an older row would hold it.
      const store = createMemoryStrategyRepository();
      let broken: string | null = null;
      const strategies = {
        ...store,
        async get(input: { accountId: string; id: string }) {
          const found = await store.get(input);
          return found && found.id === broken
            ? { ...found, versions: found.versions.map((row) => ({ ...row, modules: rules as QuantSignalRules })) }
            : found;
        },
      };
      const { caller } = wired({ strategies, runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES) });
      const id = await saved(caller, `TEST ${code}`);
      broken = id;
      expect(await refusal(caller.paper.start(start(id)))).toEqual(listed(pStart, code));
      const [run] = (await caller.paper.list({ strategyId: id, limit: 1 })).runs;
      expect(await refusal(caller.paper.get({ runId: run!.runId }))).toEqual(listed(pGet, code));
      expect(await refusal(caller.paper.stop({ runId: run!.runId }))).toEqual(listed(pStop, code));
    }
  });

  it("once a bar has closed, a run's bars and published fee are read, each unwired one refused by name", async () => {
    for (const [deps, code] of [
      [{}, 'quant.backtest_lake_missing'],
      [{ history }, 'quant.cost_unset'],
    ] as const) {
      // The run's own start and stop times are the store's clock, so the clock itself moves on.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { caller } = wired({ runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES), ...deps });
        const id = await saved(caller, `TEST bars ${code}`);
        const run = await caller.paper.start(start(id));
        expect(run.priced).toBe(false);
        vi.setSystemTime(Date.now() + 3 * HOUR);
        expect(await refusal(caller.paper.get({ runId: run.runId }))).toEqual(listed(pGet, code));
        expect(await refusal(caller.paper.start(start(id)))).toEqual(listed(pStart, code));
        expect(await refusal(caller.paper.stop({ runId: run.runId }))).toEqual(listed(pStop, code));
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('a fee and bars wired, the same run reads priced: the refusals above are the only reason it did not', async () => {
    const fees: FeePort = { wired: true, fee: async () => ({ version: 'local-test:v1', makerBps: 8, takerBps: 10 }) };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { caller } = wired({ runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES), history, fees });
      const run = await caller.paper.start(start(await saved(caller, 'TEST priced')));
      vi.setSystemTime(Date.now() + 3 * HOUR);
      expect((await caller.paper.get({ runId: run.runId })).priced).toBe(true);
      expect((await caller.paper.stop({ runId: run.runId })).state).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });
});

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
import type { ProcedureSample, Refusals } from '@intafaced/contracts/procedure';
import {
  QUANT_BACKTEST_FEE,
  QUANT_BACKTEST_MONTE_CARLO,
  QUANT_BACKTEST_PROCEDURES,
  QUANT_BACKTEST_RENAME,
  QUANT_BACKTEST_RESULT,
  QUANT_BACKTEST_RUN,
  QUANT_BACKTEST_START,
} from '@intafaced/contracts/quant-backtest-procedures';
import { QUANT_SANDBOX_PROCEDURES, QUANT_SANDBOX_RUN } from '@intafaced/contracts/quant-sandbox-procedures';
import {
  QUANT_STUDIO_COMPILE,
  QUANT_STUDIO_DELETE,
  QUANT_STUDIO_DIFF,
  QUANT_STUDIO_GET,
  QUANT_STUDIO_LIST,
  QUANT_STUDIO_LIST_DELETED,
  QUANT_STUDIO_ORGANISE,
  QUANT_STUDIO_PROCEDURES,
  QUANT_STUDIO_RESTORE,
  QUANT_STUDIO_SAVE,
  QUANT_STUDIO_UPDATE,
} from '@intafaced/contracts/quant-studio-procedures';
import { QUANT_TEMPLATE_GET, QUANT_TEMPLATE_LIST, QUANT_TEMPLATE_PROCEDURES } from '@intafaced/contracts/quant-template-procedures';
import { tradeFeePort, tradeHistoryPort } from '../engine/ports.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter } from '../router.js';
import type { QuantRouterDeps } from './core.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';

/**
 * The mounted side of the studio (`studio.*`), the templates (`template.*`), the sandbox (`sandbox.*`) and the backtests
 * (`backtest.*`): sent through the production Fastify adapter by a signed customer, a
 * refused sample is answered 400 as malformed input, an accepted one is never refused for its input. Each refusal
 * svc-quant sends leaves with the status its record lists, under the strict check that fails on one the record does not
 * list. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-quant-studio-backtest-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

function headers(): Record<string, string> {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  return { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') };
}
const signed = () => edgeContext({ headers: headers(), id: 'req-studio-backtest-samples' } as never);

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const NOW = T0 + 48 * HOUR;
const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

const RECORDS = [
  ...QUANT_STUDIO_PROCEDURES,
  ...QUANT_TEMPLATE_PROCEDURES,
  ...QUANT_SANDBOX_PROCEDURES,
  ...QUANT_BACKTEST_PROCEDURES,
] as const;
type AreaRecord = (typeof RECORDS)[number];
/** A record's refusals read by any code: a code it does not list reads as undefined. */
const refusalsOf = (record: AreaRecord): Refusals => record.refusals;

/** `index.ts`'s wiring from an empty environment: no database, no fee or history read, no plan. */
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

async function send(record: AreaRecord, input: unknown) {
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

/** The named refusal a reply carries, if any: an input refused by its schema carries none. */
const namedCode = (body: string): string | undefined =>
  (JSON.parse(body) as { error?: { data?: { cause?: { code?: string } } } }).error?.data?.cause?.code;

const cases = RECORDS.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-quant's studio, template, sandbox and backtest routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') {
      expect(res.statusCode, res.body).toBe(400);
      expect(namedCode(res.body), res.body).toBeUndefined();
    } else if (res.statusCode !== 200) {
      // On the empty environment an accepted input still meets a named refusal its record lists, never an input error.
      const code = namedCode(res.body);
      expect(code, res.body).toBeDefined();
      expect(refusalsOf(record)[code!], res.body).toBeDefined();
    }
  });
});

describe('each refusal leaves with the status its record lists', () => {
  /** A router on memory stores with the trade reads answered by a fake svc-trade. */
  function wired(
    over: Partial<QuantRouterDeps> = {},
    sandbox = { wall_clock_ms: 5_000n, memory_bytes: 1_000_000n, output_bytes: 1_000_000n },
  ) {
    const fetch = async (url: string) => {
      const path = url.replace('http://trade.test', '').split('?')[0]!;
      if (path === '/api/v1/fees/published') {
        return { ok: true, status: 200, json: async () => ({ version: 'TEST:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(),
      quota: createMemoryQuota({ defaultProfile: 'TEST plan', sandbox }).repository,
      paperFeeBps: '0',
      history: tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch: fetch as never }),
      fees: tradeFeePort({ tradeUrl: 'http://trade.test', fetch: fetch as never }),
      now: () => NOW,
      ...over,
    });
    return router.createCaller(signed());
  }
  type Caller = ReturnType<typeof wired>;
  async function saved(caller: Caller, modules: QuantSignalRules | null = RULES, key = 'save-1') {
    const out = await caller.studio.save({
      name: 'TEST strategy',
      blocks: modules ? [] : [{ side: 'buy', symbol: 'BTC/USDT', qty: '1' }],
      modules,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `client-${key}`,
      idempotencyKey: key,
    });
    return out.id;
  }
  const refusal = async (call: Promise<unknown>) => {
    const err = (await call.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(err, 'the call was refused').not.toBeNull();
    return { status: err!.code, code: err!.cause?.code };
  };
  const listed = (record: AreaRecord, code: string) => ({ status: refusalsOf(record)[code], code });

  it('studio.list and studio.get', async () => {
    const caller = wired();
    expect(await refusal(caller.studio.list({}))).toEqual(listed(QUANT_STUDIO_LIST, 'quant.studio_list_limit_unset'));
    expect(await refusal(caller.studio.list({ limit: 5, cursor: 'nope' }))).toEqual(listed(QUANT_STUDIO_LIST, 'quant.list_cursor_invalid'));
    expect(await refusal(caller.studio.get({ id: 's-missing' }))).toEqual(listed(QUANT_STUDIO_GET, 'quant.studio_not_found'));
    const noDatabase = wired({ strategies: undefined });
    expect(await refusal(noDatabase.studio.list({ limit: 5 }))).toEqual(listed(QUANT_STUDIO_LIST, 'quant.database_url_unset'));
    expect(await refusal(noDatabase.studio.get({ id: 's-1' }))).toEqual(listed(QUANT_STUDIO_GET, 'quant.database_url_unset'));
  });

  it('sandbox.run', async () => {
    const run = (over: Record<string, unknown> = {}) => ({
      language: 'javascript' as const,
      source: 'console.log("hello")',
      cash: '1000',
      environment: 'paper',
      idempotencyKey: `sbx-${Math.random()}`,
      ...over,
    });
    const caller = wired();
    const is = (code: string) => listed(QUANT_SANDBOX_RUN, code);
    await expect(caller.sandbox.run(run())).resolves.toMatchObject({ ok: true, logs: ['hello'] });
    expect(await refusal(caller.sandbox.run(run({ source: 'x'.repeat(8_001) })))).toEqual(is('quant.sandbox_syntax'));
    expect(await refusal(caller.sandbox.run(run({ idempotencyKey: undefined })))).toEqual(is('quant.idempotency_key_unset'));
    expect(await refusal(caller.sandbox.run(run({ idempotencyKey: 'k'.repeat(129) })))).toEqual(is('quant.params_invalid'));
    expect(await refusal(caller.sandbox.run(run({ environment: undefined })))).toEqual(is('quant.environment_required'));
    expect(await refusal(caller.sandbox.run(run({ environment: 'mars' })))).toEqual(is('quant.environment_unknown'));
    expect(await refusal(caller.sandbox.run(run({ presentedAs: 'live' })))).toEqual(is('quant.simulated_as_live'));
    expect(await refusal(caller.sandbox.run(run({ cash: undefined })))).toEqual(is('quant.cash_unset'));
    expect(await refusal(caller.sandbox.run(run({ source: 'process.exit(1)' })))).toEqual(is('quant.sandbox_escape'));
    expect(await refusal(caller.sandbox.run(run({ source: 'let s = "x"\n' + 's = s + s\n'.repeat(30) })))).toEqual(
      is('quant.sandbox_memory'),
    );
    const many = Array.from({ length: 200 }, (_, i) => `let v${i % 5} = "${i}"`).join('\n');
    expect(await refusal(wired({ limits: { maxOps: 100, maxSource: 8_000 } }).sandbox.run(run({ source: many })))).toEqual(
      is('quant.sandbox_timeout'),
    );
    const tiny = wired({}, { wall_clock_ms: 5_000n, memory_bytes: 1_000_000n, output_bytes: 10n });
    expect(await refusal(tiny.sandbox.run(run({ source: 'console.log("0123456789")\nconsole.log("0123456789")' })))).toEqual(
      is('quant.sandbox_output'),
    );
    expect(await refusal(wired({ wired: false }).sandbox.run(run()))).toEqual(is('quant.sandbox_unwired'));
    expect(await refusal(wired({ limits: { maxOps: undefined, maxSource: 8_000 } }).sandbox.run(run()))).toEqual(
      is('quant.sandbox_max_ops_unset'),
    );
    expect(await refusal(wired({ limits: { maxOps: 5_000, maxSource: undefined } }).sandbox.run(run()))).toEqual(
      is('quant.sandbox_max_source_unset'),
    );
    expect(await refusal(wired({ quota: createMemoryQuota({ defaultProfile: null }).repository }).sandbox.run(run()))).toEqual(
      is('quant.quota_profile_unset'),
    );
    expect(await refusal(wired({ quota: createMemoryQuota({ defaultProfile: 'TEST blank' }).repository }).sandbox.run(run()))).toEqual(
      is('quant.sandbox_limit_unset'),
    );
    expect(await refusal(wired({ paperFeeBps: null }).sandbox.run(run({ source: 'oms.buy("BTC-USD", "0.01");' })))).toEqual(
      is('quant.paper_fee_unset'),
    );
  });

  it('backtest.run', async () => {
    const caller = wired();
    const strategyId = await saved(caller);
    const is = (code: string) => listed(QUANT_BACKTEST_RUN, code);
    const run = (over: Record<string, unknown> = {}) => ({
      strategyId,
      symbol: 'BTC/USDT',
      walkForward: {
        inSampleFrom: new Date(T0).toISOString(),
        inSampleTo: new Date(T0 + 4 * HOUR).toISOString(),
        outOfSampleFrom: new Date(T0 + 4 * HOUR).toISOString(),
        outOfSampleTo: new Date(T0 + 8 * HOUR).toISOString(),
      },
      environment: 'backtest',
      idempotencyKey: `bt-${Math.random()}`,
      ...over,
    });
    expect(await refusal(caller.backtest.run(run({ idempotencyKey: undefined })))).toEqual(is('quant.idempotency_key_unset'));
    // A key already used for the strategy's save is not run again under another operation.
    expect(await refusal(caller.backtest.run(run({ idempotencyKey: 'save-1' })))).toEqual(is('quant.idempotency_conflict'));
    expect(await refusal(caller.backtest.run(run({ strategyId: 's-missing' })))).toEqual(is('quant.studio_not_found'));
    expect(await refusal(caller.backtest.run(run({ walkForward: null })))).toEqual(is('quant.backtest_walk_forward_required'));
    expect(await refusal(caller.backtest.run(run({ environment: undefined })))).toEqual(is('quant.environment_required'));
    expect(await refusal(caller.backtest.run(run({ environment: 'mars' })))).toEqual(is('quant.environment_unknown'));
    expect(await refusal(caller.backtest.run(run({ presentedAs: 'live' })))).toEqual(is('quant.simulated_as_live'));
    expect(await refusal(caller.backtest.run(run()))).toEqual(is('quant.backtest_lake_missing'));
    expect(await refusal(wired({ strategies: undefined }).backtest.run(run()))).toEqual(is('quant.database_url_unset'));
  });

  it('backtest.start and backtest.fee', async () => {
    const caller = wired();
    const strategyId = await saved(caller);
    const is = (code: string) => listed(QUANT_BACKTEST_START, code);
    const start = (over: Record<string, unknown> = {}) => ({
      strategyId,
      strategyVersion: 1,
      cash: '1000',
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 8 * HOUR).toISOString(),
      fillTiming: 'next_open',
      costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
      ...over,
    });
    expect(await refusal(caller.backtest.start(start({ strategyId: 's-missing' })))).toEqual(is('quant.studio_not_found'));
    expect(await refusal(caller.backtest.start(start({ costs: { feeRole: 'taker', slippageBps: '', delayBars: '0' } })))).toEqual(
      is('quant.cost_unset'),
    );
    expect(await refusal(caller.backtest.start(start({ fillTiming: '' })))).toEqual(is('quant.fill_timing_unset'));
    expect(await refusal(caller.backtest.start(start({ cash: '' })))).toEqual(is('quant.cash_unset'));
    expect(await refusal(caller.backtest.start(start({ to: new Date(NOW + HOUR).toISOString() })))).toEqual(
      is('quant.backtest_window_open'),
    );
    expect(await refusal(caller.backtest.start(start({ from: '2026-09-31T00:00Z' })))).toEqual(is('quant.backtest_window_invalid'));
    expect(await refusal(caller.backtest.start(start({ simulatedAccount: { leverage: '2' } })))).toEqual(is('quant.account_rule_unset'));
    expect(await refusal(caller.backtest.start(start()))).toEqual(is('quant.backtest_fills_missing'));
    const blocks = await saved(caller, null, 'save-blocks');
    expect(await refusal(caller.backtest.start(start({ strategyId: blocks })))).toEqual(is('quant.backtest_rules_required'));
    const unwired = wired({ history: undefined });
    const other = await saved(unwired);
    expect(await refusal(unwired.backtest.start(start({ strategyId: other })))).toEqual(is('quant.backtest_lake_missing'));
    expect(await refusal(wired({ strategies: undefined }).backtest.start(start()))).toEqual(is('quant.database_url_unset'));

    expect(await refusal(caller.backtest.fee({ symbol: 'NOPE/USDT' }))).toEqual(listed(QUANT_BACKTEST_FEE, 'quant.cost_unset'));
    expect(await refusal(wired({ fees: undefined }).backtest.fee({ symbol: 'BTC/USDT' }))).toEqual(
      listed(QUANT_BACKTEST_FEE, 'quant.cost_unset'),
    );
  });
  it('studio writes, compile, diff and the recycle bin', async () => {
    const caller = wired();
    const body = (over: Record<string, unknown> = {}) => ({
      name: 'TEST strategy',
      blocks: [{ side: 'buy' as const, symbol: 'BTC/USDT', qty: '1' }],
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `client-${Math.random()}`,
      idempotencyKey: `save-${Math.random()}`,
      ...over,
    });
    const save = (code: string) => listed(QUANT_STUDIO_SAVE, code);
    expect(await refusal(caller.studio.save(body({ idempotencyKey: undefined })))).toEqual(save('quant.idempotency_key_unset'));
    expect(await refusal(caller.studio.save(body({ clientStrategyId: undefined })))).toEqual(save('quant.client_strategy_id_unset'));
    expect(await refusal(caller.studio.save(body({ cash: undefined })))).toEqual(save('quant.cash_unset'));
    expect(await refusal(caller.studio.save(body({ risk: undefined })))).toEqual(save('quant.studio_risk_block_required'));
    expect(await refusal(caller.studio.save(body({ environment: undefined })))).toEqual(save('quant.environment_required'));
    expect(await refusal(caller.studio.save(body({ environment: 'mars' })))).toEqual(save('quant.environment_unknown'));
    expect(await refusal(caller.studio.save(body({ presentedAs: 'live' })))).toEqual(save('quant.simulated_as_live'));
    expect(await refusal(caller.studio.save(body({ releaseNote: 'TEST note' })))).toEqual(save('quant.release_note_limit_unset'));
    expect(await refusal(caller.studio.save(body({ blocks: [], modules: { ...RULES, sizing: { kind: 'quantity', value: '' } } })))).toEqual(
      save('quant.sizing_rule_unset'),
    );
    expect(await refusal(caller.studio.save(body({ blocks: [] })))).toEqual(save('quant.params_invalid'));
    expect(await refusal(wired({ strategies: undefined }).studio.save(body()))).toEqual(save('quant.database_url_unset'));

    const id = await saved(caller);
    const update = (code: string) => listed(QUANT_STUDIO_UPDATE, code);
    expect(await refusal(caller.studio.update({ ...body({ idempotencyKey: 'save-1' }), id }))).toEqual(
      update('quant.idempotency_conflict'),
    );
    expect(await refusal(caller.studio.update({ ...body(), id: 's-missing' }))).toEqual(update('quant.studio_not_found'));
    expect(await refusal(caller.studio.update({ ...body({ cash: undefined }), id }))).toEqual(update('quant.cash_unset'));

    const compile = (code: string) => listed(QUANT_STUDIO_COMPILE, code);
    expect(await refusal(caller.studio.compile({ modules: { ...RULES, sizing: { kind: 'quantity', value: '' } } }))).toEqual(
      compile('quant.sizing_rule_unset'),
    );
    expect(await refusal(caller.studio.compile({ modules: { ...RULES, signal: { ...RULES.signal, fast: '' } } }))).toEqual(
      compile('quant.param_unset'),
    );

    const diff = (code: string) => listed(QUANT_STUDIO_DIFF, code);
    expect(await refusal(caller.studio.diff({ id, from: 1, to: 9 }))).toEqual(diff('quant.version_not_found'));
    expect(await refusal(caller.studio.diff({ id: 's-missing', from: 1, to: 1 }))).toEqual(diff('quant.studio_not_found'));

    const organise = (code: string) => listed(QUANT_STUDIO_ORGANISE, code);
    expect(await refusal(caller.studio.organise({ id, name: 7, idempotencyKey: 'org-1' }))).toEqual(organise('quant.params_invalid'));
    expect(await refusal(caller.studio.organise({ id, name: 'TEST' }))).toEqual(organise('quant.idempotency_key_unset'));
    expect(await refusal(caller.studio.organise({ id: 's-missing', name: 'TEST', idempotencyKey: 'org-2' }))).toEqual(
      organise('quant.studio_not_found'),
    );

    const remove = (code: string) => listed(QUANT_STUDIO_DELETE, code);
    expect(await refusal(caller.studio.delete({ id }))).toEqual(remove('quant.idempotency_key_unset'));
    expect(await refusal(caller.studio.delete({ id: 's-missing', idempotencyKey: 'del-1' }))).toEqual(remove('quant.studio_not_found'));
    await expect(caller.studio.delete({ id, idempotencyKey: 'del-2' })).resolves.toEqual({ ok: true });
    expect(await refusal(caller.studio.restore({ id }))).toEqual(listed(QUANT_STUDIO_RESTORE, 'quant.idempotency_key_unset'));
    expect(await refusal(caller.studio.restore({ id: 's-missing', idempotencyKey: 'res-1' }))).toEqual(
      listed(QUANT_STUDIO_RESTORE, 'quant.studio_not_found'),
    );
    await expect(caller.studio.restore({ id, idempotencyKey: 'res-2' })).resolves.toMatchObject({ id, deletedAt: null });

    const bin = (code: string) => listed(QUANT_STUDIO_LIST_DELETED, code);
    expect(await refusal(caller.studio.listDeleted({}))).toEqual(bin('quant.studio_list_limit_unset'));
    expect(await refusal(caller.studio.listDeleted({ limit: 5, cursor: 'nope' }))).toEqual(bin('quant.list_cursor_invalid'));
  });

  it('templates', async () => {
    const caller = wired();
    expect(await refusal(caller.template.list({}))).toEqual(listed(QUANT_TEMPLATE_LIST, 'quant.template_list_limit_unset'));
    const noDatabase = wired({ templates: undefined });
    expect(await refusal(noDatabase.template.list({ limit: 5 }))).toEqual(listed(QUANT_TEMPLATE_LIST, 'quant.database_url_unset'));
    expect(await refusal(noDatabase.template.get({ id: 'ma-cross' }))).toEqual(listed(QUANT_TEMPLATE_GET, 'quant.database_url_unset'));
  });

  it('a stored run: its result, Monte Carlo, history and label', async () => {
    const caller = wired();
    expect(await refusal(caller.backtest.result({ runId: 'r-missing' }))).toEqual(listed(QUANT_BACKTEST_RESULT, 'quant.run_not_found'));
    const mc = (code: string) => listed(QUANT_BACKTEST_MONTE_CARLO, code);
    expect(await refusal(caller.backtest.monteCarlo({ runId: 'r-missing', seed: 1 }))).toEqual(mc('quant.run_not_found'));
    const rename = (code: string) => listed(QUANT_BACKTEST_RENAME, code);
    expect(await refusal(caller.backtest.rename({ runId: 'r-1', label: '  ' }))).toEqual(rename('quant.params_invalid'));
    expect(await refusal(caller.backtest.rename({ runId: 'r-missing', label: 'TEST' }))).toEqual(rename('quant.run_not_found'));
    expect(await refusal(caller.backtest.history({ limit: 5, cursor: 'nope' }))).toEqual({
      status: 'BAD_REQUEST',
      code: 'quant.list_cursor_invalid',
    });
  });
});

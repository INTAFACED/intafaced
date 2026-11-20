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
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import {
  QUANT_TEAM_GET,
  QUANT_TEAM_GRANT,
  QUANT_TEAM_LOCK,
  QUANT_TEAM_OPEN,
  QUANT_TEAM_ORDER,
  QUANT_TEAM_PAPER_RUNS,
  QUANT_TEAM_PROCEDURES,
  QUANT_TEAM_REMOVE,
  QUANT_TEAM_SAVE,
  QUANT_TEAM_SET,
  QUANT_TEAM_STOP,
  QUANT_TEAM_UNLOCK,
} from '@intafaced/contracts/quant-team-procedures';
import { QuantError } from '../errors.js';
import type { FeePort, HistoryPort } from '../engine/ports.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryTeamRepository } from '../team/memory-repository.js';

/**
 * The mounted side of each strategy-team record (`team.*`): sent through the production Fastify adapter by a signed
 * customer, a refused sample is answered 400 (the input is malformed), an accepted one never is. Each refusal svc-quant
 * sends leaves with the status its record lists, under the strict check that fails on one the record does not list. The
 * record's zod schema and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-quant-team-samples-edge-secret-long-enough';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

function headers(userId = OWNER, scopes = ['trade:read', 'trade:write']): Record<string, string> {
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
const signed = (userId: string, scopes?: string[]) =>
  edgeContext({ headers: headers(userId, scopes), id: `req-team-samples-${userId}` } as never);

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

/**
 * `index.ts`'s wiring from an empty environment. Its strategy and run stores have no database and refuse
 * `quant.database_url_unset`; its team store is the in-memory one, so a call that reads a team first finds no strategy.
 */
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

type TeamRecord = (typeof QUANT_TEAM_PROCEDURES)[number];

async function send(record: TeamRecord, input: unknown) {
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

const cases = QUANT_TEAM_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-quant's strategy-team routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else {
      // Past input checking, an accepted sample is answered (`team.shared`: no team, so nothing is shared) or refused by
      // this empty wiring with a refusal its record lists.
      expect(res.statusCode, res.body).not.toBe(400);
      if (res.statusCode === 200) {
        expect(record.output.safeParse((JSON.parse(res.body) as { result: { data: unknown } }).result.data).success, res.body).toBe(true);
        return;
      }
      const body = JSON.parse(res.body) as { error: { data: { code: string; cause?: { code?: string } } } };
      const code = body.error.data.cause?.code ?? '';
      expect(['quant.database_url_unset', 'quant.studio_not_found'], res.body).toContain(code);
      expect(body.error.data.code).toBe(record.refusals[code]);
    }
  });
});

describe('each refusal leaves with the status its record lists', () => {
  const HOUR = 3_600_000;
  /** The bars and fees a paper read sees; each case swaps in what it needs. */
  const ports: { bars: HistoryPort['bars']; fee: FeePort['fee'] } = {
    bars: async () => [],
    fee: async () => ({ version: 'local-test:v1', makerBps: 8, takerBps: 10 }),
  };
  const history: HistoryPort = { wired: true, bars: (query) => ports.bars(query) };
  const fees: FeePort = { wired: true, fee: (symbol) => ports.fee(symbol) };

  function wired(options: { editLockSeconds?: number | null; releaseNoteMax?: number | null; profile?: string | null } = {}) {
    const quota = createMemoryQuota({ defaultProfile: options.profile === undefined ? 'TEST default' : options.profile });
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(quota.gate),
      runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate),
      team: createMemoryTeamRepository(quota.gate),
      quota: quota.repository,
      editLockSeconds: options.editLockSeconds === undefined ? 20 : options.editLockSeconds,
      releaseNoteMax: options.releaseNoteMax === undefined ? 10 : options.releaseNoteMax,
      history,
      fees,
    });
    const writer = router.createCaller(signed('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ['admin:write']));
    return {
      owner: router.createCaller(signed(OWNER)),
      mate: router.createCaller(signed(MATE)),
      /** Every limit set, `collaborators` as given; blank leaves that one limit unset. */
      async plan(collaborators: string | null) {
        const limits: Record<string, string | null> = {
          strategies: '10',
          versions: '10',
          concurrent_runs: '10',
          paper_runs: '10',
          runs: '10',
          storage: '10000000',
          collaborators,
        };
        for (const [resource, limit] of Object.entries(limits)) {
          if (limit === null) continue;
          await writer.ops.quota.set({
            profile: 'TEST default',
            resource: resource as 'runs',
            limit,
            reason: 'LOCAL TEST',
            idempotencyKey: `q:${resource}:${limit}`,
          });
        }
      },
    };
  }
  type Wired = ReturnType<typeof wired>;
  async function saved(t: Wired) {
    const out = await t.owner.studio.save({
      name: 'TEST team',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-team-samples',
      idempotencyKey: 'save-team-samples',
    });
    return out.id;
  }
  async function shared(t: Wired, role: 'view' | 'edit', liveControl: boolean) {
    await t.plan('5');
    const strategyId = await saved(t);
    await t.owner.team.set({ strategyId, memberId: MATE, role, liveControl });
    return strategyId;
  }
  const startPaper = (t: Wired, strategyId: string) =>
    t.owner.paper.start({
      strategyId,
      strategyVersion: 1,
      cash: '1000',
      holdings: [],
      feed: 'own_venue',
      costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
      ordinal: 0,
    });
  const refusal = async (call: Promise<unknown>) => {
    const err = (await call.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(err, 'the call was refused').not.toBeNull();
    return { status: err!.code, code: err!.cause?.code };
  };
  const listed = (record: TeamRecord, code: string) => ({ status: record.refusals[code], code });

  it('a strategy that is not the caller’s, or not shared with them, refuses quant.studio_not_found on eleven', async () => {
    const t = wired();
    const strategyId = 's-missing';
    const code = 'quant.studio_not_found';
    expect(await refusal(t.owner.team.get({ strategyId }))).toEqual(listed(QUANT_TEAM_GET, code));
    expect(await refusal(t.owner.team.set({ strategyId, memberId: MATE, role: 'view', liveControl: false }))).toEqual(
      listed(QUANT_TEAM_SET, code),
    );
    expect(await refusal(t.owner.team.remove({ strategyId, memberId: MATE }))).toEqual(listed(QUANT_TEAM_REMOVE, code));
    expect(await refusal(t.owner.team.grant({ strategyId, seconds: 3600, seq: 0 }))).toEqual(listed(QUANT_TEAM_GRANT, code));
    expect(await refusal(t.mate.team.open({ strategyId }))).toEqual(listed(QUANT_TEAM_OPEN, code));
    expect(await refusal(t.mate.team.save({ strategyId, baseVersion: 1, name: 'TEST' }))).toEqual(listed(QUANT_TEAM_SAVE, code));
    expect(await refusal(t.mate.team.lock({ strategyId }))).toEqual(listed(QUANT_TEAM_LOCK, code));
    expect(await refusal(t.mate.team.unlock({ strategyId }))).toEqual(listed(QUANT_TEAM_UNLOCK, code));
    expect(await refusal(t.mate.team.paperRuns({ strategyId }))).toEqual(listed(QUANT_TEAM_PAPER_RUNS, code));
    expect(await refusal(t.mate.team.order({ strategyId, runId: 'r-1', side: 'buy', size: '1' }))).toEqual(listed(QUANT_TEAM_ORDER, code));
    expect(await refusal(t.mate.team.stop({ strategyId, runId: 'r-1' }))).toEqual(listed(QUANT_TEAM_STOP, code));
  });

  it("the owner's side: a bad member, each quota refusal, a bad grant", async () => {
    const t = wired();
    await t.plan('1');
    const strategyId = await saved(t);
    expect(await refusal(t.owner.team.set({ strategyId, memberId: 'not-an-account', role: 'view', liveControl: false }))).toEqual(
      listed(QUANT_TEAM_SET, 'quant.team_member_invalid'),
    );
    await t.owner.team.set({ strategyId, memberId: MATE, role: 'view', liveControl: false });
    expect(
      await refusal(t.owner.team.set({ strategyId, memberId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'view', liveControl: false })),
    ).toEqual(listed(QUANT_TEAM_SET, 'quant.quota_exceeded'));
    expect(await refusal(t.owner.team.grant({ strategyId, seconds: 5, seq: 0 }))).toEqual(listed(QUANT_TEAM_GRANT, 'quant.grant_invalid'));

    const blank = wired();
    await blank.plan(null);
    const blankId = await saved(blank);
    expect(await refusal(blank.owner.team.set({ strategyId: blankId, memberId: MATE, role: 'view', liveControl: false }))).toEqual(
      listed(QUANT_TEAM_SET, 'quant.quota_unset'),
    );
  });

  it('no default plan refuses quant.quota_profile_unset when a teammate is added', async () => {
    // The strategy store counts against no plan, so the save goes through; the team store's gate finds none.
    const strategies = createMemoryStrategyRepository();
    const quota = createMemoryQuota({ defaultProfile: null });
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies,
      team: createMemoryTeamRepository(quota.gate),
      quota: quota.repository,
      editLockSeconds: 20,
    });
    const owner = router.createCaller(signed(OWNER));
    const out = await owner.studio.save({
      name: 'TEST no plan',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-no-plan',
      idempotencyKey: 'save-no-plan',
    });
    expect(await refusal(owner.team.set({ strategyId: out.id, memberId: MATE, role: 'view', liveControl: false }))).toEqual(
      listed(QUANT_TEAM_SET, 'quant.quota_profile_unset'),
    );
  });

  it('view only: save, lock and unlock refuse quant.permission_denied', async () => {
    const t = wired();
    const strategyId = await shared(t, 'view', false);
    const code = 'quant.permission_denied';
    expect(await refusal(t.mate.team.save({ strategyId, baseVersion: 1, name: 'TEST' }))).toEqual(listed(QUANT_TEAM_SAVE, code));
    expect(await refusal(t.mate.team.lock({ strategyId }))).toEqual(listed(QUANT_TEAM_LOCK, code));
    expect(await refusal(t.mate.team.unlock({ strategyId }))).toEqual(listed(QUANT_TEAM_UNLOCK, code));
  });

  it('the edit lock: unset, held by another; the save: a missing base, a reused key, the note limit', async () => {
    const unset = wired({ editLockSeconds: null });
    const unsetId = await shared(unset, 'edit', false);
    expect(await refusal(unset.mate.team.lock({ strategyId: unsetId }))).toEqual(listed(QUANT_TEAM_LOCK, 'quant.edit_lock_unset'));
    expect(await refusal(unset.mate.team.save({ strategyId: unsetId, baseVersion: 1, name: 'TEST' }))).toEqual(
      listed(QUANT_TEAM_SAVE, 'quant.edit_lock_unset'),
    );

    const t = wired();
    const strategyId = await shared(t, 'edit', false);
    await t.owner.team.lock({ strategyId });
    expect(await refusal(t.mate.team.lock({ strategyId }))).toEqual(listed(QUANT_TEAM_LOCK, 'quant.edit_locked'));
    expect(await refusal(t.mate.team.save({ strategyId, baseVersion: 1, name: 'TEST' }))).toEqual(
      listed(QUANT_TEAM_SAVE, 'quant.edit_locked'),
    );
    await t.owner.team.unlock({ strategyId });

    expect(await refusal(t.mate.team.save({ strategyId, baseVersion: 9, name: 'TEST' }))).toEqual(
      listed(QUANT_TEAM_SAVE, 'quant.version_not_found'),
    );
    expect(await refusal(t.mate.team.save({ strategyId, baseVersion: 1, name: 'TEST', releaseNote: 'TEST note too long' }))).toEqual(
      listed(QUANT_TEAM_SAVE, 'quant.params_invalid'),
    );
    // The owner spent the teammate's save key on another write first: the save refuses, it does not overwrite.
    await t.owner.studio.organise({ id: strategyId, name: 'TEST renamed', idempotencyKey: `quant.team.save:${strategyId}:${MATE}:v1` });
    expect(await refusal(t.mate.team.save({ strategyId, baseVersion: 1, name: 'TEST' }))).toEqual(
      listed(QUANT_TEAM_SAVE, 'quant.idempotency_conflict'),
    );

    const noCap = wired({ releaseNoteMax: null });
    const noCapId = await shared(noCap, 'edit', false);
    expect(await refusal(noCap.mate.team.save({ strategyId: noCapId, baseVersion: 1, name: 'TEST', releaseNote: 'TEST' }))).toEqual(
      listed(QUANT_TEAM_SAVE, 'quant.release_note_limit_unset'),
    );
  });

  it('the paper run: no live control, no such run, no manual order, and the stopped run read', async () => {
    // The memory run store stamps start and stop with the clock, so the clock moves for the stopped run's read below.
    const at = Math.floor(Date.now() / HOUR) * HOUR + 60_000;
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    try {
      await paperRefusals(at);
    } finally {
      vi.useRealTimers();
    }
  });
  async function paperRefusals(at: number) {
    const view = wired();
    const viewId = await shared(view, 'view', false);
    const run = await startPaper(view, viewId);
    expect(await refusal(view.mate.team.order({ strategyId: viewId, runId: run.runId, side: 'buy', size: '1' }))).toEqual(
      listed(QUANT_TEAM_ORDER, 'quant.permission_denied'),
    );
    expect(await refusal(view.mate.team.stop({ strategyId: viewId, runId: run.runId }))).toEqual(
      listed(QUANT_TEAM_STOP, 'quant.permission_denied'),
    );

    const t = wired();
    const strategyId = await shared(t, 'edit', true);
    const live = await startPaper(t, strategyId);
    expect(await refusal(t.mate.team.order({ strategyId, runId: 'no-such-run', side: 'buy', size: '1' }))).toEqual(
      listed(QUANT_TEAM_ORDER, 'quant.run_not_found'),
    );
    expect(await refusal(t.mate.team.stop({ strategyId, runId: 'no-such-run' }))).toEqual(listed(QUANT_TEAM_STOP, 'quant.run_not_found'));
    expect(await refusal(t.mate.team.order({ strategyId, runId: live.runId, side: 'buy', size: '1' }))).toEqual(
      listed(QUANT_TEAM_ORDER, 'quant.paper_manual_order_unsupported'),
    );

    // Hours later the stopped run is read from closed candles, as the unwired ports refuse: the candles, then the fees.
    vi.setSystemTime(at + 3 * HOUR);
    ports.bars = async () => {
      throw new QuantError('quant.backtest_lake_missing', 'TEST the history read is not wired');
    };
    expect(await refusal(t.mate.team.stop({ strategyId, runId: live.runId }))).toEqual(
      listed(QUANT_TEAM_STOP, 'quant.backtest_lake_missing'),
    );
    const open = at - 60_000 + HOUR;
    const one = parseAmount('100');
    ports.bars = async () => [{ openTimeMs: open, open: one, high: one, low: one, close: one }];
    ports.fee = async () => {
      throw new QuantError('quant.cost_unset', 'TEST the published fee schedule read is not wired');
    };
    expect(await refusal(t.mate.team.stop({ strategyId, runId: live.runId }))).toEqual(listed(QUANT_TEAM_STOP, 'quant.cost_unset'));
  }
});

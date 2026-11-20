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
import { QUANT_APPROVAL_PROCEDURES } from '@intafaced/contracts/quant-approval-procedures';
import { QUANT_RESULT_SHARE_PROCEDURES } from '@intafaced/contracts/quant-result-share-procedures';
import { createQuantRouter } from '../router.js';
import { createMemoryApprovalRepository } from '../approval/repository.js';
import { tradeFeePort, tradeHistoryPort } from '../engine/ports.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryShareRepository } from '../share/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryTeamRepository } from '../team/memory-repository.js';

/**
 * The mounted side of the approval records (`approval.*`) and the report and share records (`backtest.report`,
 * `result.share.*`): sent through the production Fastify adapter, a refused sample is answered 400 (the input is
 * malformed) and an accepted one never is; it reaches the handler, which answers or refuses with a code its record lists.
 * Each refusal svc-quant sends leaves with the status its record lists, under the strict check that fails on one the
 * record does not list. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-quant-approval-share-samples-edge-secret-long-enough';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

function headers(userId = OWNER): Record<string, string> {
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
const signed = (userId = OWNER) => edgeContext({ headers: headers(userId), id: `req-${userId}` } as never);
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' } as never);

/** `index.ts`'s wiring from an empty environment: no database and no share settings, so every call refuses by name. */
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

const RECORDS = [...QUANT_APPROVAL_PROCEDURES, ...QUANT_RESULT_SHARE_PROCEDURES] as const;
type AreaRecord = (typeof RECORDS)[number];

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

const cases = RECORDS.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-quant's approval and report-share routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') {
      expect(res.statusCode, res.body).toBe(400);
      return;
    }
    expect(res.statusCode, res.body).not.toBe(400);
    expect(res.statusCode, res.body).not.toBe(500);
    if (res.statusCode !== 200) {
      // Reached the handler: the refusal is one its record lists, with the status it lists.
      const code = Object.keys(record.refusals).find((listed) => res.body.includes(listed));
      expect(code, res.body).toBeDefined();
    }
  });
});

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const NOW = T0 + 48 * HOUR;
const CLOSES = ['100', '100', '100', '110', '120', '130', '115', '100'];
const candles = () =>
  CLOSES.map((close, i) => {
    const open = i === 0 ? close : CLOSES[i - 1]!;
    const high = Number(open) > Number(close) ? open : close;
    const low = Number(open) < Number(close) ? open : close;
    return [T0 + i * HOUR, open, high, low, close, '1'];
  });
const FEES = { version: 'local-test:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } };
async function fakeFetch(url: string) {
  const path = url.replace('http://trade.test', '').split('?')[0]!;
  const body = path === '/api/v1/ohlcv/BTC%2FUSDT' ? candles() : path === '/api/v1/fees/published' ? FEES : null;
  if (body === null) throw new Error(`no route ${url}`);
  return { ok: true, status: 200, json: async () => body };
}

describe('each refusal leaves with the status its record lists', () => {
  function wired(share: { rate: number | null; windowSec: number | null } | null = { rate: 1, windowSec: 60 }) {
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(),
      runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES),
      team: createMemoryTeamRepository(),
      approvals: createMemoryApprovalRepository(),
      history: tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch: fakeFetch }),
      fees: tradeFeePort({ tradeUrl: 'http://trade.test', fetch: fakeFetch }),
      now: () => NOW,
      editLockSeconds: 30,
      releaseNoteMax: 500,
      ...(share ? { share: { repository: createMemoryShareRepository(), ...share, embedOrigins: null } } : {}),
    });
    return { owner: router.createCaller(signed(OWNER)), mate: router.createCaller(signed(MATE)), anon: router.createCaller(anonymous()) };
  }
  async function saved(caller: ReturnType<typeof wired>['owner'], qty = '0.001') {
    return caller.studio.save({
      name: 'TEST approval share',
      blocks: [{ side: 'buy' as const, symbol: 'BTC/USDT', qty }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-approval-share',
      idempotencyKey: 'save-approval-share',
    });
  }
  async function finishedRun(caller: ReturnType<typeof wired>['owner']) {
    const strategy = await caller.studio.save({
      name: 'TEST cross',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-rules',
      idempotencyKey: 'studio.save:client-rules',
    });
    const run = await caller.backtest.start({
      strategyId: strategy.id,
      strategyVersion: 1,
      cash: '1000',
      from: new Date(T0).toISOString(),
      to: new Date(T0 + CLOSES.length * HOUR).toISOString(),
      fillTiming: 'next_open',
      costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
    });
    return run.runId;
  }
  const refusal = async (call: Promise<unknown>) => {
    const err = (await call.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(err, 'the call was refused').not.toBeNull();
    return { status: err!.code, code: err!.cause?.code };
  };
  const listed = (record: AreaRecord, code: string) => ({ status: record.refusals[code], code });
  const [aGet, aPolicySet, aRequest, aDecide] = QUANT_APPROVAL_PROCEDURES;
  const [report, sGet, sCreate, sRevoke, sPublic] = QUANT_RESULT_SHARE_PROCEDURES;

  it('approval: a missing strategy, a blank policy, an unknown request, self-review, a decided and a stale request', async () => {
    const t = wired();
    const id = { strategyId: 's-missing' };
    expect(await refusal(t.owner.approval.get(id))).toEqual(listed(aGet, 'quant.studio_not_found'));
    expect(await refusal(t.owner.approval.request({ ...id, strategyVersion: 1 }))).toEqual(listed(aRequest, 'quant.studio_not_found'));
    expect(await refusal(t.owner.approval.decide({ ...id, approvalId: 'a-1', decision: 'approved', reason: '' }))).toEqual(
      listed(aDecide, 'quant.studio_not_found'),
    );

    const s = await saved(t.owner);
    expect(await refusal(t.owner.approval.request({ strategyId: s.id, strategyVersion: 1 }))).toEqual(
      listed(aRequest, 'quant.approval_policy_unset'),
    );
    // The policy write has no refusal of its own on a wired store; it answers.
    expect(await t.owner.approval.policy.set({ required: true, idempotencyKey: 'p1' })).toMatchObject({ required: true });
    // A version that does not exist reads as not found.
    expect(await refusal(t.owner.approval.request({ strategyId: s.id, strategyVersion: 9 }))).toEqual(
      listed(aRequest, 'quant.studio_not_found'),
    );
    const approvalId = (await t.owner.approval.request({ strategyId: s.id, strategyVersion: 1 })).approvals[0]!.approvalId;
    expect(await refusal(t.owner.approval.decide({ strategyId: s.id, approvalId: 'a-nope', decision: 'approved', reason: '' }))).toEqual(
      listed(aDecide, 'quant.approval_not_found'),
    );
    expect(await refusal(t.owner.approval.decide({ strategyId: s.id, approvalId, decision: 'approved', reason: '' }))).toEqual(
      listed(aDecide, 'quant.approval_self_review'),
    );
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'view', liveControl: false });
    await t.mate.approval.decide({ strategyId: s.id, approvalId, decision: 'approved', reason: 'TEST looks right' });
    expect(await refusal(t.mate.approval.decide({ strategyId: s.id, approvalId, decision: 'rejected', reason: '' }))).toEqual(
      listed(aDecide, 'quant.approval_decided'),
    );

    const fresh = wired();
    const f = await saved(fresh.owner);
    await fresh.owner.approval.policy.set({ required: true, idempotencyKey: 'p1' });
    await fresh.owner.team.set({ strategyId: f.id, memberId: MATE, role: 'view', liveControl: false });
    const pending = (await fresh.owner.approval.request({ strategyId: f.id, strategyVersion: 1 })).approvals[0]!.approvalId;
    await fresh.owner.risk.set({
      strategyId: f.id,
      caps: { depositPercent: '', maxPositionNotional: '500', maxDailyLoss: '', equityFloor: '900' },
      floorPolicy: 'reduce_only',
    });
    expect(await refusal(fresh.mate.approval.decide({ strategyId: f.id, approvalId: pending, decision: 'approved', reason: '' }))).toEqual(
      listed(aDecide, 'quant.approval_hash_stale'),
    );
  });

  it('report and share: a missing run, blank share settings, a blank or stale seq, a used-up rate and an unknown link', async () => {
    const t = wired();
    const missing = { runId: 'r-missing' };
    expect(await refusal(t.owner.backtest.report(missing))).toEqual(listed(report, 'quant.run_not_found'));
    expect(await refusal(t.owner.result.share.get(missing))).toEqual(listed(sGet, 'quant.run_not_found'));
    expect(await refusal(t.owner.result.share.create({ ...missing, seq: 0 }))).toEqual(listed(sCreate, 'quant.run_not_found'));
    expect(await refusal(t.owner.result.share.revoke(missing))).toEqual(listed(sRevoke, 'quant.run_not_found'));
    expect(await refusal(t.anon.result.share.public({ token: 'not-a-link' }))).toEqual(listed(sPublic, 'quant.share_not_found'));

    const runId = await finishedRun(t.owner);
    expect(await refusal(t.owner.result.share.create({ runId }))).toEqual(listed(sCreate, 'quant.share_seq_unset'));
    expect(await refusal(t.owner.result.share.create({ runId, seq: 'five' }))).toEqual(listed(sCreate, 'quant.share_seq_unset'));
    expect(await refusal(t.owner.result.share.create({ runId, seq: 2 }))).toEqual(listed(sCreate, 'quant.share_seq_stale'));
    const { token } = await t.owner.result.share.create({ runId, seq: 0 });
    await t.anon.result.share.public({ token: token! });
    expect(await refusal(t.anon.result.share.public({ token: token! }))).toEqual(listed(sPublic, 'quant.share_rate_limited'));

    for (const [blank, code] of [
      [{ rate: null, windowSec: 60 }, 'quant.share_rate_unset'],
      [{ rate: 1, windowSec: null }, 'quant.share_window_unset'],
    ] as const) {
      const b = wired(blank);
      expect(await refusal(b.owner.result.share.get(missing))).toEqual(listed(sGet, code));
      expect(await refusal(b.owner.result.share.create({ ...missing, seq: 0 }))).toEqual(listed(sCreate, code));
      expect(await refusal(b.owner.result.share.revoke(missing))).toEqual(listed(sRevoke, code));
      expect(await refusal(b.anon.result.share.public({ token: 'x' }))).toEqual(listed(sPublic, code));
    }
  });

  it('no database wired refuses by name with the status each record lists', async () => {
    // The empty-environment wiring: the strategy store and the run store refuse, and a share store set without a database.
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
    });
    const caller = router.createCaller(signed());
    expect(await refusal(caller.approval.get({ strategyId: 's-1' }))).toEqual(listed(aGet, 'quant.database_url_unset'));
    expect(await refusal(caller.approval.request({ strategyId: 's-1', strategyVersion: 1 }))).toEqual(
      listed(aRequest, 'quant.database_url_unset'),
    );
    expect(await refusal(caller.approval.decide({ strategyId: 's-1', approvalId: 'a', decision: 'approved', reason: '' }))).toEqual(
      listed(aDecide, 'quant.database_url_unset'),
    );
    const unsetShare = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      share: { repository: undefined as never, rate: 1, windowSec: 60, embedOrigins: null },
    }).createCaller(signed());
    expect(await refusal(unsetShare.result.share.get({ runId: 'r' }))).toEqual(listed(sGet, 'quant.database_url_unset'));
    expect(await refusal(unsetShare.result.share.create({ runId: 'r', seq: 0 }))).toEqual(listed(sCreate, 'quant.database_url_unset'));
    expect(await refusal(unsetShare.result.share.revoke({ runId: 'r' }))).toEqual(listed(sRevoke, 'quant.database_url_unset'));
    expect(await refusal(unsetShare.result.share.public({ token: 'x' }))).toEqual(listed(sPublic, 'quant.database_url_unset'));
  });
});

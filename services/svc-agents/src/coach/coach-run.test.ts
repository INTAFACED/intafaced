import { describe, expect, it } from 'vitest';
import { LedgerError } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { evaluateCompletion, type Refusal } from '../fleet/guardrails.js';
import type { AuditedAction } from '../fleet/audit.js';
import { MockModelProvider } from '../providers/mock.js';
import type { SettlementResult } from '../metering/meter.js';
import { RefusedError } from '../runtime.js';
import { looksLikeAdvice, type CoachCatalogItem, type CoachGrounding } from './grounded-session.js';
import {
  COACH_AGENT_ID,
  COACH_RUN_LEASE_MS,
  COACH_TASK,
  asksForAdvice,
  citeLessons,
  coachAgentGuardrail,
  coachRunKey,
  nextLessonOf,
  stemsOf,
  runCoachAnswer,
  type CoachRunDeps,
  type CoachRunRow,
  type CoachRunStore,
} from './coach-run.js';

/**
 * The Coach run (RC-agents-02), on a runtime double and a stored-run double. `coach-run.db.test.ts` runs the same run on
 * real Postgres and the real meter; this file pins the decisions: which asks refuse, by which code, before any session
 * opens; which lessons are cited; and what a retry returns.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_IDS = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];

/** The academy spine, as `/internal/curriculum` returns it (slug and title only), in its own order. */
const SPINE: CoachCatalogItem[] = [
  { slug: 'foundations-risk-first', title: 'Risk first' },
  { slug: 'foundations-order-types', title: 'Order types you will actually use' },
  { slug: 'foundations-position-sizing', title: 'Position sizing without inventing numbers' },
  { slug: 'foundations-journal-discipline', title: 'Trade journal discipline' },
  { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' },
  { slug: 'markets-spread-and-slippage', title: 'Spread and slippage honesty' },
];
const GROUNDING: CoachGrounding = { items: SPINE, licensedLibraryImported: false };
const SIZE_ASK = 'TEST: why does position size matter more than entry?';

class MemoryStore implements CoachRunStore {
  readonly rows = new Map<string, CoachRunRow>();
  failAnswer = false;
  /** What the session's sealed windows charged, as `agents.usage_windows` would sum it. */
  chargedAmount = 0n;
  now = () => Date.now();
  private key = (userId: string, requestId: string) => `${userId}:${requestId}`;
  async find(userId: string, requestId: string) {
    return this.rows.get(this.key(userId, requestId)) ?? null;
  }
  async claim(row: { userId: string; requestId: string; sessionId: string; runKey: string; questionDigest: string }) {
    if (this.rows.has(this.key(row.userId, row.requestId))) return false;
    this.rows.set(this.key(row.userId, row.requestId), {
      ...row,
      status: 'running',
      answer: null,
      citations: [],
      nextLesson: null,
      engine: null,
      billedAmount: null,
      createdAt: new Date(this.now()),
    });
    return true;
  }
  async answer(userId: string, requestId: string, answered: Parameters<CoachRunStore['answer']>[2]) {
    if (this.failAnswer) throw new Error('crash before the answer was stored');
    const row = this.rows.get(this.key(userId, requestId))!;
    if (row.status !== 'running') return false;
    this.rows.set(this.key(userId, requestId), { ...row, status: 'answered', ...answered });
    return true;
  }
  async charged() {
    return this.chargedAmount;
  }
  async settled(userId: string, requestId: string, billedAmount: string) {
    // An UPDATE: a dropped row stays dropped.
    const row = this.rows.get(this.key(userId, requestId));
    if (row) this.rows.set(this.key(userId, requestId), { ...row, billedAmount });
  }
  async lost(userId: string, requestId: string) {
    const row = this.rows.get(this.key(userId, requestId))!;
    if (row.status === 'running') this.rows.set(this.key(userId, requestId), { ...row, status: 'lost' });
  }
  async drop(userId: string, requestId: string) {
    if (this.rows.get(this.key(userId, requestId))?.status === 'running') this.rows.delete(this.key(userId, requestId));
  }
}

function action(): AuditedAction {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    sessionId: SESSION_IDS[0]!,
    userId: USER,
    agentId: COACH_AGENT_ID,
    sequence: 1,
    kind: 'completion',
    status: 'refused',
    tool: null,
    task: COACH_TASK,
    providerId: null,
    model: null,
    inputTokens: 0n,
    outputTokens: 0n,
    cost: 0n,
    refusalCode: null,
    userMessageKey: 'agents.action.refused',
    userMessageParams: {},
    inputDigest: null,
    outputDigest: null,
    prevHash: null,
    hash: 'h',
    occurredAt: new Date('2026-10-29T12:00:00.000Z'),
  };
}

/** A runtime double. Usage is metered per (session, request id) when `think` answers, and settles once per session. */
class FakeRuntime {
  opened: string[] = [];
  thinks: Array<{ sessionId: string; requestId: string; task: string; system?: string }> = [];
  settles: string[] = [];
  closes: string[] = [];
  metered = new Set<string>();
  charged = new Set<string>();
  thinkError: unknown = null;
  settleError: unknown = null;
  text = 'TEST answer. See /academy/invented-lesson for more.';

  async openSession(input: { userId: string; agentId: string }) {
    const id = SESSION_IDS[this.opened.length]!;
    this.opened.push(input.agentId);
    return {
      id,
      userId: input.userId,
      agentId: input.agentId,
      guardrail: coachAgentGuardrail(),
      guardrailVersion: 1,
      status: 'open' as const,
      metered: true,
      openedAt: new Date(),
      closedAt: null,
    };
  }
  async think(input: { sessionId: string; requestId: string; task: string; system?: string }) {
    this.thinks.push(input);
    if (this.thinkError) throw this.thinkError;
    this.metered.add(`${input.sessionId}:${input.requestId}`);
    return { text: this.text } as Awaited<ReturnType<CoachRunDeps['runtime']['think']>>;
  }
  async settleSession(sessionId: string): Promise<SettlementResult[]> {
    this.settles.push(sessionId);
    if (this.settleError) throw this.settleError;
    const hasUsage = [...this.metered].some((key) => key.startsWith(`${sessionId}:`));
    if (!hasUsage) return [];
    const chargeKey = `agents:usage:${sessionId}:w1`;
    const settled = !this.charged.has(chargeKey);
    this.charged.add(chargeKey);
    return [{ sessionId, windowId: 'w1', chargeKey, amount: 0n, chargeTxId: null, settled }];
  }
  async closeSession(sessionId: string) {
    this.closes.push(sessionId);
    return { status: 'closed' as const } as Awaited<ReturnType<CoachRunDeps['runtime']['closeSession']>>;
  }
}

function harness(options: { routed?: boolean; providerRegistered?: boolean; grounding?: CoachGrounding } = {}) {
  const runtime = new FakeRuntime();
  const store = new MemoryStore();
  const clock = { at: Date.parse('2026-10-29T12:00:00.000Z') };
  store.now = () => clock.at;
  const provider = new MockModelProvider({ id: 'primary' });
  const routes =
    options.routed === false ? [] : [{ task: COACH_TASK, providerId: 'primary', model: 'test-engine', maxOutputTokens: 1024, price: null }];
  const deps: CoachRunDeps = {
    runtime: runtime as unknown as CoachRunDeps['runtime'],
    gateway: {
      routingTable: { routes } as unknown as CoachRunDeps['gateway']['routingTable'],
      registeredProvider: (id: string) => (options.providerRegistered === false || id !== 'primary' ? undefined : provider),
    },
    store,
    feeAssetId: 'USDT',
    loadGrounding: async () => options.grounding ?? GROUNDING,
    metered: async (sessionId, requestId) => runtime.metered.has(`${sessionId}:${requestId}`),
    now: () => clock.at,
  };
  /** Moves the clock past the running-row lease, as a retry long after a crash would see it. */
  const pastLease = () => {
    clock.at += COACH_RUN_LEASE_MS + 1;
  };
  return { runtime, store, deps, pastLease };
}

const ask = (deps: CoachRunDeps, question: string, requestId = 'coach:req:0001', lessonSlug = 'foundations-risk-first') =>
  runCoachAnswer(deps, { userId: USER, requestId, question, lessonSlug });

describe('coach run — refusals before any session opens', () => {
  it('a return promise is refused as advice, by its code, and nothing runs', async () => {
    const { runtime, deps } = harness();
    const result = await ask(deps, 'TEST: promise me 20% a month if I follow this lesson');
    expect(result).toEqual({ status: 'refused', code: 'agents.advice_forbidden' });
    expect(runtime.opened).toEqual([]);
    expect(runtime.thinks).toEqual([]);
  });

  it.each(['Should I buy BTC now?', 'Guaranteed returns from this setup?', 'Can this make 5 % per week?', 'What should I sell today?'])(
    'advice ask %j is refused as advice',
    async (question) => {
      const { deps } = harness();
      expect(asksForAdvice(question)).toBe(true);
      expect(await ask(deps, question)).toEqual({ status: 'refused', code: 'agents.advice_forbidden' });
    },
  );

  it('a question about the person’s own positions is refused; a lesson about position size is not', async () => {
    const { deps } = harness();
    expect(await ask(deps, 'How are my positions doing?')).toEqual({ status: 'refused', code: 'agents.positions_not_decided' });
    expect((await ask(deps, SIZE_ASK)).status).toBe('answered');
  });

  it('an empty curriculum refuses agents.coach_curriculum_empty', async () => {
    const { runtime, deps } = harness({ grounding: { items: [], licensedLibraryImported: false } });
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.coach_curriculum_empty' });
    expect(runtime.opened).toEqual([]);
  });

  it('no Coach route refuses agents.coach_engine_unavailable, and so does a route whose provider is not registered', async () => {
    const unrouted = harness({ routed: false });
    expect(await ask(unrouted.deps, 'TEST: explain drawdown')).toEqual({
      status: 'refused',
      code: 'agents.coach_engine_unavailable',
    });
    expect(unrouted.runtime.opened).toEqual([]);
    const unregistered = harness({ providerRegistered: false });
    expect(await ask(unregistered.deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.coach_engine_unavailable' });
    expect(unregistered.runtime.opened).toEqual([]);
  });

  it('a topic the curriculum does not cover is "not covered", with no citation and no session', async () => {
    const { runtime, store, deps } = harness();
    const result = await ask(deps, 'TEST: what will the weather be on Mars next week?');
    expect(result).toEqual({ status: 'not_covered', citations: [] });
    expect(runtime.opened).toEqual([]);
    expect(store.rows.size).toBe(0);
  });
});

describe('coach run — citations', () => {
  it('cites only curriculum lessons sharing a word stem with the question, best match first', () => {
    expect(citeLessons(SIZE_ASK, SPINE)).toEqual([
      { slug: 'foundations-position-sizing', title: 'Position sizing without inventing numbers' },
      { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' },
    ]);
    expect(citeLessons('TEST: what will the weather be on Mars next week?', SPINE)).toEqual([]);
  });

  it('the next lesson follows the lesson being read, in curriculum order', () => {
    expect(nextLessonOf(SPINE, 'foundations-risk-first', [])).toEqual(SPINE[1]);
    expect(nextLessonOf(SPINE, undefined, [SPINE[2]!])).toEqual(SPINE[3]);
    expect(nextLessonOf(SPINE, 'markets-spread-and-slippage', [])).toBeNull();
  });
});

describe('coach run — a metered run', () => {
  it('answers on a coach session, cites only curriculum slugs whatever the engine wrote, and settles and closes', async () => {
    const { runtime, store, deps } = harness();
    const result = await ask(deps, SIZE_ASK);
    expect(result).toEqual({
      status: 'answered',
      answer: runtime.text,
      citations: [
        { slug: 'foundations-position-sizing', title: 'Position sizing without inventing numbers' },
        { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' },
      ],
      nextLesson: SPINE[1],
      engine: 'sandbox',
      sessionId: SESSION_IDS[0],
      runKey: coachRunKey(SESSION_IDS[0]!, 'coach:req:0001'),
      assetId: 'USDT',
      charge: { state: 'settled', billedAmount: '0' },
      replayed: false,
    });
    expect(result.status === 'answered' ? result.runKey : null).toBe(`agents:run:${SESSION_IDS[0]}:coach:req:0001`);
    expect(runtime.opened).toEqual([COACH_AGENT_ID]);
    expect(runtime.thinks).toHaveLength(1);
    expect(runtime.thinks[0]!.task).toBe(COACH_TASK);
    expect(runtime.thinks[0]!.system).toContain('Position sizing without inventing numbers (foundations-position-sizing)');
    expect(runtime.settles).toEqual([SESSION_IDS[0]]);
    expect(runtime.closes).toEqual([SESSION_IDS[0]]);
    const row = await store.find(USER, 'coach:req:0001');
    expect(row?.status).toBe('answered');
    expect(row?.billedAmount).toBe('0');
    expect(looksLikeAdvice(result as unknown as Record<string, unknown>)).toBe(false);
  });

  it('a retry with the same request id returns the stored answer and never calls the engine again', async () => {
    const { runtime, deps } = harness();
    const first = await ask(deps, SIZE_ASK);
    runtime.text = 'a different answer the engine would give now';
    const again = await ask(deps, SIZE_ASK);
    expect(again).toEqual({ ...first, replayed: true });
    expect(runtime.thinks).toHaveLength(1);
    expect(runtime.opened).toHaveLength(1);
  });

  it('the same request id with another question is a replay, never a second answer', async () => {
    const { runtime, deps } = harness();
    await ask(deps, SIZE_ASK);
    expect(await ask(deps, 'TEST: why journal every trade?')).toEqual({ status: 'refused', code: 'agents.request_id_replay' });
    expect(runtime.thinks).toHaveLength(1);
  });

  it('a guardrail refusal from the run is typed, settles and closes the session, and frees the id for a retry', async () => {
    const { runtime, store, deps } = harness();
    const decision = evaluateCompletion(
      coachAgentGuardrail(),
      { status: 'open', actionCount: 0, toolCalls: {}, spend: 0n, approvedTools: [] },
      { task: COACH_TASK, maxOutputTokens: 16, worstCaseCost: 1n },
      'USDT',
    );
    expect(decision.allowed).toBe(false);
    runtime.thinkError = new RefusedError(decision as Refusal, action());
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.spend_limit' });
    expect(runtime.settles).toEqual([SESSION_IDS[0]]);
    expect(runtime.closes).toEqual([SESSION_IDS[0]]);
    expect(await store.find(USER, 'coach:req:0001')).toBeNull();
  });

  it('an engine that cannot answer is agents.coach_engine_unavailable', async () => {
    const { runtime, deps } = harness();
    runtime.thinkError = new AgentError('down', 'agents.provider_unavailable', 'agents.error.engine_unavailable');
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.coach_engine_unavailable' });
  });

  it('an error that is not a refusal is thrown, after the session is settled and closed', async () => {
    const { runtime, deps } = harness();
    runtime.thinkError = new Error('boom');
    await expect(ask(deps, SIZE_ASK)).rejects.toThrow('boom');
    expect(runtime.settles).toEqual([SESSION_IDS[0]]);
    expect(runtime.closes).toEqual([SESSION_IDS[0]]);
  });
});

describe('coach run — crash and posting freeze', () => {
  it('a crash after the engine ran settles the metered usage once on its own charge key and never re-runs the engine', async () => {
    const { runtime, store, deps, pastLease } = harness();
    store.failAnswer = true;
    await expect(ask(deps, SIZE_ASK)).rejects.toThrow('crash before the answer was stored');
    store.failAnswer = false;

    // Inside the lease the row may still be a live run: the retry leaves its session alone.
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.run_in_progress' });
    expect(runtime.settles).toEqual([]);
    expect(runtime.closes).toEqual([]);
    expect((await store.find(USER, 'coach:req:0001'))?.status).toBe('running');

    pastLease();
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.request_id_replay' });
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.request_id_replay' });

    expect(runtime.thinks).toHaveLength(1);
    expect(runtime.opened).toHaveLength(1);
    // Every retry settles the one session; the window charges once.
    expect(runtime.settles.every((id) => id === SESSION_IDS[0])).toBe(true);
    expect([...runtime.charged]).toEqual([`agents:usage:${SESSION_IDS[0]}:w1`]);
    expect((await store.find(USER, 'coach:req:0001'))?.status).toBe('lost');
  });

  it('a crash before the engine ran leaves nothing metered, so the retry runs on a fresh session', async () => {
    const { runtime, store, deps, pastLease } = harness();
    await store.claim({
      userId: USER,
      requestId: 'coach:req:0001',
      sessionId: SESSION_IDS[1]!,
      runKey: coachRunKey(SESSION_IDS[1]!, 'coach:req:0001'),
      questionDigest: (await import('../gateway/gateway.js')).digestOfText(`foundations-risk-first\n${SIZE_ASK}`),
    });
    pastLease();
    const result = await ask(deps, SIZE_ASK);
    expect(result.status).toBe('answered');
    expect(runtime.settles[0]).toBe(SESSION_IDS[1]);
    expect(runtime.thinks).toHaveLength(1);
  });

  it('a ledger refusal at settlement keeps the stored answer unpaid with the ledger code, and the retry settles it once', async () => {
    const { runtime, store, deps } = harness();
    runtime.settleError = new LedgerError('postings are frozen', 'ledger.frozen');
    const first = await ask(deps, SIZE_ASK);
    expect(first.status === 'answered' ? first.charge : null).toEqual({ state: 'unpaid', code: 'ledger.frozen' });
    const row = await store.find(USER, 'coach:req:0001');
    expect(row?.status).toBe('answered');
    expect(row?.billedAmount).toBeNull();
    expect(runtime.closes).toEqual([]);

    runtime.settleError = null;
    const again = await ask(deps, SIZE_ASK);
    expect(again.status === 'answered' ? again.charge : null).toEqual({ state: 'settled', billedAmount: '0' });
    expect(again.status === 'answered' ? again.replayed : null).toBe(true);
    expect(runtime.thinks).toHaveLength(1);
    expect([...runtime.charged]).toEqual([`agents:usage:${SESSION_IDS[0]}:w1`]);
    expect((await store.find(USER, 'coach:req:0001'))?.billedAmount).toBe('0');
  });
});

describe('coach run — stored runs and their readback', () => {
  it('a stored answer is returned on a retry even after the Coach route is gone', async () => {
    const { runtime, deps } = harness();
    const first = await ask(deps, SIZE_ASK);
    const unrouted = {
      ...deps,
      gateway: { ...deps.gateway, routingTable: { routes: [] } as unknown as CoachRunDeps['gateway']['routingTable'] },
    };
    expect(await ask(unrouted, SIZE_ASK)).toEqual({ ...first, replayed: true });
    expect(await ask(unrouted, 'TEST: explain drawdown', 'coach:req:0002')).toEqual({
      status: 'refused',
      code: 'agents.coach_engine_unavailable',
    });
    expect(runtime.thinks).toHaveLength(1);
  });

  it('the billed amount is what the session’s sealed windows charged, read back on settle', async () => {
    const { store, deps } = harness();
    store.chargedAmount = 105_000_000_000_000_000n;
    const result = await ask(deps, SIZE_ASK);
    expect(result).toMatchObject({ status: 'answered', charge: { state: 'settled', billedAmount: '0.105' } });
    expect((await store.find(USER, 'coach:req:0001'))?.billedAmount).toBe('0.105');
  });

  it('a run whose row was taken over past the lease returns a replay, not a second answer', async () => {
    const { runtime, store, deps } = harness();
    const answer = store.answer.bind(store);
    store.answer = async (userId, requestId, answered) => {
      await store.lost(userId, requestId);
      return answer(userId, requestId, answered);
    };
    expect(await ask(deps, SIZE_ASK)).toEqual({ status: 'refused', code: 'agents.request_id_replay' });
    expect((await store.find(USER, 'coach:req:0001'))?.status).toBe('lost');
    expect(runtime.settles).toEqual([SESSION_IDS[0]]);
    expect(runtime.closes).toEqual([SESSION_IDS[0]]);
  });

  it('plural and singular share a stem', () => {
    expect([...stemsOf('entries')]).toEqual([...stemsOf('entry')]);
    expect(citeLessons('TEST: when do entries go wrong?', SPINE)).toEqual([
      { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' },
    ]);
  });
});

describe('coach guardrail', () => {
  it('holds no tools, only the Coach task, and a spend cap of 0', () => {
    const g = coachAgentGuardrail();
    expect(g.agentId).toBe(COACH_AGENT_ID);
    expect(g.tools).toEqual([]);
    expect(g.limits.allowedTasks).toEqual([COACH_TASK]);
    expect(g.limits.maxSpendPerSession).toBe(0n);
  });
});

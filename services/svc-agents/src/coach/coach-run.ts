/**
 * The Coach run (RC-agents-02): a person asks a question inside an Academy lesson and gets an answer that cites only
 * lessons the curriculum returned.
 *
 * The run is a metered session on the fleet runtime — `openSession → think → settle → closeSession` — like every other
 * agent run, so its engine call is guardrail-checked, audited (digests only) and billed through the one meter. The
 * citations are chosen here, from the curriculum read, before the engine is called; the engine's text never adds one,
 * so a citation can only be a slug the curriculum returned.
 *
 * Cheap refusals happen before a session opens and bill nothing: advice, a question about the person's own holdings, an
 * empty curriculum, no Coach model set, and a topic the curriculum does not cover.
 *
 * Retries: the person's request id is the business key. One row per (person, request id) holds the answer, so a retry
 * after a lost reply returns the stored answer rather than calling the engine again, and the run's charge settles under
 * its usage window's own charge key, so a retry after a crash settles what was metered once and never a second time.
 */

import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { AgentError } from '../errors.js';
import { parseGuardrail, serialiseGuardrail, type Guardrail } from '../fleet/guardrails.js';
import { digestOfText, type ModelGateway } from '../gateway/gateway.js';
import { engineOfAdapter, type RouteEngine } from '../gateway/routing.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import { runCoachSession, type CoachCatalogItem, type CoachGrounding } from './grounded-session.js';

/** The agent id the Coach guardrail is registered under. Not a fleet product agent: it holds no tools. */
export const COACH_AGENT_ID = 'coach';

/** The routing task the Coach calls. No default route names it, so a deployment with no Coach model refuses. */
export const COACH_TASK = 'coach.answer';

/** At most this many lessons are cited for one answer. */
export const COACH_MAX_CITATIONS = 3;

export type CoachRefusalCode =
  | 'agents.advice_forbidden'
  | 'agents.positions_not_decided'
  | 'agents.coach_curriculum_empty'
  | 'agents.coach_engine_unavailable'
  | 'agents.price_unset'
  | 'agents.spend_limit'
  | 'agents.funds_insufficient'
  | 'agents.request_id_replay'
  | 'agents.run_in_progress';

/**
 * A running row younger than this is another request's live run, never a crashed one: well past the upstream model
 * call's own timeout (providers/upstream.ts), so a run still inside it is left alone.
 */
export const COACH_RUN_LEASE_MS = 300_000;

export const COACH_REFUSAL_CODES: readonly CoachRefusalCode[] = [
  'agents.advice_forbidden',
  'agents.positions_not_decided',
  'agents.coach_curriculum_empty',
  'agents.coach_engine_unavailable',
  'agents.price_unset',
  'agents.spend_limit',
  'agents.funds_insufficient',
  'agents.request_id_replay',
  'agents.run_in_progress',
];

/** What the run billed, read back from its settlements. `unpaid` keeps the code the ledger refused with. */
export type CoachCharge =
  { readonly state: 'settled'; readonly billedAmount: string } | { readonly state: 'unpaid'; readonly code: string };

export type CoachAnswered = {
  readonly status: 'answered';
  readonly answer: string;
  readonly citations: CoachCatalogItem[];
  readonly nextLesson: CoachCatalogItem | null;
  readonly engine: RouteEngine;
  readonly sessionId: string;
  readonly runKey: string;
  readonly assetId: string;
  readonly charge: CoachCharge;
  /** True when this reply is the stored answer of an earlier request with the same id. */
  readonly replayed: boolean;
};

export type CoachNotCovered = { readonly status: 'not_covered'; readonly citations: never[] };

export type CoachRefused = { readonly status: 'refused'; readonly code: CoachRefusalCode };

export type CoachRunResult = CoachAnswered | CoachNotCovered | CoachRefused;

/**
 * The Coach guardrail: no tools, the one Coach task, and a spend cap of 0. No Coach rate or cap is published, so a
 * priced Coach route refuses `agents.spend_limit` rather than bill an amount nobody set; a free route runs.
 */
export function coachAgentGuardrail(overrides: { version?: number; maxSpendPerSession?: string | null } = {}): Guardrail {
  return parseGuardrail({
    agentId: COACH_AGENT_ID,
    version: overrides.version ?? 1,
    capacityMode: 'research_only',
    tools: [],
    limits: {
      maxActionsPerSession: 4,
      maxOutputTokensPerCall: 1024,
      maxSpendPerSession: overrides.maxSpendPerSession === undefined ? '0' : overrides.maxSpendPerSession,
      allowedModules: [],
      allowedTasks: [COACH_TASK],
    },
  });
}

/**
 * Registers the Coach at boot. It is not a fleet product agent (it holds no tools), but its runs open sessions the same
 * way, so its guardrail must be in `agent_definitions` before the listener opens.
 */
export async function registerCoachAgent(runtime: Pick<AgentRuntime, 'registerAgent'>): Promise<void> {
  await runtime.registerAgent(serialiseGuardrail(coachAgentGuardrail()), { enabled: true });
}

// ── Asks the Coach refuses ───────────────────────────────────────────────────

const ADVICE_ASK = [
  /\b(promise|promised|guarantee|guaranteed|guarantees)\b/i,
  /\d+(\.\d+)?\s*%\s*(a|an|per|each|every)\s*(day|week|month|year)\b/i,
  /\bshould\s+i\s+(buy|sell|short|long|hold)\b/i,
  /\bwhat\s+(should\s+i|to)\s+(buy|sell|trade)\b/i,
  /\b(buy|sell)\s+signals?\b/i,
];

/** The person's own book: owner-undecided, so the Coach never reads or reasons about it. */
const OWN_HOLDINGS_ASK = /\bmy\s+(positions?|holdings?|portfolio|pnl|balances?|account|trades?)\b/i;

export function asksForAdvice(question: string): boolean {
  return ADVICE_ASK.some((pattern) => pattern.test(question));
}

export function asksAboutOwnHoldings(question: string): boolean {
  return OWN_HOLDINGS_ASK.test(question);
}

// ── Retrieval over the curriculum spine ──────────────────────────────────────

const STOPWORDS = new Set(
  (
    'the and for are but not you your yours with what when where which who whom why how does did doing done will would ' +
    'could should can may might must this that these those there their them they then than from into onto over under ' +
    'about after before again more most less much many some any all each every very just also only own same such too ' +
    'its it is was were been being have has had having our ours out off down upon test me my mine myself explain tell ' +
    'next week matter matters lesson lessons'
  ).split(' '),
);

/** Lower-case word stems: plural, -ing, -ed and a trailing e removed, so "size" and "sizing" meet. */
export function stemsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    let stem = raw;
    for (const suffix of ['ing', 'ies', 'es', 'ed', 's']) {
      if (stem.endsWith(suffix) && stem.length - suffix.length >= 3) {
        stem = stem.slice(0, -suffix.length);
        break;
      }
    }
    // "entries" and "entry" meet at "entr".
    if ((stem.endsWith('e') || stem.endsWith('y')) && stem.length > 3) stem = stem.slice(0, -1);
    out.add(stem);
  }
  return out;
}

/**
 * The curriculum lessons a question is about: those sharing a word stem with the question in their title or slug, most
 * shared stems first, then curriculum order. Empty when nothing matches — the curriculum does not cover the question.
 */
export function citeLessons(question: string, items: readonly CoachCatalogItem[]): CoachCatalogItem[] {
  const asked = stemsOf(question);
  const scored = items
    .map((item, order) => {
      const stems = stemsOf(`${item.title} ${item.slug.replace(/-/g, ' ')}`);
      let score = 0;
      for (const stem of asked) if (stems.has(stem)) score += 1;
      return { item, order, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, COACH_MAX_CITATIONS).map((row) => ({ slug: row.item.slug, title: row.item.title }));
}

/** The lesson after `slug` in curriculum order, or after the first citation when the person is not in a lesson. */
export function nextLessonOf(
  items: readonly CoachCatalogItem[],
  lessonSlug: string | undefined,
  citations: readonly CoachCatalogItem[],
): CoachCatalogItem | null {
  const from = lessonSlug && items.some((item) => item.slug === lessonSlug) ? lessonSlug : citations[0]?.slug;
  if (!from) return null;
  const at = items.findIndex((item) => item.slug === from);
  const next = at >= 0 ? items[at + 1] : undefined;
  return next ? { slug: next.slug, title: next.title } : null;
}

export function coachSystemPrompt(citations: readonly CoachCatalogItem[]): string {
  return [
    'You are the Academy Coach. Explain using only these Academy lessons:',
    ...citations.map((c) => `- ${c.title} (${c.slug})`),
    'Do not recommend trades, promise returns or discuss the reader’s own positions.',
  ].join('\n');
}

// ── The stored run ───────────────────────────────────────────────────────────

export function coachRunKey(sessionId: string, requestId: string): string {
  return `agents:run:${sessionId}:${requestId}`;
}

export type CoachRunRow = {
  readonly userId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly runKey: string;
  readonly questionDigest: string;
  readonly status: 'running' | 'answered' | 'lost';
  readonly answer: string | null;
  readonly citations: readonly CoachCatalogItem[];
  readonly nextLesson: CoachCatalogItem | null;
  readonly engine: RouteEngine | null;
  readonly billedAmount: string | null;
  readonly createdAt: Date;
};

export interface CoachRunStore {
  find(userId: string, requestId: string): Promise<CoachRunRow | null>;
  /** Inserts a running row. False when the (person, request id) row already exists. */
  claim(row: { userId: string; requestId: string; sessionId: string; runKey: string; questionDigest: string }): Promise<boolean>;
  answer(
    userId: string,
    requestId: string,
    answered: { answer: string; citations: readonly CoachCatalogItem[]; nextLesson: CoachCatalogItem | null; engine: RouteEngine },
  ): Promise<boolean>;
  /** What the ledger accepted for the session's sealed windows: the sum of charges that carry a ledger answer. */
  charged(sessionId: string): Promise<Amount>;
  settled(userId: string, requestId: string, billedAmount: string): Promise<void>;
  lost(userId: string, requestId: string): Promise<void>;
  /** Removes a running row whose run refused before anything was metered, so the same id may run again. */
  drop(userId: string, requestId: string): Promise<void>;
}

type RowShape = {
  user_id: string;
  request_id: string;
  session_id: string;
  run_key: string;
  question_digest: string;
  status: 'running' | 'answered' | 'lost';
  answer: string | null;
  citations: CoachCatalogItem[];
  next_lesson: CoachCatalogItem | null;
  engine: RouteEngine | null;
  billed_amount: string | null;
  created_at: Date;
};

export function createCoachRunStore(sql: Sql): CoachRunStore {
  return {
    async find(userId, requestId) {
      const rows = await sql<RowShape[]>`
        SELECT user_id, request_id, session_id, run_key, question_digest, status, answer, citations, next_lesson, engine,
               billed_amount::text AS billed_amount, created_at
          FROM agents.coach_runs
         WHERE user_id = ${userId} AND request_id = ${requestId}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        requestId: row.request_id,
        sessionId: row.session_id,
        runKey: row.run_key,
        questionDigest: row.question_digest,
        status: row.status,
        answer: row.answer,
        citations: row.citations,
        nextLesson: row.next_lesson,
        engine: row.engine,
        // numeric(38,18) reads back padded; the stored amount is the same decimal string the fresh answer returned.
        billedAmount: row.billed_amount === null ? null : formatAmount(parseAmount(row.billed_amount)),
        createdAt: row.created_at,
      };
    },
    async claim(row) {
      const inserted = await sql<Array<{ request_id: string }>>`
        INSERT INTO agents.coach_runs (user_id, request_id, session_id, run_key, question_digest, status)
        VALUES (${row.userId}, ${row.requestId}, ${row.sessionId}, ${row.runKey}, ${row.questionDigest}, 'running')
        ON CONFLICT (user_id, request_id) DO NOTHING
        RETURNING request_id
      `;
      return inserted.length === 1;
    },
    async answer(userId, requestId, answered) {
      const updated = await sql`
        UPDATE agents.coach_runs
           SET status = 'answered', answer = ${answered.answer},
               citations = ${sql.json(answered.citations as never)},
               next_lesson = ${answered.nextLesson ? sql.json(answered.nextLesson as never) : null},
               engine = ${answered.engine}, answered_at = now()
         WHERE user_id = ${userId} AND request_id = ${requestId} AND status = 'running'
      `;
      return updated.count === 1;
    },
    async charged(sessionId) {
      const rows = await sql<Array<{ total: string }>>`
        SELECT coalesce(sum(charged_amount), 0)::text AS total
          FROM agents.usage_windows
         WHERE session_id = ${sessionId} AND charge_tx_id IS NOT NULL
      `;
      return parseAmount(rows[0]!.total);
    },
    async settled(userId, requestId, billedAmount) {
      await sql`
        UPDATE agents.coach_runs SET billed_amount = ${billedAmount}
         WHERE user_id = ${userId} AND request_id = ${requestId}
      `;
    },
    async lost(userId, requestId) {
      await sql`
        UPDATE agents.coach_runs SET status = 'lost'
         WHERE user_id = ${userId} AND request_id = ${requestId} AND status = 'running'
      `;
    },
    async drop(userId, requestId) {
      await sql`
        DELETE FROM agents.coach_runs WHERE user_id = ${userId} AND request_id = ${requestId} AND status = 'running'
      `;
    },
  };
}

// ── The run ──────────────────────────────────────────────────────────────────

export type CoachRunRuntime = Pick<AgentRuntime, 'openSession' | 'think' | 'settleSession' | 'closeSession'>;

export type CoachRunDeps = {
  readonly runtime: CoachRunRuntime;
  readonly gateway: Pick<ModelGateway, 'routingTable' | 'registeredProvider'>;
  readonly store: CoachRunStore;
  readonly feeAssetId: string;
  readonly loadGrounding: () => Promise<CoachGrounding>;
  /** True when the engine call under (session, request id) was metered — the meter's own record. */
  readonly metered: (sessionId: string, requestId: string) => Promise<boolean>;
  /** The clock for the running-row lease. Defaults to `Date.now`. */
  readonly now?: () => number;
};

export type CoachRunInput = {
  /** The signed principal's user id. Never read from the request body. */
  readonly userId: string;
  readonly requestId: string;
  readonly question: string;
  readonly lessonSlug?: string;
};

const ENGINE_DOWN = new Set(['agents.route_not_found', 'agents.provider_unavailable', 'agents.capability_unavailable']);

/** The run's refusal code for an error thrown by `think`, or null when the error is not a refusal. */
function refusalOf(err: unknown): CoachRefusalCode | null {
  if (err instanceof RefusedError) {
    const code = err.refusal.code;
    if (code === 'agents.price_unset' || code === 'agents.spend_limit' || code === 'agents.funds_insufficient') return code;
    return null;
  }
  if (err instanceof AgentError) {
    if (ENGINE_DOWN.has(err.code)) return 'agents.coach_engine_unavailable';
    if (err.code === 'agents.request_id_replay') return 'agents.request_id_replay';
  }
  return null;
}

function engineFor(deps: CoachRunDeps): RouteEngine | null {
  const route = deps.gateway.routingTable.routes.find((row) => row.task === COACH_TASK);
  if (!route) return null;
  const provider = deps.gateway.registeredProvider(route.providerId);
  return provider ? engineOfAdapter(provider) : null;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return 'agents.settlement_failed';
}

/**
 * Settles the run's session and closes it. A ledger refusal leaves the window unpaid on its charge key and the session
 * open, so the next ask with the same request id settles it. The billed amount is read back from the session's sealed
 * windows, not from this call's settlements: a retry after a crash past the post still shows what was charged.
 */
async function settleRun(deps: CoachRunDeps, userId: string, requestId: string, sessionId: string): Promise<CoachCharge> {
  try {
    await deps.runtime.settleSession(sessionId);
  } catch (err) {
    return { state: 'unpaid', code: errorCode(err) };
  }
  const billedAmount = formatAmount(await deps.store.charged(sessionId));
  await deps.runtime.closeSession(sessionId);
  await deps.store.settled(userId, requestId, billedAmount);
  return { state: 'settled', billedAmount };
}

function answeredFrom(row: CoachRunRow, assetId: string, charge: CoachCharge, replayed: boolean): CoachAnswered {
  return {
    status: 'answered',
    answer: row.answer ?? '',
    citations: [...row.citations],
    nextLesson: row.nextLesson,
    engine: row.engine ?? 'unknown',
    sessionId: row.sessionId,
    runKey: row.runKey,
    assetId,
    charge,
    replayed,
  };
}

/**
 * Answer one question, or refuse it with a typed code.
 *
 * Order: advice and own-holdings asks and an empty curriculum; then the stored run for this request id; then no Coach
 * model and a topic the curriculum does not cover. All of these come before any session opens, so they bill nothing.
 * Then a new metered run.
 */
export async function runCoachAnswer(deps: CoachRunDeps, input: CoachRunInput): Promise<CoachRunResult> {
  const question = input.question.trim();
  const grounding = await deps.loadGrounding();

  const ruling = runCoachSession({
    grounding,
    asAdvice: asksForAdvice(question),
    includePositions: asksAboutOwnHoldings(question),
  });
  if (ruling.status === 'refuse') {
    if (ruling.reason === 'advice_forbidden') return { status: 'refused', code: 'agents.advice_forbidden' };
    if (ruling.reason === 'positions_not_decided') return { status: 'refused', code: 'agents.positions_not_decided' };
    if (ruling.reason === 'curriculum_empty') return { status: 'refused', code: 'agents.coach_curriculum_empty' };
    // library_import_pending is the licensed library, which this run does not cite: it grounds on the spine alone.
  }

  const questionDigest = digestOfText(`${input.lessonSlug ?? ''}\n${question}`);

  // The stored run comes before the engine and curriculum checks: an answer already given (and billed) is returned
  // even when the route or the lessons changed since.
  const stored = await deps.store.find(input.userId, input.requestId);
  if (stored) {
    // One request id is one question. The same id with another question is a replay, never a second answer.
    if (stored.questionDigest !== questionDigest) return { status: 'refused', code: 'agents.request_id_replay' };
    if (stored.status === 'answered') {
      const charge =
        stored.billedAmount === null
          ? await settleRun(deps, input.userId, input.requestId, stored.sessionId)
          : ({ state: 'settled', billedAmount: stored.billedAmount } as const);
      return answeredFrom(stored, deps.feeAssetId, charge, true);
    }
    // Another request with this id is still inside its run: leave its session and row alone.
    if (stored.status === 'running' && (deps.now?.() ?? Date.now()) - stored.createdAt.getTime() < COACH_RUN_LEASE_MS) {
      return { status: 'refused', code: 'agents.run_in_progress' };
    }
    // A run that stopped before its answer was stored. Whatever it metered settles once, on its own charge key.
    await settleRun(deps, input.userId, input.requestId, stored.sessionId);
    if (stored.status === 'lost' || (await deps.metered(stored.sessionId, input.requestId))) {
      // The engine ran and its text is gone. Running it again would bill the same request twice.
      await deps.store.lost(input.userId, input.requestId);
      return { status: 'refused', code: 'agents.request_id_replay' };
    }
    await deps.store.drop(input.userId, input.requestId);
  }

  const engine = engineFor(deps);
  if (engine === null) return { status: 'refused', code: 'agents.coach_engine_unavailable' };

  const citations = citeLessons(question, grounding.items);
  if (citations.length === 0) return { status: 'not_covered', citations: [] };

  const session = await deps.runtime.openSession({ userId: input.userId, agentId: COACH_AGENT_ID });
  const runKey = coachRunKey(session.id, input.requestId);
  const claimed = await deps.store.claim({
    userId: input.userId,
    requestId: input.requestId,
    sessionId: session.id,
    runKey,
    questionDigest,
  });
  if (!claimed) {
    // Another request with this id got there first. Its run answers it; this session ran nothing.
    await deps.runtime.closeSession(session.id);
    return { status: 'refused', code: 'agents.request_id_replay' };
  }

  let text: string;
  try {
    const result = await deps.runtime.think({
      sessionId: session.id,
      requestId: input.requestId,
      task: COACH_TASK,
      system: coachSystemPrompt(citations),
      messages: [{ role: 'user', content: question }],
    });
    text = result.text;
  } catch (err) {
    const code = refusalOf(err);
    const metered = await deps.metered(session.id, input.requestId).catch(() => true);
    if (metered) await deps.store.lost(input.userId, input.requestId);
    else await deps.store.drop(input.userId, input.requestId);
    // Settling is bookkeeping here: its own failure leaves the window for the next settle and never hides the refusal.
    await settleRun(deps, input.userId, input.requestId, session.id).catch(() => undefined);
    if (code) return { status: 'refused', code };
    throw err;
  }

  const nextLesson = nextLessonOf(grounding.items, input.lessonSlug, citations);
  const kept = await deps.store.answer(input.userId, input.requestId, { answer: text, citations, nextLesson, engine });
  const charge = await settleRun(deps, input.userId, input.requestId, session.id);
  // The row left `running` under this run (a recovery past the lease took it): the stored state is the answer.
  if (!kept) return { status: 'refused', code: 'agents.request_id_replay' };
  return {
    status: 'answered',
    answer: text,
    citations,
    nextLesson,
    engine,
    sessionId: session.id,
    runKey,
    assetId: deps.feeAssetId,
    charge,
    replayed: false,
  };
}

/**
 * Support agent Stage-2 — the metered `support.reply` RUN.
 *
 * Spec: docs/ops/trk/agents.support.md Stage 2 ("KB tool after ops.support
 * Stage 1+ / read-only account projection tool / typed I-don't-know + escalate
 * path"), §1.5 "Escalation to a human ticket is first-class".
 *
 * Everything the support agent needed to *decide* already existed and was pure:
 * `guardrail.ts` declares the toolset and keeps every money tool off it,
 * `tier-gate.ts` refuses closed until product law is published, `data-tools.ts`
 * refuses a dark desk / a missing row / somebody else's ticket, and
 * `supportAnswerOrEscalate` is the typed "I don't know". None of it ever ran on
 * the fleet runtime, so a support answer was a guardrail nobody enforced at call
 * time and a usage nobody metered. This module is the missing verb: it drives
 * those same pure functions through `openSession → act → settle → closeSession`,
 * the identical path `scanner/session-run.ts` (#1114) and
 * `navigator/session-run.ts` (#1150) take — not a parallel one.
 *
 * ── Why every ask goes to `runtime.act`, including the ones we expect to fail ──
 *
 * It would be cheaper to filter an undeclared tool out here and never bother the
 * runtime with it. That is exactly the shape of bug #1114 was written to stop: a
 * guardrail that only ever sees calls a caller already decided were fine is not
 * enforcing anything, and the refusal never reaches `agent_actions`, so the audit
 * trail shows a session in which nothing was ever attempted.
 *
 * So the run asks for what it was asked for. The runtime decides. That matters
 * most for the one case that is not hypothetical: the tier matrix is
 * **caller-supplied product law**, and a matrix that granted `pay.refund` would
 * sail through the tier gate. It does not sail through the session guardrail —
 * no money tool is declared on `supportAgentGuardrail()`, so `act` refuses it and
 * `execute` is never reached. The refund is not attempted because the guardrail
 * said no, not because this file remembered to check.
 *
 * ── Why a support agent may not answer around a gap ──────────────────────────
 *
 * This is the agent whose wrong answer a user acts on. "Your account is fine",
 * "that refund is on its way", "your limit is X" — each is a sentence about
 * somebody's money, and a confident wrong one is worse than no sentence at all.
 * So there is no branch in this file that composes a reply from nothing:
 *
 * - a reply is grounded in the article keys `support.kb.search` actually
 *   returned, and in nothing else;
 * - a KB that refused, came back empty, or was never consulted **escalates to a
 *   person** — the typed `agents.support.escalated`, not a hedge sentence;
 * - a run where no read at all was reachable **refuses** — an `ok` carrying an
 *   empty finding list would read like an answer;
 * - a request to move money escalates before a session opens. Refunds and
 *   credits are `ops.support` + `packages/ledger-client` recipes. The support
 *   agent never posts (§0.6), and reading the KB to discover that would bill a
 *   user for a lookup that cannot change the outcome.
 *
 * Findings are echoes of what a tool returned. No field is defaulted, rounded,
 * or reconstructed on the way out.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 *
 * It does not price, post, hold or total anything. The only money verb here is
 * `runtime.settleSession`, which is `UsageMeter` → `packages/ledger-client`. The
 * support agent never calls `ledger.post` (§0.6). Amounts are scaled bigint from
 * the meter and leave as decimal strings.
 *
 * It also does not register the guardrail. Registration is a deployment act (see
 * `registerScannerAgent`), and a run that registered its own guardrail on the way
 * in could widen its own powers. There is no support twin of that function here
 * on purpose: the scanner one is called from nowhere today, and adding a second
 * dead registrar would make boot registration *look* wired while nothing writes
 * to `agent_definitions`.
 *
 * ── Why a run that reads fixtures bills zero, honestly ───────────────────────
 *
 * The metered thing in this service is the ENGINE (`runtime.think`), and this
 * run does not call it: a reply grounded in cited article keys is data movement,
 * not a completion. So the run opens no usage window and settles to `0`. That
 * zero is reported as what it is. A synthetic charge so the run "looks metered"
 * would be a fabricated cost, and a fabricated cost is the same class of lie as
 * a fabricated answer.
 */

import type { SupportAccountGrounding, SupportKbArticle } from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { CopyKey } from '../copy.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import {
  invokeSupportDataTool,
  supportAnswerOrEscalate,
  type AccountProjectionFixture,
  type KbArticleFixture,
  type SupportDataToolOk,
  type SupportDataToolRefuse,
  type SupportDataToolResult,
  type TicketFixture,
} from './data-tools.js';
import type { SupportDeskPort } from './desk-port.js';
import { supportGrounded, type SupportDeskPlane } from './grounded.js';
import { resolveSupportAskFixtures } from './grounding-resolve.js';
import { supportTierGate, type SupportTierLaw } from './tier-gate.js';

/** The agent id the support guardrail is registered under. */
export const SUPPORT_AGENT_ID = 'support';

/** The one tool a grounded reply can cite. Without it there is no reply to give. */
export const SUPPORT_KB_TOOL = 'support.kb.search';

/**
 * One desk read the caller wants performed, and the fixture rows for it.
 *
 * The tool name is whatever the surface asked for — deliberately a plain
 * `string` and not a union of the declared tools, because narrowing it here
 * would move the allowlist decision out of the guardrail and into the type
 * system of the caller.
 */
export type SupportAsk = {
  readonly tool: string;
  readonly articles?: readonly KbArticleFixture[] | null;
  /** When set with run `kbCatalog`, resolve articles from the published catalog. */
  readonly kbQuery?: string | null;
  /** Owner-published KB search page size. Omit → named refuse, never invent 100. */
  readonly limit?: number;
  readonly ticket?: TicketFixture | null;
  readonly account?: AccountProjectionFixture | null;
  /** Contract grounding from ops.support — unread/plane-dark refuses invent. */
  readonly accountGrounding?: SupportAccountGrounding | null;
};

/** Who said no. `guardrail` is the runtime; `tool` is the data tool itself. */
export type SupportUnansweredBy = 'guardrail' | 'tool';

/** A read that produced no fact, and the reason it produced none. */
export type SupportUnanswered = {
  readonly tool: string;
  readonly refusedBy: SupportUnansweredBy;
  /** Guardrail refusal code, or the data tool's typed refuse reason. */
  readonly reason: string;
  readonly userMessageKey: CopyKey;
};

/** One settled usage window, as it leaves the service. */
export type SupportRunSettlement = {
  readonly windowId: string;
  /** Decimal string. Money never crosses the wire as a `number` (§0.5). */
  readonly amount: string;
  readonly chargeKey: string;
  /** False when the window was already settled — the idempotent retry path. */
  readonly settled: boolean;
};

/**
 * What the run cost and whether it was cleaned up.
 *
 * Present on every outcome, including refusals and escalations: "we escalated
 * and billed you nothing" is a claim the caller should be able to read, not
 * infer.
 */
export type SupportRunMetering = {
  /** Null when the run refused before opening a session — nothing was metered. */
  readonly sessionId: string | null;
  /** Total settled by this run, decimal string. */
  readonly billedAmount: string;
  readonly assetId: string;
  readonly sessionClosed: boolean;
  readonly settlements: readonly SupportRunSettlement[];
};

export type SupportRunRefuseReason =
  | 'desk_plane_dark'
  | 'tier_law_blank'
  | 'tier_not_granted'
  | 'no_grounded_read'
  /** Account read was asked and missing/incomplete/invent — do not answer as if it existed. */
  | 'account_state_missing'
  /** Live plane claimed, but no published KB catalog — do not invent ops.support answers. */
  | 'kb_plane_ungrounded'
  /** Live plane claimed, but no SUPPORT_URL / desk port — do not invent KB hits. */
  | 'no_live_kb';

export type SupportRunEscalateReason = 'kb_no_hit' | 'money_request' | 'desk_refused';

/** Reasons an account-state ask counts as "missing" for grounding honesty. */
const ACCOUNT_STATE_MISSING_REASONS = new Set([
  'missing_fixture',
  'incomplete_account',
  'balance_field_forbidden',
  'account_owner_mismatch',
  'account_plane_dark',
  'account_not_attempted',
  'no_live_kb',
]);

export type SupportRunOk = {
  readonly status: 'ok';
  readonly userTier: string;
  /** Only what a tool actually returned. Never a reconstruction. */
  readonly findings: readonly SupportDataToolOk[];
  readonly unanswered: readonly SupportUnanswered[];
  /** The article keys the reply is grounded in. Never empty on this branch. */
  readonly citedArticleKeys: readonly string[];
  readonly asked: number;
  readonly answered: number;
  /** False when at least one read went unanswered — the surface must say so. */
  readonly complete: boolean;
  readonly metering: SupportRunMetering;
};

/**
 * Case file for a human desk handoff (doctrine §8.2: "escalation w/ case file").
 *
 * Pure projection of what the agent already read — never invents balances,
 * refund amounts, or policy. Account rows carry status + KYC only (§0.6).
 * `ops.support` owns durable ticket write; this is the agent-side package a
 * person (or Denon's desk once #1626 lands) can attach without dual-editing
 * the support service.
 */
export type SupportCaseFile = {
  readonly reason: SupportRunEscalateReason;
  /** True when the user asked money to move — person uses ops/ledger recipes. */
  readonly moneyRequest: boolean;
  readonly findings: readonly SupportDataToolOk[];
  readonly unanswered: readonly SupportUnanswered[];
  readonly ticketIds: readonly string[];
  readonly citedArticleKeys: readonly string[];
  /** Status + KYC only — no balance field exists on this shape. */
  readonly accounts: readonly {
    readonly userId: string;
    readonly status: 'active' | 'frozen' | 'closed';
    readonly kycTier: string;
  }[];
};

/** Build the escalate case file from findings already in hand. */
export function buildSupportCaseFile(input: {
  reason: SupportRunEscalateReason;
  findings?: readonly SupportDataToolOk[];
  unanswered?: readonly SupportUnanswered[];
  moneyRequest?: boolean;
}): SupportCaseFile {
  const findings = input.findings ?? [];
  const ticketIds: string[] = [];
  const citedArticleKeys: string[] = [];
  const accounts: SupportCaseFile['accounts'][number][] = [];
  for (const f of findings) {
    if (f.tool === 'support.ticket.read') {
      ticketIds.push(f.ticket.ticketId);
    } else if (f.tool === 'support.kb.search') {
      for (const a of f.articles) citedArticleKeys.push(a.articleKey);
    } else if (f.tool === 'identity.account.read') {
      accounts.push({
        userId: f.account.userId,
        status: f.account.status,
        kycTier: f.account.kycTier,
      });
    }
  }
  return {
    reason: input.reason,
    moneyRequest: input.moneyRequest === true || input.reason === 'money_request',
    findings,
    unanswered: input.unanswered ?? [],
    ticketIds,
    citedArticleKeys,
    accounts,
  };
}

/**
 * The typed "this goes to a person".
 *
 * A first-class product outcome, not an error: the desk reached far enough to
 * know it cannot ground an answer, so it hands over rather than improvising.
 * `caseFile` packages what the agent could read so a human does not start from
 * a blank ticket.
 */
export type SupportRunEscalate = {
  readonly status: 'escalate';
  readonly reason: SupportRunEscalateReason;
  readonly userMessageKey: 'agents.support.escalated';
  readonly findings: readonly SupportDataToolOk[];
  readonly unanswered: readonly SupportUnanswered[];
  readonly caseFile: SupportCaseFile;
  readonly metering: SupportRunMetering;
};

export type SupportRunRefuse = {
  readonly status: 'refuse';
  readonly reason: SupportRunRefuseReason;
  readonly userMessageKey: 'agents.support.unavailable' | 'agents.support.tier_closed';
  readonly unanswered: readonly SupportUnanswered[];
  readonly metering: SupportRunMetering;
};

export type SupportRunEmpty = {
  readonly status: 'empty';
  readonly userMessageKey: 'agents.support.empty';
  readonly metering: SupportRunMetering;
};

/**
 * Caller aborted mid-run. Remaining tools did not execute; session still
 * settles/closes so there is no silent leftover feeCharge.
 */
export type SupportRunStopped = {
  readonly status: 'stopped';
  readonly reason: 'aborted';
  /**
   * Reuses `unavailable` so this ship stays off `packages/i18n` (FE fence).
   * Distinguisher is `status: 'stopped'` + `reason: 'aborted'`, not a new key.
   */
  readonly userMessageKey: 'agents.support.unavailable';
  readonly findings: readonly SupportDataToolOk[];
  readonly unanswered: readonly SupportUnanswered[];
  readonly metering: SupportRunMetering;
};

export type SupportRunResult = SupportRunOk | SupportRunEscalate | SupportRunRefuse | SupportRunEmpty | SupportRunStopped;

function unmetered(assetId: string): SupportRunMetering {
  return { sessionId: null, billedAmount: '0', assetId, sessionClosed: false, settlements: [] };
}

/**
 * Settle every open window, then close the session.
 *
 * Runs on every exit path including the thrown one. A session left open holds
 * usage that only a sweep job would ever find, and the sweep is not a plan.
 * Settlement failure is not swallowed into a fake zero — the caller is told the
 * run could not be accounted for.
 */
async function settleAndClose(runtime: AgentRuntime, sessionId: string, assetId: string): Promise<SupportRunMetering> {
  const results = await runtime.settleSession(sessionId);
  const closed = await runtime.closeSession(sessionId);

  let total: Amount = 0n;
  for (const r of results) total += r.amount;

  return {
    sessionId,
    billedAmount: formatAmount(total),
    assetId,
    sessionClosed: closed.status === 'closed',
    settlements: results.map((r) => ({
      windowId: r.windowId,
      amount: formatAmount(r.amount),
      chargeKey: r.chargeKey,
      settled: r.settled,
    })),
  };
}

export type SupportRunInput = {
  readonly runtime: AgentRuntime;
  /** The asking user. Row-scoped reads refuse when the row is somebody else's. */
  readonly userId: string;
  /** Asset the fleet meters in. Supplied by the caller; this module holds no rate. */
  readonly feeAssetId: string;
  readonly plane: SupportDeskPlane;
  /** Product-law tier matrix. Blank → refuse-closed, before any session opens. */
  readonly tierLaw?: SupportTierLaw | null;
  readonly userTier: string;
  readonly asks: readonly SupportAsk[];
  /**
   * The user is asking for money to move — a refund, a credit, a reversal.
   * Escalates to a person, free, before a session exists. The support agent has
   * no money tool and cannot acquire one by being asked nicely.
   */
  readonly moneyRequest?: boolean;
  /**
   * Optional abort — tool calls are stoppable. When aborted, the run settles
   * and closes what it opened; it does not invent a feeCharge and does not
   * continue unread asks.
   */
  readonly signal?: AbortSignal;
  /**
   * Published ops.support KB catalog. Used when an ask carries `kbQuery`.
   * Absent/empty catalog + kbQuery → refuse (`kb_plane_ungrounded`), never invented articles.
   */
  readonly kbCatalog?: readonly SupportKbArticle[] | null;
  /** Live ops.support desk. Absent on live → `no_live_kb` (billedAmount 0). */
  readonly desk?: SupportDeskPort | null;
  readonly deskHeaders?: Readonly<Record<string, string>>;
};

/**
 * Run `support.reply` as a metered, guardrailed session over the pure desk tools.
 *
 * Each ask is dispatched through `runtime.act`, so the runtime — not this module
 * — decides whether the tool is allowed, counts it against the session's action
 * budget, and writes the audit row. A guardrail refusal is caught and recorded as
 * an unanswered read rather than thrown, because one refused tool is not a failed
 * question: it is a named gap, and the run then decides between a grounded answer,
 * an escalation and a refusal — never a sentence that papers over the gap.
 */
export async function runSupportReplySession(input: SupportRunInput): Promise<SupportRunResult> {
  // ── Free outcomes, before a session exists ────────────────────────────────
  //
  // A dark desk, an unpublished tier matrix and a money request are all known
  // before any tool is touched. Opening a metered session to discover them would
  // bill a user for the platform's own unreadiness, and would leave an audit
  // trail implying the desk tried. It did not try — it stopped, for free.
  if (input.signal?.aborted) {
    return {
      status: 'stopped',
      reason: 'aborted',
      userMessageKey: 'agents.support.unavailable',
      findings: [],
      unanswered: [],
      metering: unmetered(input.feeAssetId),
    };
  }

  if (input.plane === 'dark') {
    return {
      status: 'refuse',
      reason: 'desk_plane_dark',
      userMessageKey: 'agents.support.unavailable',
      unanswered: [],
      metering: unmetered(input.feeAssetId),
    };
  }

  // Checked before the KB-plane gate, because a money request needs no lookup
  // to be answered: the answer is "a person handles this", even when the KB is dark.
  if (input.moneyRequest === true) {
    return {
      status: 'escalate',
      reason: 'money_request',
      userMessageKey: 'agents.support.escalated',
      findings: [],
      unanswered: [],
      caseFile: buildSupportCaseFile({ reason: 'money_request', moneyRequest: true }),
      metering: unmetered(input.feeAssetId),
    };
  }

  const catalogCount = input.kbCatalog?.length ?? 0;

  const tier = supportTierGate({ law: input.tierLaw ?? null, userTier: input.userTier });
  if (tier.status === 'refuse') {
    return {
      status: 'refuse',
      reason: tier.reason,
      userMessageKey: tier.userMessageKey,
      unanswered: [],
      metering: unmetered(input.feeAssetId),
    };
  }

  // Any KB search — kbQuery *or* smuggled article fixtures — needs a published
  // catalog. Fixture articles are not a live ops.support KB plane.
  const kbAsked = input.asks.some((ask) => ask.tool.trim() === SUPPORT_KB_TOOL);
  if (kbAsked) {
    const grounded = supportGrounded({
      plane: input.plane,
      kbPlane: catalogCount > 0 ? 'live' : 'dark',
      requireKb: true,
      kbHitCount: catalogCount,
    });
    if (grounded.status === 'refuse') {
      return {
        status: 'refuse',
        reason: grounded.reason === 'kb_empty' ? 'kb_plane_ungrounded' : grounded.reason,
        userMessageKey: grounded.userMessageKey,
        unanswered: [],
        metering: unmetered(input.feeAssetId),
      };
    }
  }

  if (input.asks.length === 0) {
    // Nothing was asked. Opening a session to read nothing would be a charge for
    // a lookup that never happened.
    return {
      status: 'empty',
      userMessageKey: 'agents.support.empty',
      metering: unmetered(input.feeAssetId),
    };
  }

  if (input.plane === 'live' && !input.desk) {
    return {
      status: 'refuse',
      reason: 'no_live_kb',
      userMessageKey: 'agents.support.unavailable',
      unanswered: [],
      metering: unmetered(input.feeAssetId),
    };
  }

  // If the tier grants none of the asked tools, every read would refuse inside
  // the session for a reason already knowable outside it. Refuse closed, free.
  const granted = new Set(tier.allowedTools);
  const asked = input.asks.map((ask) => ask.tool.trim());
  if (!asked.some((tool) => granted.has(tool))) {
    return {
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.support.tier_closed',
      unanswered: [],
      metering: unmetered(input.feeAssetId),
    };
  }

  // No KB read was asked for, so this run could not cite anything whatever the
  // other reads return. That is knowable now, and escalating now costs nothing —
  // rather than opening a session, reading an account projection, and then
  // discovering there was never going to be a grounded reply.
  if (!asked.includes(SUPPORT_KB_TOOL)) {
    return {
      status: 'escalate',
      reason: 'kb_no_hit',
      userMessageKey: 'agents.support.escalated',
      findings: [],
      unanswered: [],
      caseFile: buildSupportCaseFile({ reason: 'kb_no_hit' }),
      metering: unmetered(input.feeAssetId),
    };
  }

  // ── The metered run ───────────────────────────────────────────────────────
  const session = await input.runtime.openSession({ userId: input.userId, agentId: SUPPORT_AGENT_ID });

  let metering: SupportRunMetering | null = null;
  try {
    const findings: SupportDataToolOk[] = [];
    const unanswered: SupportUnanswered[] = [];
    /**
     * The KB read's own outcome, kept so the escalate decision is made from what
     * the KB read actually did.
     *
     * The guardrail case is held separately rather than being written down as a
     * refusal the tool never produced. Synthesising a `SupportDataToolResult`
     * here would put a fact in the record that no tool returned, which is the
     * exact class of invention this file exists to refuse — and it would also
     * mislabel a policy refusal as a KB miss.
     */
    let kb: { readonly by: 'guardrail' } | { readonly by: 'tool'; readonly result: SupportDataToolResult } | null = null;

    for (const ask of input.asks) {
      // Tool calls are stoppable: abort mid-loop, settle what ran, no silent fee.
      if (input.signal?.aborted) {
        metering = await settleAndClose(input.runtime, session.id, input.feeAssetId);
        return {
          status: 'stopped',
          reason: 'aborted',
          userMessageKey: 'agents.support.unavailable',
          findings,
          unanswered,
          metering,
        };
      }

      const tool = ask.tool.trim();
      let toolResult: SupportDataToolResult;

      try {
        const act = await input.runtime.act({
          sessionId: session.id,
          tool,
          // Reached only after the guardrail has allowed the call. An undeclared
          // tool — including every money one — never gets this far.
          execute: async () => {
            const resolved = resolveSupportAskFixtures({
              ask,
              requesterUserId: input.userId,
              kbCatalog: input.kbCatalog ?? null,
            });
            if (resolved.status === 'refuse') {
              const refuse: SupportDataToolRefuse = {
                status: 'refuse',
                tool,
                reason: resolved.reason,
                userMessageKey: 'agents.support.unavailable',
              };
              return refuse;
            }
            return invokeSupportDataTool({
              tool,
              plane: input.plane,
              kbPlane: catalogCount > 0 ? 'live' : 'dark',
              requesterUserId: input.userId,
              tierLaw: input.tierLaw ?? null,
              userTier: input.userTier,
              desk: input.desk ?? null,
              ...(input.deskHeaders === undefined ? {} : { deskHeaders: input.deskHeaders }),
              kbQuery: ask.kbQuery ?? '',
              kbSearchLimit: ask.limit,
              articles: resolved.articles,
              ticket: resolved.ticket,
              account: resolved.account,
            });
          },
        });
        toolResult = act.result as SupportDataToolResult;
      } catch (err) {
        // The session guardrail said no (undeclared tool, action budget, spend
        // ceiling). Recorded as a gap in the answer, not routed around.
        if (err instanceof RefusedError) {
          unanswered.push({
            tool,
            refusedBy: 'guardrail',
            reason: err.refusal.code,
            userMessageKey: err.refusal.userMessageKey,
          });
          // A guardrail refusal on the KB read is still the KB read's outcome:
          // there are no articles, so the reply cannot cite anything.
          if (tool === SUPPORT_KB_TOOL && kb === null) kb = { by: 'guardrail' };
          continue;
        }
        throw err;
      }

      if (tool === SUPPORT_KB_TOOL && kb === null) {
        kb = { by: 'tool', result: toolResult };
      }

      if (toolResult.status === 'ok') {
        findings.push(toolResult);
      } else {
        unanswered.push({
          tool,
          refusedBy: 'tool',
          reason: toolResult.reason,
          userMessageKey: toolResult.userMessageKey,
        });
      }
    }

    metering = await settleAndClose(input.runtime, session.id, input.feeAssetId);

    if (findings.length === 0) {
      // Nothing at all was reachable — not the KB, not the account projection.
      // There is no answer to give and nothing for a human to pick up either, so
      // this is a refusal. A result object with an empty finding list would read
      // like an answer.
      return {
        status: 'refuse',
        reason: 'no_grounded_read',
        userMessageKey: 'agents.support.unavailable',
        unanswered,
        metering,
      };
    }

    // Account-state was asked and missing/invent — refuse invent. A KB cite with
    // complete:false would still read like the desk checked the account.
    const accountAsked = asked.includes('identity.account.read');
    const accountMissing = unanswered.some((u) => u.tool === 'identity.account.read' && ACCOUNT_STATE_MISSING_REASONS.has(u.reason));
    if (accountAsked && accountMissing) {
      return {
        status: 'refuse',
        reason: 'account_state_missing',
        userMessageKey: 'agents.support.unavailable',
        unanswered,
        metering,
      };
    }

    // A KB read the guardrail refused is a closed door, not a KB that was
    // searched and missed. `kb === null` cannot happen — a KB ask is a
    // precondition of reaching this loop — but the default if it ever did is to
    // hand over to a person, because "we do not know what the KB said" is never
    // a licence to compose a reply.
    if (kb === null || kb.by === 'guardrail') {
      const reason = kb === null ? 'kb_no_hit' : 'desk_refused';
      return {
        status: 'escalate',
        reason,
        userMessageKey: 'agents.support.escalated',
        findings,
        unanswered,
        caseFile: buildSupportCaseFile({ reason, findings, unanswered }),
        metering,
      };
    }

    // The typed "I don't know", decided by the same pure function the
    // `answerOrEscalate` route uses — one law, two callers.
    const decision = supportAnswerOrEscalate({ kbResult: kb.result });
    if (decision.status === 'escalate') {
      return {
        status: 'escalate',
        reason: decision.reason,
        userMessageKey: decision.userMessageKey,
        findings,
        unanswered,
        caseFile: buildSupportCaseFile({ reason: decision.reason, findings, unanswered }),
        metering,
      };
    }

    return {
      status: 'ok',
      userTier: tier.userTier,
      findings,
      unanswered,
      citedArticleKeys: decision.citedArticleKeys,
      asked: input.asks.length,
      answered: findings.length,
      complete: unanswered.length === 0,
      metering,
    };
  } finally {
    // Only if a return path did not already settle: `settleSession` is
    // idempotent, but closing twice on the throw path would still be noise.
    if (metering === null) {
      await settleAndClose(input.runtime, session.id, input.feeAssetId).catch(() => {
        // The original error is the one worth propagating; a settlement failure
        // on top of it must not replace it. The window stays open and unsealed,
        // which is the state a sweep can still find and finish.
      });
    }
  }
}

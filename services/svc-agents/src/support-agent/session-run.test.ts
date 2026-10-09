import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { AuditedAction } from '../fleet/audit.js';
import { evaluateToolCall, type Guardrail, type Refusal, type SessionState } from '../fleet/guardrails.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import type { SettlementResult } from '../metering/meter.js';
import { SUPPORT_DATA_TOOLS } from './data-tools.js';
import { createFixtureSupportDesk } from './desk-port.js';
import { supportAgentGuardrail, SUPPORT_MONEY_TOOLS } from './guardrail.js';
import { runSupportReplySession, SUPPORT_AGENT_ID, SUPPORT_KB_TOOL } from './session-run.js';

/**
 * The metered `support.reply` run.
 *
 * Postgres is doubled here; the POLICY is not. The double calls the real
 * `evaluateToolCall` against the real `supportAgentGuardrail()`, and the run
 * under test calls the real data tools and the real escalate decision. What is
 * faked is row storage — `runtime.test.ts` owns the database properties
 * (append-only, the window seal, the unique request id) against real Postgres,
 * and re-faking them here would only test the fake.
 *
 * The theme of this file: a support agent that answers when it should not is the
 * worst failure this service has, so most of these tests assert on what did NOT
 * happen — which tool never reached its executor, and which sentence was never
 * composed.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-07T12:00:00.000Z');

const law = {
  published: true as const,
  matrix: { free: [...SUPPORT_DATA_TOOLS] },
};

const ARTICLE = {
  articleKey: 'support.kb.withdrawal_hold',
  titleKey: 'support.kb.withdrawal_hold.title',
  bodyKey: 'support.kb.withdrawal_hold.body',
};

function kbAsk(articles: readonly (typeof ARTICLE)[] | null = [ARTICLE]) {
  return { tool: SUPPORT_KB_TOOL, articles, limit: 20 };
}

/** Published ops.support catalog — fixture article keys are not a live KB by themselves. */
const PUBLISHED_KB = [{ id: ARTICLE.articleKey, titleKey: ARTICLE.titleKey, bodyKey: ARTICLE.bodyKey }];

function accountAsk(userId = USER) {
  return {
    tool: 'identity.account.read',
    account: { userId, status: 'active' as const, kycTier: 'tier2' },
  };
}

function ticketAsk(ownerUserId = USER) {
  return {
    tool: 'support.ticket.read',
    ticket: { ticketId: 'tkt-1', ownerUserId, status: 'open' as const, category: 'withdrawals' },
  };
}

function fakeAction(tool: string, status: 'executed' | 'refused'): AuditedAction {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    sessionId: SESSION,
    userId: USER,
    agentId: SUPPORT_AGENT_ID,
    sequence: 0,
    kind: 'tool_call',
    status,
    tool,
    task: null,
    providerId: null,
    model: null,
    inputTokens: 0n,
    outputTokens: 0n,
    cost: 0n,
    refusalCode: null,
    userMessageKey: 'agents.action.executed',
    userMessageParams: {},
    inputDigest: null,
    outputDigest: null,
    prevHash: null,
    hash: 'h',
    occurredAt: NOW,
  };
}

/**
 * A runtime double that enforces the real guardrail.
 *
 * `executed` records the tools whose `execute` closure actually ran. It is the
 * handle the guardrail tests below assert on: a tool that appears there was
 * really invoked, whatever the run later reported about it.
 *
 * `settlements` is what the meter would hand back; the default is `[]`, which is
 * what a real support run produces — it never calls the engine, so it opens no
 * usage window and there is nothing to settle.
 */
class FakeRuntime {
  readonly toolCalls: string[] = [];
  readonly refusedCalls: string[] = [];
  readonly executed: string[] = [];
  openCalls = 0;
  settleCalls = 0;
  closeCalls = 0;
  guardrail: Guardrail = supportAgentGuardrail();
  settlements: SettlementResult[] = [];

  async openSession(input: { userId: string; agentId: string }) {
    this.openCalls += 1;
    return {
      id: SESSION,
      userId: input.userId,
      agentId: input.agentId,
      guardrail: this.guardrail,
      guardrailVersion: this.guardrail.version,
      status: 'open' as const,
      metered: true,
      openedAt: NOW,
      closedAt: null,
    };
  }

  private state(): SessionState {
    const toolCalls: Record<string, number> = {};
    for (const t of this.toolCalls) toolCalls[t] = (toolCalls[t] ?? 0) + 1;
    return {
      status: 'open',
      actionCount: this.toolCalls.length + this.refusedCalls.length,
      toolCalls,
      spend: 0n,
      approvedTools: [],
    };
  }

  async act(input: { sessionId: string; tool: string; execute: () => Promise<unknown> }) {
    const decision = evaluateToolCall(this.guardrail, this.state(), { tool: input.tool });
    if (!decision.allowed) {
      this.refusedCalls.push(input.tool);
      throw new RefusedError(decision as Refusal, fakeAction(input.tool, 'refused'));
    }
    this.executed.push(input.tool);
    const result = await input.execute();
    this.toolCalls.push(input.tool);
    return { result, action: fakeAction(input.tool, 'executed') };
  }

  async settleSession(_sessionId: string): Promise<SettlementResult[]> {
    this.settleCalls += 1;
    return this.settlements;
  }

  async closeSession(_sessionId: string) {
    this.closeCalls += 1;
    return {
      id: SESSION,
      userId: USER,
      agentId: SUPPORT_AGENT_ID,
      guardrail: this.guardrail,
      guardrailVersion: this.guardrail.version,
      status: 'closed' as const,
      metered: true,
      openedAt: NOW,
      closedAt: NOW,
    };
  }
}

function runtimeOf(fake: FakeRuntime): AgentRuntime {
  return fake as unknown as AgentRuntime;
}

function testDesk(overrides: Parameters<typeof createFixtureSupportDesk>[0] = {}) {
  return createFixtureSupportDesk({
    articles: [ARTICLE],
    tickets: [{ ticketId: 'tkt-1', ownerUserId: USER, status: 'open', category: 'withdrawals' }],
    accounts: [{ userId: USER, status: 'active', kycTier: 'tier2' }],
    ...overrides,
  });
}

function baseInput(fake: FakeRuntime) {
  return {
    runtime: runtimeOf(fake),
    userId: USER,
    feeAssetId: 'IFC',
    plane: 'live' as const,
    kbCatalog: PUBLISHED_KB,
    tierLaw: law,
    userTier: 'free',
    desk: testDesk(),
  };
}

describe('support.reply metered session run', () => {
  it('answers through the runtime, then settles and closes the session', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), asks: [kbAsk(), accountAsk()] });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.answered).toBe(2);
    expect(result.asked).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.unanswered).toEqual([]);
    // The reply cites what the KB actually returned — nothing was composed.
    expect(result.citedArticleKeys).toEqual([ARTICLE.articleKey]);
    expect(result.findings[0]).toMatchObject({ tool: SUPPORT_KB_TOOL });

    // One audited tool call per read — the guardrail saw every lookup.
    expect(fake.toolCalls).toEqual([SUPPORT_KB_TOOL, 'identity.account.read']);
    expect(fake.openCalls).toBe(1);
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
    expect(result.metering.sessionId).toBe(SESSION);
    expect(result.metering.sessionClosed).toBe(true);
  });

  it('carries the account projection without ever carrying a balance', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), asks: [kbAsk(), accountAsk()] });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const account = result.findings.find((f) => f.tool === 'identity.account.read');
    expect(account).toEqual({
      status: 'ok',
      tool: 'identity.account.read',
      account: { userId: USER, status: 'active', kycTier: 'tier2' },
    });
    // §0.6 by construction: there is no money field on the projection to leak.
    expect(Object.keys(account && account.tool === 'identity.account.read' ? account.account : {})).toEqual([
      'userId',
      'status',
      'kycTier',
    ]);
  });

  it('bills zero for a run that never called the engine, and does not invent a charge', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), asks: [kbAsk()] });

    expect(result.metering.billedAmount).toBe('0');
    expect(result.metering.settlements).toEqual([]);
    expect(result.metering.assetId).toBe('IFC');
    // Money is a decimal string on the wire, never a number.
    expect(typeof result.metering.billedAmount).toBe('string');
  });

  it('reports what the meter settled as decimal strings, summed in bigint', async () => {
    const fake = new FakeRuntime();
    fake.settlements = [
      {
        sessionId: SESSION,
        windowId: '2026-08-07T12:00',
        chargeKey: 'agent.usage:s:w1',
        amount: parseAmount('0.75'),
        chargeTxId: 'tx1',
        settled: true,
      },
      {
        sessionId: SESSION,
        windowId: '2026-08-07T12:05',
        chargeKey: 'agent.usage:s:w2',
        amount: parseAmount('0.25'),
        chargeTxId: 'tx2',
        settled: true,
      },
    ];

    const result = await runSupportReplySession({ ...baseInput(fake), asks: [kbAsk()] });

    // 0.75 + 0.25 = 1 at the ledger's scale — summed as bigint, formatted once.
    expect(result.metering.billedAmount).toBe('1');
    expect(result.metering.settlements.map((s) => s.amount)).toEqual(['0.75', '0.25']);
    expect(result.metering.settlements.every((s) => typeof s.amount === 'string')).toBe(true);
  });

  // ── The guardrail is load-bearing ─────────────────────────────────────────

  it('does not run a money tool a caller-supplied tier matrix tried to grant', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      // Product law is caller-supplied, so a bad matrix is a real input. The
      // tier gate would hand `pay.refund` over; the session guardrail must not.
      tierLaw: { published: true, matrix: { free: [SUPPORT_KB_TOOL, 'pay.refund'] } },
      asks: [kbAsk(), { tool: 'pay.refund' }],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // THE assertion: the refund tool never reached its executor. If the runtime
    // stopped enforcing the declared toolset, `execute` would have run and this
    // line would fail — which is the point of the test.
    expect(fake.executed).toEqual([SUPPORT_KB_TOOL]);
    expect(fake.executed).not.toContain('pay.refund');
    expect(fake.refusedCalls).toEqual(['pay.refund']);

    // And the refusal is reported as a gap, not swallowed.
    expect(result.unanswered).toEqual([
      {
        tool: 'pay.refund',
        refusedBy: 'guardrail',
        reason: 'agents.tool_not_declared',
        userMessageKey: 'agents.refused.tool_not_declared',
      },
    ]);
    expect(result.complete).toBe(false);
    expect(result.answered).toBe(1);
  });

  it('never reaches the executor for ANY tool on the money denylist', async () => {
    const fake = new FakeRuntime();
    const money = [...SUPPORT_MONEY_TOOLS];

    await runSupportReplySession({
      ...baseInput(fake),
      tierLaw: { published: true, matrix: { free: [SUPPORT_KB_TOOL, ...money] } },
      asks: [kbAsk(), ...money.map((tool) => ({ tool }))],
    });

    const declared = new Set(supportAgentGuardrail().tools.map((t) => t.name));
    expect(fake.executed.every((t) => declared.has(t))).toBe(true);
    expect(fake.refusedCalls.sort()).toEqual([...money].sort());
    // Not one money tool was even attempted against its executor.
    expect(money.some((t) => fake.executed.includes(t))).toBe(false);
  });

  it('holds the approval-gated comment tool rather than posting it silently', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      tierLaw: { published: true, matrix: { free: [SUPPORT_KB_TOOL, 'support.ticket.comment'] } },
      asks: [kbAsk(), { tool: 'support.ticket.comment' }],
    });

    // The tool IS declared — but as a write requiring approval, and the run
    // never supplies one. The guardrail, not this file, is what stops it.
    expect(fake.executed).toEqual([SUPPORT_KB_TOOL]);
    expect(fake.refusedCalls).toEqual(['support.ticket.comment']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.unanswered[0]).toMatchObject({
      tool: 'support.ticket.comment',
      refusedBy: 'guardrail',
      userMessageKey: 'agents.refused.approval_required',
    });
  });

  it('records a guardrail action-budget refusal as an unanswered read instead of answering around it', async () => {
    const fake = new FakeRuntime();
    // A guardrail whose action budget allows exactly one call.
    fake.guardrail = supportAgentGuardrail();
    (fake.guardrail as { limits: { maxActionsPerSession: number } }).limits.maxActionsPerSession = 1;

    const result = await runSupportReplySession({
      ...baseInput(fake),
      asks: [kbAsk(), accountAsk(), ticketAsk()],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.answered).toBe(1);
    expect(result.unanswered).toHaveLength(2);
    expect(result.unanswered.every((u) => u.refusedBy === 'guardrail' && u.reason === 'agents.action_limit')).toBe(true);
    expect(fake.executed).toEqual([SUPPORT_KB_TOOL]);
    // Still settled and closed despite the refusals.
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  // ── Honesty: never fabricate what a tool could not return ─────────────────

  it('refuses when account-state was asked and missing — no invent from KB alone', async () => {
    const fake = new FakeRuntime();
    const desk = testDesk({ tickets: [] });
    desk.readAccount = async () => ({
      status: 'ok',
      account: { userId: OTHER_USER, status: 'active', kycTier: 'tier2' },
    });
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk,
      asks: [
        kbAsk(),
        { tool: 'support.ticket.read', ticket: null }, // no row — refused, never stubbed
        accountAsk(OTHER_USER), // somebody else's account — refused, never read
      ],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'account_state_missing',
      userMessageKey: 'agents.support.unavailable',
    });
    if (result.status !== 'refuse') return;
    expect(result.unanswered.map((u) => [u.refusedBy, u.reason])).toEqual([
      ['tool', 'missing_fixture'],
      ['tool', 'account_owner_mismatch'],
    ]);
    // KB hit is not enough to invent account state — refuse, settle, no silent fee.
    expect(result.metering.billedAmount).toBe('0');
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('stops mid-run on abort without running remaining tools or inventing a feeCharge', async () => {
    const fake = new FakeRuntime();
    const ac = new AbortController();
    ac.abort();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      signal: ac.signal,
      asks: [kbAsk(), accountAsk()],
    });

    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'aborted',
      userMessageKey: 'agents.support.unavailable',
    });
    if (result.status !== 'stopped') return;
    expect(fake.openCalls).toBe(0);
    expect(fake.executed).toEqual([]);
    expect(result.metering.billedAmount).toBe('0');
    expect(result.metering.sessionId).toBeNull();
  });

  it('stops after a partial ask list and still settles the open session', async () => {
    const fake = new FakeRuntime();
    const ac = new AbortController();
    // Abort after the first tool would have been scheduled: pre-abort the signal
    // once openSession has been called by wrapping act.
    const originalAct = fake.act.bind(fake);
    let calls = 0;
    fake.act = async (input) => {
      calls += 1;
      if (calls === 1) ac.abort();
      return originalAct(input);
    };

    const result = await runSupportReplySession({
      ...baseInput(fake),
      signal: ac.signal,
      asks: [kbAsk(), accountAsk(), ticketAsk()],
    });

    expect(result.status).toBe('stopped');
    if (result.status !== 'stopped') return;
    // First ask ran; later asks did not.
    expect(fake.executed).toEqual([SUPPORT_KB_TOOL]);
    expect(result.findings).toHaveLength(1);
    expect(result.metering.billedAmount).toBe('0');
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('grounds a reply from published kbCatalog + accountGrounding (no invent)', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: testDesk({
        articles: [
          {
            articleKey: 'kb-account-access',
            titleKey: 'support.kb.account_access.title',
            bodyKey: 'support.kb.account_access.body',
          },
        ],
        accounts: [{ userId: USER, status: 'active', kycTier: 'basic' }],
      }),
      asks: [
        { tool: SUPPORT_KB_TOOL, kbQuery: 'account', limit: 20 },
        {
          tool: 'identity.account.read',
          accountGrounding: {
            status: 'read',
            state: { userId: USER, status: 'active', kycTier: 'basic' },
            readAt: '2026-08-12T00:00:00.000Z',
          },
        },
      ],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.citedArticleKeys).toEqual(['kb-account-access']);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'identity.account.read',
          account: { userId: USER, status: 'active', kycTier: 'basic' },
        }),
      ]),
    );
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses when accountGrounding is plane_dark — KB alone is not invent account-state', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: testDesk({
        articles: [
          {
            articleKey: 'kb-account-access',
            titleKey: 'support.kb.account_access.title',
            bodyKey: 'support.kb.account_access.body',
          },
        ],
        unreadAccounts: true,
      }),
      asks: [
        { tool: SUPPORT_KB_TOOL, kbQuery: 'account', limit: 20 },
        {
          tool: 'identity.account.read',
          accountGrounding: { status: 'unread', reason: 'plane_dark' },
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'account_state_missing',
      userMessageKey: 'agents.support.unavailable',
    });
    if (result.status !== 'refuse') return;
    expect(result.unanswered.map((u) => [u.tool, u.reason])).toEqual([['identity.account.read', 'account_plane_dark']]);
    expect(result.metering.billedAmount).toBe('0');
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('refuses when identity.account.read is unreachable — KB alone is not invent account-state', async () => {
    const fake = new FakeRuntime();
    const desk = testDesk({
      articles: [
        {
          articleKey: 'kb-account-access',
          titleKey: 'support.kb.account_access.title',
          bodyKey: 'support.kb.account_access.body',
        },
      ],
    });
    desk.readAccount = async () => ({ status: 'unreachable' });
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk,
      asks: [
        { tool: SUPPORT_KB_TOOL, kbQuery: 'account', limit: 20 },
        { tool: 'identity.account.read' },
      ],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'account_state_missing',
      userMessageKey: 'agents.support.unavailable',
    });
    if (result.status !== 'refuse') return;
    expect(result.unanswered.map((u) => [u.tool, u.reason])).toEqual([['identity.account.read', 'no_live_kb']]);
    expect(result.metering.billedAmount).toBe('0');
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('escalates when kbQuery misses the catalog but other grounded reads worked', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: testDesk({
        articles: [
          {
            articleKey: 'kb-orders-status',
            titleKey: 'support.kb.orders_status.title',
            bodyKey: 'support.kb.orders_status.body',
          },
        ],
      }),
      // Account is readable; KB miss must not invent an article to answer with.
      asks: [{ tool: SUPPORT_KB_TOOL, kbQuery: 'definitely-not-an-article-xyz', limit: 20 }, accountAsk()],
    });

    expect(result).toMatchObject({
      status: 'escalate',
      reason: 'kb_no_hit',
      userMessageKey: 'agents.support.escalated',
    });
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses the whole run when NO data source was reachable — no invented answer', async () => {
    const fake = new FakeRuntime();
    // The KB has no articles and the account row is missing: every source the
    // reply could have been grounded in is dark.
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: testDesk({ articles: [], accounts: [], unreadAccounts: true }),
      asks: [kbAsk(null), { tool: 'identity.account.read', account: null }],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_grounded_read',
      userMessageKey: 'agents.support.unavailable',
    });
    if (result.status !== 'refuse') return;
    expect(result.unanswered).toHaveLength(2);
    // There is no sentence, no article key, and no "your account looks fine".
    expect(Object.keys(result)).toEqual(['status', 'reason', 'userMessageKey', 'unanswered', 'metering']);
    // The session it opened is still settled and closed.
    expect(fake.openCalls).toBe(1);
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('escalates rather than answering when the KB missed but other reads worked', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: testDesk({ articles: [] }),
      // The account state is readable; the knowledge base is not. A reply here
      // would have to come from somewhere other than the KB — so there is none.
      asks: [kbAsk(null), accountAsk()],
    });

    expect(result).toMatchObject({
      status: 'escalate',
      reason: 'kb_no_hit',
      userMessageKey: 'agents.support.escalated',
    });
    if (result.status !== 'escalate') return;
    // What it could read still travels, so the person picking this up sees it.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ tool: 'identity.account.read' });
    // Doctrine case file: human handoff carries account status, never a balance.
    expect(result.caseFile.reason).toBe('kb_no_hit');
    expect(result.caseFile.moneyRequest).toBe(false);
    expect(result.caseFile.accounts).toEqual([{ userId: USER, status: 'active', kycTier: 'tier2' }]);
    expect(result.caseFile).not.toHaveProperty('balance');
    // Account projection is status+KYC only — no money fields on the case file.
    for (const acct of result.caseFile.accounts) {
      expect(Object.keys(acct).sort()).toEqual(['kycTier', 'status', 'userId']);
    }
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('escalates as a closed door — not a KB miss — when the guardrail refused the KB read', async () => {
    const fake = new FakeRuntime();
    // Strip the KB tool from the declared set: the read is now policy-refused.
    const base = supportAgentGuardrail();
    fake.guardrail = { ...base, tools: base.tools.filter((t) => t.name !== SUPPORT_KB_TOOL) };

    const result = await runSupportReplySession({ ...baseInput(fake), asks: [kbAsk(), accountAsk()] });

    expect(result).toMatchObject({ status: 'escalate', reason: 'desk_refused' });
    expect(fake.executed).toEqual(['identity.account.read']);
    expect(fake.refusedCalls).toEqual([SUPPORT_KB_TOOL]);
  });

  it('escalates a money request for free, without opening a session or reading a KB', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      moneyRequest: true,
      asks: [kbAsk()],
    });

    expect(result).toMatchObject({
      status: 'escalate',
      reason: 'money_request',
      userMessageKey: 'agents.support.escalated',
    });
    if (result.status !== 'escalate') return;
    // Case file flags money — person uses ops/ledger, agent invents no amount.
    expect(result.caseFile.moneyRequest).toBe(true);
    expect(result.caseFile.findings).toEqual([]);
    expect(result.caseFile.accounts).toEqual([]);
    expect(result.caseFile).not.toHaveProperty('refundAmount');
    // A refund is `ops.support` + a ledger recipe. The agent does not look it up
    // and does not bill for discovering it cannot help.
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('escalates for free when no KB read was asked for at all', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), asks: [accountAsk()] });

    expect(result).toMatchObject({ status: 'escalate', reason: 'kb_no_hit' });
    // Nothing to cite was ever going to exist, so no session was opened for it.
    expect(fake.openCalls).toBe(0);
    expect(result.metering.billedAmount).toBe('0');
  });

  // ── Free refusals, before a session exists ────────────────────────────────

  it('refuses an ungrounded live KB plane — no invented ops.support answers', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: null,
      kbCatalog: null,
      asks: [{ tool: SUPPORT_KB_TOOL, kbQuery: 'withdrawal-hold', limit: 20 }, accountAsk()],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'kb_plane_ungrounded',
      userMessageKey: 'agents.support.unavailable',
    });
    // Not a live KB plane: no session, no articles composed, no silent fee.
    expect(fake.openCalls).toBe(0);
    expect(fake.executed).toEqual([]);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
    expect(result).not.toHaveProperty('citedArticleKeys');
    expect(result).not.toHaveProperty('findings');
  });

  it('refuses an empty catalog the same way — empty is not a published KB', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: null,
      kbCatalog: [],
      asks: [{ tool: SUPPORT_KB_TOOL, kbQuery: 'account', limit: 20 }],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'kb_plane_ungrounded',
      userMessageKey: 'agents.support.unavailable',
    });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.billedAmount).toBe('0');
  });

  it('live catalog without a desk port refuses no_live_kb — fixtures are not a live KB', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      desk: null,
      asks: [kbAsk(), accountAsk()],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_kb',
      userMessageKey: 'agents.support.unavailable',
    });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses smuggled article fixtures when the KB catalog is dark — never status ok', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      kbCatalog: null,
      asks: [kbAsk(), accountAsk()],
    });

    expect(result.status).not.toBe('ok');
    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'kb_plane_ungrounded',
      userMessageKey: 'agents.support.unavailable',
    });
    expect(result).not.toHaveProperty('citedArticleKeys');
    expect(result).not.toHaveProperty('findings');
    expect(fake.openCalls).toBe(0);
    expect(fake.executed).toEqual([]);
    expect(result.metering.billedAmount).toBe('0');
  });

  it('still escalates a money request when the KB catalog is dark', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      kbCatalog: null,
      moneyRequest: true,
      asks: [kbAsk(), accountAsk()],
    });

    expect(result.status).not.toBe('ok');
    expect(result).toMatchObject({ status: 'escalate', reason: 'money_request' });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses a dark desk plane before opening a metered session', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), plane: 'dark', asks: [kbAsk()] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'desk_plane_dark',
      userMessageKey: 'agents.support.unavailable',
    });
    // Nothing opened means nothing to bill for the platform's own darkness.
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses an unpublished tier law before opening a metered session', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), tierLaw: null, asks: [kbAsk()] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.support.tier_closed',
    });
    expect(fake.openCalls).toBe(0);
  });

  it('refuses when the tier grants none of the asked tools', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({
      ...baseInput(fake),
      tierLaw: { published: true, matrix: { free: ['support.ticket.read'] } },
      asks: [kbAsk()],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.support.tier_closed',
    });
    expect(fake.openCalls).toBe(0);
  });

  it('is empty — not a session — when nothing was asked', async () => {
    const fake = new FakeRuntime();
    const result = await runSupportReplySession({ ...baseInput(fake), asks: [] });

    expect(result).toMatchObject({ status: 'empty', userMessageKey: 'agents.support.empty' });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.billedAmount).toBe('0');
  });

  // ── The thrown path ───────────────────────────────────────────────────────

  it('settles and closes even when the run throws', async () => {
    const fake = new FakeRuntime();
    const boom = new Error('storage exploded');
    fake.act = async () => {
      throw boom;
    };

    await expect(runSupportReplySession({ ...baseInput(fake), asks: [kbAsk()] })).rejects.toThrow('storage exploded');

    // No leaked open session, no unbilled window left for a sweep nobody runs.
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('propagates the original failure even when settlement also fails', async () => {
    const fake = new FakeRuntime();
    fake.act = async () => {
      throw new Error('tool exploded');
    };
    fake.settleSession = async () => {
      throw new Error('meter exploded');
    };

    // The error worth reporting is the one that broke the run, not the one the
    // cleanup hit on the way out.
    await expect(runSupportReplySession({ ...baseInput(fake), asks: [kbAsk()] })).rejects.toThrow('tool exploded');
  });
});

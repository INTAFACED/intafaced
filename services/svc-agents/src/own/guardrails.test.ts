import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import type { SupportDeskPort } from '../support-agent/desk-port.js';
import { parseTierLaws } from '../tier-laws.js';
import { checkRule, parsePolicyBaseline, type PolicyBaseline } from './guardrails.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * A person's own agent's standing rules, consents and approval requests (AG-guardrails-01, AG-guardrails-02; J-agents-05
 * #1 and #2), through the service's own routes on real Postgres: a rule saves or is refused at save, a call of a class
 * not yet allowed is refused until the person allows it and again once they revoke it, and a call a rule asks about is
 * one approval request whose tool never ran.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
/** A support request the desk does not hold: a comment on it is refused for good. */
const MISSING_TICKET = '44444444-4444-4444-8444-444444444444';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'an-agents-own-guardrails-test-secret-of-32-plus!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const PERSON = ['agents:read', 'agents:execute', 'identity:write'];
const TEST_BASELINE: PolicyBaseline = {
  own_data: 'act_on_request',
  market_data: 'act_on_request',
  draft_write: 'ask_before',
  live_write: 'act_on_request',
};
const TIER_LAWS = parseTierLaws(
  JSON.stringify({
    support: { published: true, matrix: { basic: ['support.kb.search', 'support.ticket.read', 'identity.account.read'] } },
  }),
);

function callerFor(userId: string, scopes: readonly string[] = PERSON) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-own-guardrails',
  });
}

describe('checkRule and the baseline, without a database', () => {
  const tools = ['support.kb.search', 'support.ticket.comment'];
  it('lets asking first or handing off through whatever the baseline, even a blank one', () => {
    for (const choice of ['ask_before', 'hand_off'] as const) {
      expect(() => checkRule({}, tools, 'support.ticket.comment', choice)).not.toThrow();
    }
  });
  it('refuses a live-write tool acting without asking, before the baseline is read', () => {
    expect(() => checkRule(TEST_BASELINE, tools, 'support.ticket.comment', 'act_without_asking')).toThrow('agents.rule_invalid');
    expect(() => checkRule({}, tools, 'support.ticket.comment', 'act_without_asking')).toThrow('agents.rule_invalid');
  });
  it('refuses a rule looser than the baseline, and one that needs a blank baseline', () => {
    expect(() => checkRule(TEST_BASELINE, tools, 'support.kb.search', 'act_without_asking')).toThrow('agents.baseline_loosen_refused');
    expect(() => checkRule(TEST_BASELINE, tools, 'support.kb.search', 'act_on_request')).not.toThrow();
    expect(() => checkRule({}, tools, 'support.kb.search', 'act_on_request')).toThrow('agents.baseline_value_unset');
  });
  it('refuses a rule for a tool the agent does not carry: a rule never grants a tool', () => {
    expect(() => checkRule(TEST_BASELINE, tools, 'trade.quote', 'ask_before')).toThrow('agents.tool_not_declared');
    expect(() => checkRule(TEST_BASELINE, tools, 'ledger.transfer', 'ask_before')).toThrow('agents.tool_not_declared');
  });
  it('reads the baseline from its setting: blank is blank, anything malformed stops the boot', () => {
    expect(parsePolicyBaseline(undefined)).toEqual({});
    expect(parsePolicyBaseline('  ')).toEqual({});
    expect(parsePolicyBaseline('{"live_write":"ask_before"}')).toEqual({ live_write: 'ask_before' });
    expect(() => parsePolicyBaseline('{')).toThrow('not JSON');
    expect(() => parsePolicyBaseline('{"web":"ask_before"}')).toThrow('unknown class');
    expect(() => parsePolicyBaseline('{"own_data":"always"}')).toThrow('unknown choice');
    expect(() => parsePolicyBaseline('[]')).toThrow('must be an object');
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent guardrails (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-guardrails-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;
  let searches: string[];
  /** Every comment the desk was asked for, by its key, and what identity answers for the owner's account. */
  let comments: Array<{ ticketId: string; body: string; clientRequestId: string }>;
  let account: 'active' | 'frozen' | 'unreachable';

  const desk: SupportDeskPort = {
    async searchKb(query) {
      searches.push(query);
      return { status: 'ok', articles: [{ articleKey: 'kb-account-access', titleKey: 'kb.title.access', bodyKey: 'kb.body.access' }] };
    },
    async getKb() {
      return { status: 'unreachable' };
    },
    async readTicket() {
      return { status: 'unreachable' };
    },
    async readAccount(userId) {
      if (account === 'unreachable') return { status: 'unreachable' };
      return { status: 'ok', account: { userId, status: account, kycTier: 1 } } as never;
    },
    async commentTicket(input) {
      if (input.ticketId === MISSING_TICKET) return { status: 'missing' };
      comments.push(input);
      const first = comments.findIndex((c) => c.clientRequestId === input.clientRequestId);
      return { status: 'ok', comment: { id: `TEST-comment-${first + 1}`, ticketId: input.ticketId, createdAt: new Date(0).toISOString() } };
    },
  };

  function people(baseline: PolicyBaseline = TEST_BASELINE, approvalTtlSeconds: number | null = 3600) {
    const table = parseRoutingTable({
      routes: [
        {
          task: OWN_RUN_TASK,
          providerId: 'primary',
          model: 'reasoning-md',
          maxOutputTokens: 2048,
          price: { inputPerMillion: '1', outputPerMillion: '5' },
        },
      ],
    });
    const gateway = new ModelGateway([new MockModelProvider({ id: 'primary' })], table);
    const meter = new UsageMeter(sql, new MemoryLedger(), { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => 100n * 10n ** 18n },
    });
    const router = createAgentsRouter({
      runtime,
      gateway,
      meter,
      feeAssetId: 'USDT',
      sql,
      supportDesk: desk,
      tierLaws: TIER_LAWS,
      policyBaseline: baseline,
      ownApprovalTtlSeconds: approvalTtlSeconds,
    });
    return {
      person: router.createCaller(callerFor(USER)),
      other: router.createCaller(callerFor(OTHER)),
      /** The same person with execute but without identity:write: not their own signed-in session. */
      notSession: router.createCaller(callerFor(USER, ['agents:read', 'agents:execute'])),
    };
  }
  type Person = ReturnType<typeof people>['person'];

  /** An agent with the help search and the comment tool, its caps set and a session open. */
  async function agentWithSession(person: Person) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `guard:${Math.random()}` });
    await person.own.save({
      id,
      name: 'TEST helper',
      instructions: '',
      tools: ['support.kb.search', 'support.ticket.comment'],
      perSessionCap: '1',
    });
    await person.own.limits.set({ id, perCall: '0.1', perSession: '0.5', perPeriod: '5' });
    const { sessionId } = await person.own.session.open({ id });
    return { id, sessionId };
  }

  const executed = async (tool: string) =>
    (
      await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM agents.agent_actions WHERE kind = 'tool_call' AND status = 'executed' AND tool = ${tool}
      `
    )[0]!.n;
  const requests = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.own_agent_approval_requests`)[0]!.n;

  beforeAll(async () => {
    lockConn = await sql.reserve();
    await lockConn`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lockConn`select pg_advisory_unlock(842671)`;
    }
  }, 120_000);

  beforeEach(async () => {
    await lockConn`select pg_advisory_lock(842671)`;
    await sql`
      TRUNCATE agents.own_agent_surfaces, agents.own_agent_versions, agents.own_agent_co_owners, agents.own_agent_session_versions, agents.own_agent_approval_requests, agents.own_agent_consents, agents.own_agent_rules, agents.own_agent_limits,
               agents.own_agents, agents.spend_reservations, agents.user_spend_limits, agents.think_claims, agents.usage_records,
               agents.usage_windows, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    searches = [];
    comments = [];
    account = 'unreachable';
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('standing rules (J-agents-05 #1)', () => {
    it('saves "ask before" for the comment tool; refuses acting without asking on it and loosening the baseline, storing neither', async () => {
      const { person } = people();
      const { id } = await agentWithSession(person);
      const saved = await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      expect(saved).toMatchObject({ tool: 'support.ticket.comment', choice: 'ask_before' });
      // The same rule again is the same row.
      expect(await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' })).toEqual(saved);
      await expect(person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'act_without_asking' })).rejects.toMatchObject({
        message: 'agents.rule_invalid',
      });
      await expect(person.own.rules.save({ id, tool: 'support.kb.search', choice: 'act_without_asking' })).rejects.toMatchObject({
        message: 'agents.baseline_loosen_refused',
      });
      await expect(person.own.rules.save({ id, tool: 'trade.quote', choice: 'ask_before' })).rejects.toMatchObject({
        message: 'agents.tool_not_declared',
      });
      expect(await person.own.rules.list({ id })).toEqual([saved]);
    });

    it('turns the comment the rule asks about into one approval request; the tool never runs, and a retry is the same request', async () => {
      const { person } = people();
      const { id, sessionId } = await agentWithSession(person);
      await person.own.consents.grant({ id, dataClass: 'live_write' });
      const args = { ticketId: 'TEST-ticket', body: 'TEST comment' };
      // With no rule the baseline lets the call go on, and the comment's door is not built: refused, nothing sent.
      await expect(
        person.own.tool.try({ id, sessionId, requestId: 'try:comment:0', tool: 'support.ticket.comment', input: args }),
      ).rejects.toMatchObject({ message: 'agents.tool_not_wired' });
      expect(await requests()).toBe(0);
      const rule = await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      const first = await person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args });
      expect(first).toMatchObject({
        outcome: 'waiting',
        tool: 'support.ticket.comment',
        dataClass: 'live_write',
        request: { sessionId, tool: 'support.ticket.comment', input: args, status: 'waiting', ruleId: rule.id },
      });
      const again = await person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args });
      expect(again).toEqual(first);
      expect(await requests()).toBe(1);
      expect(await executed('support.ticket.comment')).toBe(0);
      expect(await person.own.approvals({ id, limit: 10 })).toEqual([first.outcome === 'waiting' ? first.request : null]);
    });

    it('a baseline that requires asking asks without a rule; handing off refuses; a blank baseline refuses the call', async () => {
      const strict = people({ ...TEST_BASELINE, own_data: 'ask_before' }).person;
      const { id, sessionId } = await agentWithSession(strict);
      await strict.own.consents.grant({ id, dataClass: 'own_data' });
      const asked = await strict.own.tool.try({
        id,
        sessionId,
        requestId: 'try:kb:1',
        tool: 'support.kb.search',
        input: { kbQuery: 'access', limit: '5' },
      });
      expect(asked).toMatchObject({ outcome: 'waiting', request: { ruleId: null } });
      await strict.own.rules.save({ id, tool: 'support.kb.search', choice: 'hand_off' });
      await expect(
        strict.own.tool.try({ id, sessionId, requestId: 'try:kb:2', tool: 'support.kb.search', input: { kbQuery: 'access', limit: '5' } }),
      ).rejects.toMatchObject({ message: 'agents.rule_hand_off' });
      const blank = people({}).person;
      await expect(
        blank.own.tool.try({ id, sessionId, requestId: 'try:kb:3', tool: 'support.kb.search', input: { kbQuery: 'access', limit: '5' } }),
      ).rejects.toMatchObject({ message: 'agents.baseline_value_unset' });
      expect(searches).toEqual([]);
    });
  });

  describe('a held call on Live runs and in the Approvals inbox (J-agents-05 #3)', () => {
    it('lists the held comment as a waiting run with no action and no cost, and as the person’s inbox row; the tool never ran', async () => {
      const { person, other } = people();
      const { id, sessionId } = await agentWithSession(person);
      await person.own.consents.grant({ id, dataClass: 'live_write' });
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      expect(await person.own.inbox({ limit: 10 })).toEqual([]);
      const args = { ticketId: 'TEST-ticket', body: 'TEST comment' };
      const held = await person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args });
      if (held.outcome !== 'waiting') throw new Error('the rule should hold the comment');
      const runs = await person.own.runs({ id, limit: 10 });
      expect(runs).toEqual([
        {
          sessionId,
          sequence: null,
          status: 'waiting',
          task: null,
          tool: 'support.ticket.comment',
          requestId: held.request.id,
          refusalCode: null,
          cost: '0',
          assetId: expect.any(String),
          occurredAt: held.request.createdAt,
        },
      ]);
      expect(await executed('support.ticket.comment')).toBe(0);
      expect(await person.own.inbox({ limit: 10 })).toEqual([{ ...held.request, agentId: id, agentName: 'TEST helper' }]);
      // Another person's inbox never shows it.
      expect(await other.own.inbox({ limit: 10 })).toEqual([]);
    });
  });

  describe('deciding a held call (J-agents-05 #5 #6)', () => {
    const TICKET = '33333333-3333-4333-8333-333333333333';
    const args = { ticketId: TICKET, body: 'TEST comment' };

    /** An agent whose comment the rule holds, and one held comment of it. */
    async function held(person: Person, requestId = 'try:comment:1', input: Record<string, string> = args) {
      const agent = await agentWithSession(person);
      await person.own.consents.grant({ id: agent.id, dataClass: 'live_write' });
      await person.own.rules.save({ id: agent.id, tool: 'support.ticket.comment', choice: 'ask_before' });
      const call = await person.own.tool.try({ ...agent, requestId, tool: 'support.ticket.comment', input });
      if (call.outcome !== 'waiting') throw new Error('the rule should hold the comment');
      return { ...agent, request: call.request };
    }

    it('a blank wait refuses holding the call: nothing is stored and the tool does not run', async () => {
      const { person } = people(TEST_BASELINE, null);
      const { id, sessionId } = await agentWithSession(person);
      await person.own.consents.grant({ id, dataClass: 'live_write' });
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      await expect(
        person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'agents.approval.ttl_unset' });
      expect(await requests()).toBe(0);
    });

    it('edit replaces the request with a new one; the old one can never be approved; approve runs once and a repeat returns the first result', async () => {
      const { person } = people();
      account = 'active';
      const { id, sessionId, request } = await held(person);
      expect(request).toMatchObject({ status: 'waiting', refusalCode: null, decidedAt: null, result: null, ranAt: null });
      const edited = { ...args, body: 'TEST comment, edited' };
      const { replaced, request: fresh } = await person.own.approval.edit({ requestId: request.id, input: edited });
      expect(replaced).toMatchObject({ id: request.id, status: 'replaced', replacedBy: fresh.id, refusalCode: 'agents.approval.replaced' });
      expect(fresh).toMatchObject({ sessionId, tool: 'support.ticket.comment', input: edited, status: 'waiting', ruleId: request.ruleId });
      // The same edit again is the same new request; another edit of the replaced one refuses.
      expect((await person.own.approval.edit({ requestId: request.id, input: edited })).request.id).toBe(fresh.id);
      await expect(person.own.approval.edit({ requestId: request.id, input: { ...args, body: 'TEST other' } })).rejects.toMatchObject({
        message: 'agents.approval.replaced',
      });
      // The old approval does not carry over: the replaced request refuses, and nothing ran.
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.approval.replaced',
      });
      expect(comments).toEqual([]);
      expect(await executed('support.ticket.comment')).toBe(0);

      const approved = await person.own.approval.approve({ requestId: fresh.id });
      expect(approved.repeated).toBe(false);
      expect(approved.request).toMatchObject({ id: fresh.id, status: 'approved', refusalCode: null });
      expect(approved.request.result).toEqual({
        tool: 'support.ticket.comment',
        ticketId: TICKET,
        commentId: 'TEST-comment-1',
        commented: 'yes',
      });
      expect(comments).toEqual([{ ticketId: TICKET, body: 'TEST comment, edited', clientRequestId: `agents:approve:${fresh.id}` }]);
      expect(await executed('support.ticket.comment')).toBe(1);
      const again = await person.own.approval.approve({ requestId: fresh.id });
      expect(again).toEqual({ request: approved.request, repeated: true });
      expect(comments).toHaveLength(1);
      expect(await executed('support.ticket.comment')).toBe(1);
      // The agent's own call of the original id follows the edit and reads what ran; rejecting the approved one refuses.
      expect(await person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args })).toEqual(
        { outcome: 'ran', tool: 'support.ticket.comment', dataClass: 'live_write', result: approved.request.result },
      );
      await expect(person.own.approval.reject({ requestId: fresh.id })).rejects.toMatchObject({ message: 'agents.approval.decided' });
      // An edit names only the tool's declared fields, none blank.
      const other = await held(person, 'try:comment:2');
      const badEdits: Array<Record<string, string>> = [
        { ...args, amount: '1' },
        { ...args, body: '  ' },
        {},
        { ticketId: TICKET },
        { ...args, ticketId: 'x'.repeat(121) },
      ];
      for (const input of badEdits) {
        await expect(person.own.approval.edit({ requestId: other.request.id, input })).rejects.toMatchObject({
          message: 'agents.approval.input_invalid',
        });
      }
    });

    it('reject ends the step with a typed refusal the call reads; an expired request refuses and never runs', async () => {
      const { person } = people();
      account = 'active';
      const { id, sessionId, request } = await held(person);
      const rejected = await person.own.approval.reject({ requestId: request.id });
      expect(rejected).toMatchObject({ status: 'rejected', refusalCode: 'agents.approval.rejected', decidedAt: expect.any(String) });
      expect(await person.own.approval.reject({ requestId: request.id })).toEqual(rejected);
      await expect(
        person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'agents.approval.rejected' });
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({ message: 'agents.approval.rejected' });

      const late = await person.own.tool.try({ id, sessionId, requestId: 'try:comment:3', tool: 'support.ticket.comment', input: args });
      if (late.outcome !== 'waiting') throw new Error('held');
      await sql`UPDATE agents.own_agent_approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${late.request.id}`;
      const [row] = (await person.own.inbox({ limit: 10 })).filter((r) => r.id === late.request.id);
      expect(row).toMatchObject({ status: 'expired', refusalCode: 'agents.approval.expired' });
      expect((await person.own.runs({ id, limit: 10 })).filter((r) => r.requestId === late.request.id)).toEqual([]);
      await expect(person.own.approval.approve({ requestId: late.request.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.approval.expired',
      });
      await expect(person.own.approval.edit({ requestId: late.request.id, input: args })).rejects.toMatchObject({
        message: 'agents.approval.expired',
      });
      await expect(
        person.own.tool.try({ id, sessionId, requestId: 'try:comment:3', tool: 'support.ticket.comment', input: args }),
      ).rejects.toMatchObject({ message: 'agents.approval.expired' });
      expect(comments).toEqual([]);
      expect(await executed('support.ticket.comment')).toBe(0);
    });

    it('only the person’s own signed-in session approves: a principal without identity:write is refused and nothing runs', async () => {
      const { person, notSession } = people();
      account = 'active';
      const { request } = await held(person);
      await expect(notSession.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await person.own.inbox({ limit: 10 }))[0]).toMatchObject({ id: request.id, status: 'waiting' });
      expect(comments).toEqual([]);
    });

    it('runs the gates again at approve: a withdrawn consent or a hand-off rule refuses, still waiting, nothing ran', async () => {
      const { person } = people();
      account = 'active';
      const { id, request } = await held(person);
      await person.own.consents.revoke({ id, dataClass: 'live_write' });
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({ message: 'agents.consent_required' });
      await person.own.consents.grant({ id, dataClass: 'live_write' });
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'hand_off' });
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({ message: 'agents.rule_hand_off' });
      expect((await person.own.inbox({ limit: 10 }))[0]).toMatchObject({ id: request.id, status: 'waiting' });
      expect(comments).toEqual([]);
      expect(await executed('support.ticket.comment')).toBe(0);
    });

    it('two approves at once run the tool once: one runs, the other is refused as running or returns the first result', async () => {
      const { person } = people();
      account = 'active';
      const { request } = await held(person);
      const answers = await Promise.allSettled([
        person.own.approval.approve({ requestId: request.id }),
        person.own.approval.approve({ requestId: request.id }),
      ]);
      const ran = answers.filter((a) => a.status === 'fulfilled' && !a.value.repeated);
      expect(ran).toHaveLength(1);
      for (const answer of answers) {
        if (answer.status === 'rejected') expect(answer.reason).toMatchObject({ code: 'CONFLICT', message: 'agents.approval.running' });
      }
      expect(comments).toHaveLength(1);
      expect(await executed('support.ticket.comment')).toBe(1);
      expect((await person.own.approval.approve({ requestId: request.id })).repeated).toBe(true);
      expect(await executed('support.ticket.comment')).toBe(1);
    });

    it('a door that refuses for good ends the request failed with its code, which the call reads; no retry runs it', async () => {
      const { person } = people();
      account = 'active';
      const { id, sessionId, request } = await held(person, 'try:comment:missing', { ticketId: MISSING_TICKET, body: 'TEST comment' });
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({
        message: 'agents.tool_refused.ticket_missing',
      });
      const [row] = await person.own.inbox({ limit: 10 });
      expect(row).toMatchObject({
        status: 'failed',
        refusalCode: 'agents.approval.failed',
        failureCode: 'agents.tool_refused.ticket_missing',
      });
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({ message: 'agents.approval.failed' });
      await expect(person.own.approval.reject({ requestId: request.id })).rejects.toMatchObject({ message: 'agents.approval.failed' });
      await expect(
        person.own.tool.try({
          id,
          sessionId,
          requestId: 'try:comment:missing',
          tool: 'support.ticket.comment',
          input: { ticketId: MISSING_TICKET, body: 'TEST comment' },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'agents.approval.failed' });
    });

    it('a held call with no approval door refuses at approve before anything is decided, so it can still be rejected', async () => {
      const strict = people({ ...TEST_BASELINE, own_data: 'ask_before' }).person;
      account = 'active';
      const { id, sessionId } = await agentWithSession(strict);
      await strict.own.consents.grant({ id, dataClass: 'own_data' });
      const asked = await strict.own.tool.try({
        id,
        sessionId,
        requestId: 'try:kb:1',
        tool: 'support.kb.search',
        input: { kbQuery: 'a', limit: '5' },
      });
      if (asked.outcome !== 'waiting') throw new Error('held');
      await expect(strict.own.approval.approve({ requestId: asked.request.id })).rejects.toMatchObject({
        message: 'agents.tool_not_wired',
      });
      expect((await strict.own.approval.reject({ requestId: asked.request.id })).status).toBe('rejected');
      expect(searches).toEqual([]);
    });

    it('fails closed when identity cannot be read or the owner is frozen: refused, still waiting, nothing ran; another person cannot decide', async () => {
      const { person, other } = people();
      const { request } = await held(person);
      account = 'unreachable';
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.identity.owner_unread',
      });
      account = 'frozen';
      await expect(person.own.approval.approve({ requestId: request.id })).rejects.toMatchObject({
        message: 'agents.identity.owner_frozen',
      });
      expect((await person.own.inbox({ limit: 10 }))[0]).toMatchObject({ id: request.id, status: 'waiting' });
      expect(comments).toEqual([]);
      expect(await executed('support.ticket.comment')).toBe(0);
      account = 'active';
      for (const decide of [
        () => other.own.approval.approve({ requestId: request.id }),
        () => other.own.approval.reject({ requestId: request.id }),
        () => other.own.approval.edit({ requestId: request.id, input: args }),
      ]) {
        await expect(decide()).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'agents.approval.not_found' });
      }
      expect((await person.own.approval.approve({ requestId: request.id })).request.status).toBe('approved');
    });
  });

  describe('a held call is the session’s and its key’s', () => {
    it('a closed session holds nothing; a reused request id is that request even after the rule changes, never another call', async () => {
      const { person } = people();
      const { id, sessionId } = await agentWithSession(person);
      await person.own.consents.grant({ id, dataClass: 'live_write' });
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      const args = { ticketId: 'TEST-ticket', body: 'TEST comment' };
      const first = await person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args });
      // The rule loosened to "act when I say so": the held id still answers with its request, and nothing runs.
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'act_on_request' });
      expect(await person.own.tool.try({ id, sessionId, requestId: 'try:comment:1', tool: 'support.ticket.comment', input: args })).toEqual(
        first,
      );
      // The same id with other input is not a retry of that call.
      await expect(
        person.own.tool.try({
          id,
          sessionId,
          requestId: 'try:comment:1',
          tool: 'support.ticket.comment',
          input: { ...args, body: 'TEST other' },
        }),
      ).rejects.toMatchObject({ message: 'agents.request_id_replay' });
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      await person.own.session.close({ id, sessionId });
      await expect(
        person.own.tool.try({ id, sessionId, requestId: 'try:comment:2', tool: 'support.ticket.comment', input: args }),
      ).rejects.toMatchObject({ message: 'agents.session_closed' });
      expect(await requests()).toBe(1);
    });

    it('the session binds the comment as a write that needs approval, so the runtime never runs it unapproved', async () => {
      const { person } = people();
      const { sessionId } = await agentWithSession(person);
      const session = (
        await sql<{ guardrail: { tools: { name: string; requiresApproval: boolean }[] } }[]>`
        SELECT guardrail FROM agents.agent_sessions WHERE id = ${sessionId}
      `
      )[0]!;
      expect(session.guardrail.tools.find((tool) => tool.name === 'support.ticket.comment')).toMatchObject({ requiresApproval: true });
      expect(session.guardrail.tools.find((tool) => tool.name === 'support.kb.search')).toMatchObject({ requiresApproval: false });
    });

    it('a help search its door refuses is a refusal, recorded as no read', async () => {
      const { person } = people();
      const { id, sessionId } = await agentWithSession(person);
      await person.own.consents.grant({ id, dataClass: 'own_data' });
      // No page size: the door refuses rather than invent one.
      await expect(
        person.own.tool.try({ id, sessionId, requestId: 'try:kb:9', tool: 'support.kb.search', input: { kbQuery: 'access' } }),
      ).rejects.toMatchObject({ message: 'agents.tool_refused.kb_search_limit_unset' });
      expect(await executed('support.kb.search')).toBe(0);
    });
  });

  describe('connector-class consent (J-agents-05 #2)', () => {
    it('refuses the first use of a class until it is allowed, runs once allowed, and refuses again once revoked', async () => {
      const { person } = people();
      const { id, sessionId } = await agentWithSession(person);
      const call = (n: number) =>
        person.own.tool.try({
          id,
          sessionId,
          requestId: `try:kb:${n}`,
          tool: 'support.kb.search',
          input: { kbQuery: 'access', limit: '5' },
        });
      await expect(call(1)).rejects.toMatchObject({ message: 'agents.consent_required' });
      expect(searches).toEqual([]);
      expect(await executed('support.kb.search')).toBe(0);
      expect(await person.own.consents.list({ id })).toEqual([]);

      const granted = await person.own.consents.grant({ id, dataClass: 'own_data' });
      expect(granted).toMatchObject({ dataClass: 'own_data', state: 'granted', revokedAt: null });
      // A repeated grant is the stored row.
      expect(await person.own.consents.grant({ id, dataClass: 'own_data' })).toEqual(granted);
      const ran = await call(2);
      expect(ran).toMatchObject({
        outcome: 'ran',
        tool: 'support.kb.search',
        dataClass: 'own_data',
        result: { status: 'ok', articles: [{ articleKey: 'kb-account-access' }] },
      });
      expect(searches).toEqual(['access']);
      expect(await executed('support.kb.search')).toBe(1);

      const withdrawn = await person.own.consents.revoke({ id, dataClass: 'own_data' });
      expect(withdrawn).toMatchObject({ dataClass: 'own_data', state: 'withdrawn' });
      expect(withdrawn.revokedAt).not.toBeNull();
      expect(await person.own.consents.list({ id })).toEqual([withdrawn]);
      await expect(call(3)).rejects.toMatchObject({ message: 'agents.consent_required' });
      expect(searches).toEqual(['access']);
      expect(await executed('support.kb.search')).toBe(1);
    });

    it('a consent is per class: allowing own data does not allow a live write; revoking one never granted refuses', async () => {
      const { person } = people();
      const { id, sessionId } = await agentWithSession(person);
      await person.own.consents.grant({ id, dataClass: 'own_data' });
      await expect(
        person.own.tool.try({
          id,
          sessionId,
          requestId: 'try:comment:9',
          tool: 'support.ticket.comment',
          input: { ticketId: 't', body: 'b' },
        }),
      ).rejects.toMatchObject({ message: 'agents.consent_required' });
      await expect(person.own.consents.revoke({ id, dataClass: 'market_data' })).rejects.toMatchObject({
        message: 'agents.consent_not_granted',
      });
    });

    it('another person can neither read, grant nor use this agent’s consents, rules or session', async () => {
      const { person, other } = people();
      const { id, sessionId } = await agentWithSession(person);
      await expect(other.own.consents.grant({ id, dataClass: 'own_data' })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other.own.consents.list({ id })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other.own.rules.save({ id, tool: 'support.kb.search', choice: 'ask_before' })).rejects.toMatchObject({
        message: 'agents.own.not_found',
      });
      await expect(other.own.approvals({ id, limit: 10 })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(
        other.own.tool.try({ id, sessionId, requestId: 'try:other:1', tool: 'support.kb.search', input: { kbQuery: 'a', limit: '5' } }),
      ).rejects.toMatchObject({ message: 'agents.own.not_found' });
      expect(await person.own.consents.list({ id })).toEqual([]);
    });
  });
}

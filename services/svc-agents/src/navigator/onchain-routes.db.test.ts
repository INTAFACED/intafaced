import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, router, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase } from '@intafaced/db';
import { navigatorOnchainRoutes, type NavigatorOnchainDeps } from './onchain-routes.js';
import { NavigatorOnchainStore } from './onchain.js';

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const SECRET = 'an-agents-navigator-onchain-test-secret';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const USER = '11111111-1111-4111-8111-111111111119';
const OTHER = '22222222-2222-4222-8222-222222222229';
const SESSION = '33333333-3333-4333-8333-333333333339';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444449';
const SCANNER_SESSION = '55555555-5555-4555-8555-555555555559';
const CLOSED_SESSION = '66666666-6666-4666-8666-666666666669';
const SIGNER = '0x00000000000000000000000000000000005e0019';
const ACCOUNT = '0x00000000000000000000000000000000000A0019';
const ROUTER = '0x00000000000000000000000000000000000b0019';
const SWAP = '0x8f2a8b5e';
const HASH_A = '0x' + 'aa'.repeat(32);
const HASH_B = '0x' + 'bb'.repeat(32);
const TRADE = 'TEST: swap 0.1 TEST Token A for TEST Token B on-chain';

function ctxOf(userId: string, scopes: string[], extra: { kid?: string } = {}) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '77777777-7777-4777-8777-777777777779',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-navigator-onchain',
  });
}

// Runs unconditionally: CI provides the database.
{
  const sql = postgres(URL, { max: 4, connection: { search_path: 'agents,public' }, onnotice: () => undefined });
  await assertTestDatabase(sql, 'svc-agents');
  let lock: Awaited<ReturnType<typeof sql.reserve>>;

  const sessions: Record<string, { userId: string; agentId: string; status: string }> = {
    [SESSION]: { userId: USER, agentId: 'navigator', status: 'open' },
    [OTHER_SESSION]: { userId: OTHER, agentId: 'navigator', status: 'open' },
    [SCANNER_SESSION]: { userId: USER, agentId: 'scanner', status: 'open' },
    [CLOSED_SESSION]: { userId: USER, agentId: 'navigator', status: 'closed' },
  };
  const deps = (over: Partial<NavigatorOnchainDeps> = {}): NavigatorOnchainDeps => ({
    sql,
    signer: SIGNER,
    approvalTtlSeconds: 3600,
    session: async (id) => sessions[id] ?? null,
    ...over,
  });
  const as = (userId: string, over: Partial<NavigatorOnchainDeps> = {}, extra: { kid?: string } = {}) =>
    router({ navigator: router(navigatorOnchainRoutes(deps(over))) }).createCaller(ctxOf(userId, ['agents:read', 'agents:execute'], extra))
      .navigator;
  const grant = {
    chainId: 84532,
    account: ACCOUNT,
    specHash: HASH_A,
    spendLimitWei: '1000000000000000000',
    validUntil: 2_000_000_000,
    targets: [ROUTER],
    selectors: [SWAP],
  };
  const count = async (table: string, userId = USER) =>
    Number(
      (await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM ${sql('agents')}.${sql(table)} WHERE user_id = ${userId}`)[0]!.n,
    );

  beforeAll(async () => {
    lock = await sql.reserve();
    await lock`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lock`select pg_advisory_unlock(842671)`;
    }
  }, 120_000);

  beforeEach(async () => {
    await lock`select pg_advisory_lock(842671)`;
    await sql`TRUNCATE agents.navigator_approval_requests, agents.navigator_onchain_bindings RESTART IDENTITY CASCADE`;
    await sql`DELETE FROM agents.agent_sessions WHERE id IN ${sql(Object.keys(sessions))}`;
    for (const [id, s] of Object.entries(sessions))
      await sql`
        INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
        VALUES (${id}, ${s.userId}, ${s.agentId}, ${sql.json({ limits: {} })}, 1)
      `;
  }, 30_000);

  afterEach(async () => {
    await lock`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lock.release();
    await sql.end({ timeout: 5 });
  });

  describe('navigator.onchain.signer', () => {
    it('names the signer on the test network and refuses mainnet, no signer and other chains by code', async () => {
      await expect(as(USER).onchain.signer({ chainId: 84532 })).resolves.toEqual({ signer: SIGNER, chainId: 84532, network: 'testnet' });
      await expect(as(USER).onchain.signer({ chainId: 8453 })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'audit.external',
      });
      await expect(as(USER, { signer: null }).onchain.signer({ chainId: 84532 })).rejects.toMatchObject({ message: 'rail.crypto' });
      await expect(as(USER).onchain.signer({ chainId: 1 })).rejects.toMatchObject({ message: 'agents.onchain_chain_unsupported' });
    });
  });

  describe('navigator.onchain.bind', () => {
    it('refuses a blank cap and a missing expiry by name and stores nothing', async () => {
      await expect(as(USER).onchain.bind({ ...grant, spendLimitWei: '' })).rejects.toMatchObject({
        message: 'agents.session_key_cap_unset',
      });
      await expect(as(USER).onchain.bind({ ...grant, spendLimitWei: null })).rejects.toMatchObject({
        message: 'agents.session_key_cap_unset',
      });
      await expect(as(USER).onchain.bind({ ...grant, validUntil: null })).rejects.toMatchObject({
        message: 'agents.session_key_expiry_unset',
      });
      await expect(as(USER).onchain.bind({ ...grant, selectors: [SWAP, '0x095ea7b3'] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.session_key_selector_forbidden',
      });
      await expect(as(USER, { signer: null }).onchain.bind(grant)).rejects.toMatchObject({ message: 'rail.crypto' });
      await expect(as(USER).onchain.bind({ ...grant, chainId: 8453 })).rejects.toMatchObject({ message: 'audit.external' });
      expect(await count('navigator_onchain_bindings')).toBe(0);
    });

    it('binds the configured signer, never a key from the body, keyed by chain, account and key', async () => {
      const row = await as(USER).onchain.bind({ ...grant, sessionKey: '0x000000000000000000000000000000000000dead' } as typeof grant);
      expect(row).toMatchObject({
        sessionKey: SIGNER,
        account: ACCOUNT.toLowerCase(),
        spendLimitWei: '1000000000000000000',
        validUntil: 2_000_000_000,
        targets: [ROUTER],
        selectors: [SWAP],
        specHash: HASH_A,
        bindKey: `agents:onchain:navigator:84532:${ACCOUNT.toLowerCase()}:${SIGNER}`,
        revokeRequestedAt: null,
      });
    });

    it('a bind retried after its reply was lost returns the first row: one row, same id', async () => {
      const first = await as(USER).onchain.bind(grant);
      const [again, concurrent] = await Promise.all([as(USER).onchain.bind(grant), as(USER).onchain.bind(grant)]);
      expect(again.id).toBe(first.id);
      expect(concurrent.id).toBe(first.id);
      expect(again.createdAt).toBe(first.createdAt);
      expect(await count('navigator_onchain_bindings')).toBe(1);
    });

    it('a new scope for the same key replaces what was prepared and clears a revoke request, in one row', async () => {
      const first = await as(USER).onchain.bind(grant);
      await as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT });
      // The same scope again is a retry: the revoke request stands.
      expect((await as(USER).onchain.bind(grant)).revokeRequestedAt).not.toBeNull();
      const next = await as(USER).onchain.bind({ ...grant, specHash: HASH_B, spendLimitWei: '5', validUntil: 2_000_000_100 });
      expect(next).toMatchObject({
        id: first.id,
        specHash: HASH_B,
        spendLimitWei: '5',
        validUntil: 2_000_000_100,
        revokeRequestedAt: null,
      });
      expect(await count('navigator_onchain_bindings')).toBe(1);
    });

    it('is the person only: a delegated key may not bind', async () => {
      await expect(as(USER, {}, { kid: 'key-1' }).onchain.bind(grant)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('navigator.onchain.revoke and binding', () => {
    it('reads null before a bind, the row after, and marks it revoking once', async () => {
      await expect(as(USER).onchain.binding({ chainId: 84532, account: ACCOUNT })).resolves.toEqual({ binding: null });
      await as(USER).onchain.bind(grant);
      const read = await as(USER).onchain.binding({ chainId: 84532, account: ACCOUNT.toLowerCase() });
      expect(read.binding).toMatchObject({ specHash: HASH_A, revokeRequestedAt: null });
      const asked = await as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT });
      expect(asked.revokeRequestedAt).not.toBeNull();
      const again = await as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT });
      expect(again.revokeRequestedAt).toBe(asked.revokeRequestedAt);
      expect((await as(USER).onchain.binding({ chainId: 84532, account: ACCOUNT })).binding?.revokeRequestedAt).toBe(
        asked.revokeRequestedAt,
      );
    });

    it('refuses a revoke with nothing bound as not found', async () => {
      await expect(as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'agents.onchain_binding_not_found',
      });
    });

    it("never shows or revokes another person's binding", async () => {
      await as(OTHER).onchain.bind(grant);
      await expect(as(USER).onchain.binding({ chainId: 84532, account: ACCOUNT })).resolves.toEqual({ binding: null });
      await expect(as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // The same account and key bound by this person is their own row, beside the other's.
      await as(USER).onchain.bind(grant);
      expect(await count('navigator_onchain_bindings', USER)).toBe(1);
      expect(await count('navigator_onchain_bindings', OTHER)).toBe(1);
      expect((await as(OTHER).onchain.binding({ chainId: 84532, account: ACCOUNT })).binding?.revokeRequestedAt).toBeNull();
    });
  });

  describe('navigator.ask and navigator.approvals', () => {
    it('holds a trade ask as a waiting approval request and runs nothing', async () => {
      const result = await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      expect(result).toMatchObject({
        kind: 'approval',
        ceiling: false,
        request: { sessionId: SESSION, requestKey: `agents:approve:${SESSION}:r-1`, tool: 'trade', text: TRADE, status: 'waiting' },
      });
      if (result.kind !== 'approval') throw new Error('expected an approval');
      const wait = Date.parse(result.request.expiresAt) - Date.parse(result.request.createdAt);
      expect(wait).toBeGreaterThan(3_590_000);
      expect(wait).toBeLessThan(3_610_000);
      // Nothing was metered or audited: an ask is not a run.
      const usage = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.usage_records WHERE session_id = ${SESSION}`;
      expect(usage[0]!.n).toBe('0');
      const actions = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.agent_actions WHERE session_id = ${SESSION}`;
      expect(actions[0]!.n).toBe('0');
    });

    it('says the key is a ceiling when a binding with no revoke asked is held, and still asks', async () => {
      await as(USER).onchain.bind(grant);
      const live = await as(USER).ask({ sessionId: SESSION, requestId: 'r-2', text: TRADE });
      expect(live).toMatchObject({ kind: 'approval', ceiling: true, request: { status: 'waiting' } });
      await as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT });
      expect(await as(USER).ask({ sessionId: SESSION, requestId: 'r-3', text: TRADE })).toMatchObject({ kind: 'approval', ceiling: false });
    });

    it('the same request id twice is the first request; with other words it refuses', async () => {
      const first = await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      const again = await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      if (first.kind !== 'approval' || again.kind !== 'approval') throw new Error('expected approvals');
      expect(again.request.id).toBe(first.request.id);
      expect(await count('navigator_approval_requests')).toBe(1);
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: 'TEST: sell everything' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'agents.request_id_replay',
      });
    });

    it('stores nothing for an ask that names no trade', async () => {
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'r-4', text: 'what moved today?' })).resolves.toEqual({ kind: 'none' });
      expect(await count('navigator_approval_requests')).toBe(0);
    });

    it('refuses holding a trade ask while the wait is blank, and stores nothing', async () => {
      await expect(as(USER, { approvalTtlSeconds: null }).ask({ sessionId: SESSION, requestId: 'r-5', text: TRADE })).rejects.toMatchObject(
        {
          message: 'agents.approval.ttl_unset',
        },
      );
      expect(await count('navigator_approval_requests')).toBe(0);
    });

    it("refuses another person's session, another agent's session and a closed one", async () => {
      await expect(as(USER).ask({ sessionId: OTHER_SESSION, requestId: 'r-6', text: TRADE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(as(USER).ask({ sessionId: SCANNER_SESSION, requestId: 'r-6', text: TRADE })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(as(USER).ask({ sessionId: CLOSED_SESSION, requestId: 'r-6', text: TRADE })).rejects.toMatchObject({
        message: 'agents.refused.session_closed',
      });
      await expect(as(USER).approvals({ sessionId: OTHER_SESSION })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await count('navigator_approval_requests')).toBe(0);
    });

    it("lists the session's requests newest first, survives a new reader, and shows no other person's", async () => {
      await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      await as(USER).ask({ sessionId: SESSION, requestId: 'r-2', text: 'TEST: buy 1 TEST Token B' });
      await as(OTHER).ask({ sessionId: OTHER_SESSION, requestId: 'r-1', text: TRADE });
      const { requests } = await as(USER).approvals({ sessionId: SESSION });
      expect(requests.map((r) => r.text)).toEqual(['TEST: buy 1 TEST Token B', TRADE]);
      expect(requests.every((r) => r.status === 'waiting')).toBe(true);
      // A store read straight from the database, as after a restart, reads the same rows.
      expect((await new NavigatorOnchainStore(sql).requests(USER, SESSION)).map((r) => r.id)).toEqual(requests.map((r) => r.id));
      expect((await as(OTHER).approvals({ sessionId: OTHER_SESSION })).requests).toHaveLength(1);
    });

    it('reads a request past its wait as expired', async () => {
      await as(USER, { approvalTtlSeconds: 1 }).ask({ sessionId: SESSION, requestId: 'r-7', text: TRADE });
      await sql`UPDATE agents.navigator_approval_requests SET expires_at = now() - interval '1 second' WHERE user_id = ${USER}`;
      expect((await as(USER).approvals({ sessionId: SESSION })).requests[0]?.status).toBe('expired');
    });
  });
}

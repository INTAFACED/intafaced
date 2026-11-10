import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { decodeFunctionData, getAddress, parseAbi } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, router, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase } from '@intafaced/db';
import { navigatorOnchainRoutes, type NavigatorOnchainDeps } from './onchain-routes.js';
import { NavigatorOnchainStore } from './onchain.js';
import { NavigatorSignerRefused, type LiveGrant, type NavigatorChain, type NavigatorSender } from './onchain-trade.js';

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
const POOL = '0x00000000000000000000000000000000000c0019';
const WETH = '0x0000000000000000000000000000000000e7e700';
const TOKEN_B = '0x00000000000000000000000000000000000b0b00';
const TOKEN_A = '0x00000000000000000000000000000000000a11ce';
const AB_POOL = '0x00000000000000000000000000000000000d0019';
const ROUTER_SWAP = '0x7b32b50e';
const ETH = 10n ** 18n;
const SESSION_ABI = parseAbi([
  'function executeWithSession((address key, uint48 validAfter, uint48 validUntil, uint128 spendLimitWei, address[] targets, bytes4[] selectors) spec, address target, uint256 value, bytes data) returns (bytes)',
  'function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)',
]);
const TRADE = 'TEST: swap 0.1 TEST Wrapped ETH for TEST Token B';
const BIG = 'TEST: swap 2 TEST Wrapped ETH for TEST Token B';

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
  // The chain as the account contract would answer: a live grant with a 1 TEST ETH cap on the router and the WETH/B pool.
  let chainGrant: LiveGrant | null;
  let receipt: 'success' | 'reverted' | null;
  let sent: Array<{ chainId: number; from: string; to: string; data: string }>;
  let senderFails: false | 'refused' | 'unknown';
  const liveGrant = (over: Partial<LiveGrant> = {}): LiveGrant => ({
    live: true,
    specHash: HASH_A,
    validAfter: 0,
    validUntil: 2_000_000_000,
    spendLimitWei: ETH,
    spentWei: 0n,
    targets: [ROUTER, POOL, AB_POOL].map((a) => a.toLowerCase()),
    selectors: [ROUTER_SWAP],
    ...over,
  });
  const chain: NavigatorChain = {
    grant: async () => chainGrant,
    pool: async (pool) =>
      pool.toLowerCase() === POOL.toLowerCase()
        ? {
            pool: pool.toLowerCase(),
            tokens: [
              { address: WETH, symbol: 'TESTWETH', name: 'TEST Wrapped ETH', decimals: 18 },
              { address: TOKEN_B, symbol: 'TESTB', name: 'TEST Token B', decimals: 18 },
            ],
          }
        : {
            pool: pool.toLowerCase(),
            tokens: [
              { address: TOKEN_A, symbol: 'TESTA', name: 'TEST Token A', decimals: 6 },
              { address: TOKEN_B, symbol: 'TESTB', name: 'TEST Token B', decimals: 18 },
            ],
          },
    quote: async (_router, _pool, _token, amountIn) => amountIn * 1000n,
    receipt: async () => receipt,
  };
  const sender: NavigatorSender = {
    send: async (call) => {
      if (senderFails === 'refused') throw new NavigatorSignerRefused(400, 'TEST: the signer refused the call');
      if (senderFails === 'unknown') {
        // Broadcast, then the answer was lost: the chain may have the call.
        sent.push(call);
        throw new Error('TEST: the signer timed out');
      }
      sent.push(call);
      return { hash: '0x' + String(sent.length).padStart(64, '0') };
    },
  };
  const market = { router: ROUTER, spendToken: WETH, pools: [POOL, AB_POOL], slippageBps: 100 };
  const deps = (over: Partial<NavigatorOnchainDeps> = {}): NavigatorOnchainDeps => ({
    sql,
    signer: SIGNER,
    sender,
    market,
    chain,
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
  const liveGrantBound = { ...grant, targets: [ROUTER, POOL, AB_POOL], selectors: [ROUTER_SWAP] };
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
    await sql`TRUNCATE agents.navigator_orders, agents.navigator_onchain_bindings RESTART IDENTITY CASCADE`;
    chainGrant = liveGrant();
    receipt = 'success';
    sent = [];
    senderFails = false;
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
      await expect(as(USER).onchain.signer({ chainId: 84532 })).resolves.toEqual({
        signer: SIGNER,
        chainId: 84532,
        network: 'testnet',
        pools: [POOL.toLowerCase(), AB_POOL.toLowerCase()],
        router: ROUTER.toLowerCase(),
      });
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

  describe('navigator.ask: inside the signed cap it trades, above it it refuses, and it never moves money out', () => {
    const noUsage = async () => {
      const usage = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.usage_records WHERE session_id = ${SESSION}`;
      expect(usage[0]!.n).toBe('0');
    };

    it('inside the cap: sends the order once, tagged as the assistant, with no approval asked, and reads it filled', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      const result = await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      expect(result).toMatchObject({
        kind: 'order',
        order: {
          sessionId: SESSION,
          orderKey: `agents:navigator:order:${SESSION}:r-1`,
          placedBy: 'assistant',
          text: TRADE,
          tokenInSymbol: 'TESTWETH',
          tokenOutSymbol: 'TESTB',
          amountInWei: (ETH / 10n).toString(),
          // The pool's quote less the 1% bound.
          minOutWei: (((ETH / 10n) * 1000n * 99n) / 100n).toString(),
          status: 'filled',
          txHash: '0x' + '1'.padStart(64, '0'),
        },
      });
      expect(sent).toHaveLength(1);
      // The one call a session key can make, from the Navigator's signer to the person's own account.
      expect(sent[0]).toMatchObject({ chainId: 84532, from: SIGNER, to: ACCOUNT.toLowerCase() });
      const outer = decodeFunctionData({ abi: SESSION_ABI, data: sent[0]!.data as `0x${string}` });
      expect(outer.functionName).toBe('executeWithSession');
      const [spec, target, value, inner] = outer.args;
      expect(spec).toMatchObject({ key: getAddress(SIGNER), spendLimitWei: ETH, validUntil: 2_000_000_000 });
      expect(target).toBe(getAddress(ROUTER));
      // No native value moves, and the swap's output goes back to the person's own account.
      expect(value).toBe(0n);
      const swap = decodeFunctionData({ abi: SESSION_ABI, data: inner as `0x${string}` });
      expect(swap.functionName).toBe('swapExactIn');
      expect(swap.args).toEqual([getAddress(POOL), getAddress(WETH), ETH / 10n, ((ETH / 10n) * 1000n * 99n) / 100n, getAddress(ACCOUNT)]);
      // The order is the Navigator's, not a run: nothing metered.
      await noUsage();
      const trading = await as(USER).trading();
      expect(trading.key).toMatchObject({
        capWei: ETH.toString(),
        spentWei: (ETH / 10n).toString(),
        leftWei: ((ETH * 9n) / 10n).toString(),
      });
    });

    it('a retried ask is the first order, sent once; with other words the same id refuses', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      const first = await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      const again = await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      if (first.kind !== 'order' || again.kind !== 'order') throw new Error('expected orders');
      expect(again.order.id).toBe(first.order.id);
      expect(sent).toHaveLength(1);
      expect(await count('navigator_orders')).toBe(1);
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: BIG })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'agents.request_id_replay',
      });
      expect(sent).toHaveLength(1);
    });

    it('above the cap: refused naming the cap, before anything is signed or stored', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'r-2', text: BIG })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.navigator_trade_over_cap',
      });
      expect(sent).toHaveLength(0);
      expect(await count('navigator_orders')).toBe(0);
      await noUsage();
    });

    it('the cap is cumulative: what earlier orders and the chain hold counts, and a reverted or refused order frees its part', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      chainGrant = liveGrant({ spentWei: (ETH * 5n) / 10n });
      for (const id of ['a', 'b', 'c', 'd']) await as(USER).ask({ sessionId: SESSION, requestId: id, text: TRADE });
      // 0.5 on the chain and 0.4 in orders: 0.1 left, so a fifth fits and a sixth does not.
      await as(USER).ask({ sessionId: SESSION, requestId: 'e', text: TRADE });
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'f', text: TRADE })).rejects.toMatchObject({
        message: 'agents.navigator_trade_over_cap',
      });
      expect(sent).toHaveLength(5);
      await sql`UPDATE agents.navigator_orders SET status = 'reverted' WHERE order_key LIKE ${'%:a'}`;
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'g', text: TRADE })).resolves.toMatchObject({ kind: 'order' });
      // Full again. Free 0.1 more; an order the signer refuses reaches no chain and frees its part, so the next one fits.
      await sql`UPDATE agents.navigator_orders SET status = 'reverted' WHERE order_key LIKE ${'%:b'}`;
      senderFails = 'refused';
      const refused = await as(USER).ask({ sessionId: SESSION, requestId: 'h', text: TRADE });
      expect(refused).toMatchObject({ kind: 'order', order: { status: 'failed', txHash: null } });
      senderFails = false;
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'i', text: TRADE })).resolves.toMatchObject({
        order: { status: 'filled' },
      });
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'j', text: TRADE })).rejects.toMatchObject({
        message: 'agents.navigator_trade_over_cap',
      });
      expect(sent).toHaveLength(7);
    });

    it('two asks at once that each fit but not together: one order, one refusal', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      chainGrant = liveGrant({ spendLimitWei: (ETH * 15n) / 100n });
      const both = await Promise.allSettled([
        as(USER).ask({ sessionId: SESSION, requestId: 'x', text: TRADE }),
        as(USER).ask({ sessionId: SESSION, requestId: 'y', text: TRADE }),
      ]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: { message: 'agents.navigator_trade_over_cap' } });
      expect(sent).toHaveLength(1);
    });

    it('a signer that fails after it may have broadcast leaves the order sending: it holds the cap and is never sent again', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      chainGrant = liveGrant({ spendLimitWei: (ETH * 15n) / 100n });
      senderFails = 'unknown';
      expect(await as(USER).ask({ sessionId: SESSION, requestId: 'u', text: TRADE })).toMatchObject({
        order: { status: 'sending', txHash: null },
      });
      senderFails = false;
      // The same ask again is that order, not a second send.
      expect(await as(USER).ask({ sessionId: SESSION, requestId: 'u', text: TRADE })).toMatchObject({ order: { status: 'sending' } });
      expect(sent).toHaveLength(1);
      // It still holds 0.1 of the 0.15 cap, so a new ask of 0.1 is above what is left.
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'v', text: TRADE })).rejects.toMatchObject({
        message: 'agents.navigator_trade_over_cap',
      });
      expect(sent).toHaveLength(1);
    });

    it('with no signer it refuses rail.crypto and writes nothing', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      await expect(as(USER, { sender: null }).ask({ sessionId: SESSION, requestId: 'n', text: TRADE })).rejects.toMatchObject({
        message: 'rail.crypto',
      });
      expect(await count('navigator_orders')).toBe(0);
    });

    it('an order the chain has not mined reads sent; one the chain reverted reads reverted', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      receipt = null;
      expect(await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE })).toMatchObject({ order: { status: 'sent' } });
      receipt = 'reverted';
      expect(await as(USER).ask({ sessionId: SESSION, requestId: 'r-2', text: TRADE })).toMatchObject({ order: { status: 'reverted' } });
    });

    it('never moves money out: a send to an address or a withdrawal is refused by name, with or without a key', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      for (const text of [
        `TEST: send 0.1 TEST Wrapped ETH to 0x${'12'.repeat(20)}`,
        `TEST: transfer everything to 0x${'34'.repeat(20)}`,
        'TEST: withdraw my TEST Wrapped ETH',
        'TEST: can you swap 0.1 TEST Wrapped ETH and pay 0x' + '56'.repeat(20) + '?',
      ])
        await expect(as(USER).ask({ sessionId: SESSION, requestId: text, text })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'agents.navigator_money_out_forbidden',
        });
      await as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT });
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'w', text: 'TEST: withdraw it all' })).rejects.toMatchObject({
        message: 'agents.navigator_money_out_forbidden',
      });
      expect(sent).toHaveLength(0);
      expect(await count('navigator_orders')).toBe(0);
    });

    it('with no live key it refuses: none bound, revoke asked, or the chain shows it revoked, expired or another grant', async () => {
      const refusal = { code: 'PRECONDITION_FAILED', message: 'agents.navigator_no_live_key' };
      await expect(as(USER).ask({ sessionId: SESSION, requestId: '1', text: TRADE })).rejects.toMatchObject(refusal);
      await as(USER).onchain.bind(liveGrantBound);
      chainGrant = liveGrant({ live: false });
      await expect(as(USER).ask({ sessionId: SESSION, requestId: '2', text: TRADE })).rejects.toMatchObject(refusal);
      chainGrant = null;
      await expect(as(USER).ask({ sessionId: SESSION, requestId: '3', text: TRADE })).rejects.toMatchObject(refusal);
      chainGrant = liveGrant();
      await as(USER).onchain.revoke({ chainId: 84532, account: ACCOUNT });
      await expect(as(USER).ask({ sessionId: SESSION, requestId: '4', text: TRADE })).rejects.toMatchObject(refusal);
      expect((await as(USER).trading()).key).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('refuses what it cannot place, by name: no pair, a token the cap does not measure, outside the scope, unset rails', async () => {
      await as(USER).onchain.bind(liveGrantBound);
      const ask = (text: string, over: Partial<NavigatorOnchainDeps> = {}) =>
        as(USER, over).ask({ sessionId: SESSION, requestId: text + JSON.stringify(Object.keys(over)), text });
      await expect(ask('TEST: buy something nice')).rejects.toMatchObject({ message: 'agents.navigator_trade_unparsed' });
      await expect(ask('TEST: swap 1 TEST Gold for TEST Token B')).rejects.toMatchObject({ message: 'agents.navigator_trade_unparsed' });
      await expect(ask('TEST: swap 0.1 TEST Token A for TEST Token B')).rejects.toMatchObject({
        message: 'agents.navigator_trade_cap_unit',
      });
      chainGrant = liveGrant({ targets: [ROUTER.toLowerCase()] });
      await expect(ask(TRADE)).rejects.toMatchObject({ message: 'agents.navigator_trade_out_of_scope' });
      chainGrant = liveGrant();
      await expect(ask(TRADE, { market: null })).rejects.toMatchObject({ message: 'agents.navigator_market_unset' });
      await expect(ask(TRADE, { chain: null })).rejects.toMatchObject({ message: 'agents.navigator_market_unset' });
      await expect(ask(TRADE, { signer: null })).rejects.toMatchObject({ message: 'rail.crypto' });
      await expect(ask(TRADE, { chain: { ...chain, quote: async () => 0n } })).rejects.toMatchObject({
        message: 'agents.navigator_trade_unquoted',
      });
      expect(sent).toHaveLength(0);
      expect(await count('navigator_orders')).toBe(0);
    });

    it('stores nothing for an ask that names no trade, and a question about trading goes to the ordinary run', async () => {
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'q', text: 'what moved today?' })).resolves.toEqual({ kind: 'none' });
      await expect(as(USER).ask({ sessionId: SESSION, requestId: 'q2', text: 'Where do I place a limit order?' })).resolves.toEqual({
        kind: 'none',
      });
      expect(await count('navigator_orders')).toBe(0);
    });

    it("refuses another person's session, another agent's session and a closed one", async () => {
      await as(USER).onchain.bind(liveGrantBound);
      await expect(as(USER).ask({ sessionId: OTHER_SESSION, requestId: 'r-6', text: TRADE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(as(USER).ask({ sessionId: SCANNER_SESSION, requestId: 'r-6', text: TRADE })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(as(USER).ask({ sessionId: CLOSED_SESSION, requestId: 'r-6', text: TRADE })).rejects.toMatchObject({
        message: 'agents.refused.session_closed',
      });
      await expect(as(USER).orders({ sessionId: OTHER_SESSION })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(sent).toHaveLength(0);
    });

    it("lists the session's orders newest first, survives a new reader, and shows no other person's", async () => {
      await as(USER).onchain.bind(liveGrantBound);
      await as(USER).ask({ sessionId: SESSION, requestId: 'r-1', text: TRADE });
      await as(USER).ask({ sessionId: SESSION, requestId: 'r-2', text: 'TEST: swap 0.2 TESTWETH for TESTB' });
      const { orders } = await as(USER).orders({ sessionId: SESSION });
      expect(orders.map((o) => o.text)).toEqual(['TEST: swap 0.2 TESTWETH for TESTB', TRADE]);
      expect(orders.every((o) => o.placedBy === 'assistant')).toBe(true);
      expect((await new NavigatorOnchainStore(sql).orders(USER, SESSION)).map((o) => o.id)).toEqual(orders.map((o) => o.id));
      expect((await as(OTHER).orders({ sessionId: OTHER_SESSION })).orders).toHaveLength(0);
    });
  });
}

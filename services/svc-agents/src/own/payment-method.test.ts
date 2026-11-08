import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type LinkedWallets } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, userAvailable, type Amount } from '@intafaced/ledger-client';
import type { ChainBalancePort, WalletBalanceReading } from '../chain-balance.js';
import { FundsUnreadError } from '../funds.js';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { usageCost } from '../metering/pricing.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime, estimateInputTokens } from '../runtime.js';
import { keyCases, SECRET as S2S_SECRET } from '../s2s-keys-fixture.js';
import { UserSpendStore } from '../spend/store.js';
import { createIdentityLinkedWallets, paymentMethodFunds, type LinkedWalletsPort } from './payment-method.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * A wallet as the payment method of a person's own agent (J-agents-02 #4), through the service's own routes on real
 * Postgres: choosing checks identity's list of linked wallets; a run reads the wallet's balance from the chain before
 * the engine is called; a figure below the worst case refuses naming the wallet, the figure, its chain and block and
 * its time; a figure that cannot be read refuses saying why. On either refusal the engine is never called, nothing is
 * held and nothing is billed. Identity and the chain are stand-ins here; the ledger is the in-memory one.
 */

const LINKED = '0x00000000000000000000000000000000000a11ce';
const OTHER_WALLET = '0x00000000000000000000000000000000000b0b00';

describe('identity linked-wallets client', () => {
  keyCases('POST /internal/linked-wallets', 'svc-identity', async (fetchImpl, s2s) => {
    await createIdentityLinkedWallets('http://identity.test', S2S_SECRET, s2s, fetchImpl).read('11111111-1111-4111-8111-111111111111');
  });

  const answering = (status: number, body: unknown) =>
    (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  const USER_ID = '11111111-1111-4111-8111-111111111111';

  it('returns identity’s answer, parsed', async () => {
    const answer = { state: 'usable', wallets: [{ address: LINKED, linkedAt: '2026-11-09T00:00:00.000Z' }] };
    expect(await createIdentityLinkedWallets('http://identity.test/', S2S_SECRET, undefined, answering(200, answer)).read(USER_ID)).toEqual(
      answer,
    );
  });

  it.each([
    ['a refusal', answering(403, { code: 'identity.linked_wallet_reader_refused' })],
    ['an unreadable body', answering(200, 'not json')],
    ['a body of another shape', answering(200, { state: 'usable', wallets: [{ address: 'nope' }] })],
    [
      'a network fault',
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    ],
  ])('%s reads as null, never as "no wallet"', async (_label, fetchImpl) => {
    expect(await createIdentityLinkedWallets('http://identity.test', S2S_SECRET, undefined, fetchImpl).read(USER_ID)).toBeNull();
  });
});

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'an-agents-payment-method-test-secret-of-32-plus!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const PERSON = ['agents:read', 'agents:execute', 'identity:write'];

function callerFor(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: PERSON,
    tier: 'none',
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
    id: 'req-own-payment-method',
  });
}

const TABLE = parseRoutingTable({
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
const ASK = 'TEST question';
const INSTRUCTIONS = 'Answer TEST questions.';
const WORST: Amount = usageCost(
  { inputTokens: estimateInputTokens(INSTRUCTIONS, [{ content: ASK }]), outputTokens: 2048 },
  TABLE.routes[0]!.price!,
);
const AS_OF = '2026-11-09T00:00:00.000Z';

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent payment method (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-payment-method-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  /** Identity's answer, as the stand-in gives it; null is identity unreachable. */
  let linked: LinkedWallets | null;
  let identityAsks: number;
  /** The chain's answer for a wallet: its figure, or the fault the read throws. */
  let chainAnswer: Amount | FundsUnreadError;
  let chainReads: string[];
  let chainSet: boolean;
  let ledgerBalance: Amount;
  let ledgerReads: number;
  let calls: number;
  let ledger: MemoryLedger;

  const wallets: LinkedWalletsPort = {
    async read() {
      identityAsks += 1;
      return linked;
    },
  };
  const chain: ChainBalancePort = {
    async read(address): Promise<WalletBalanceReading> {
      chainReads.push(address);
      if (chainAnswer instanceof FundsUnreadError) throw chainAnswer;
      return {
        kind: 'wallet',
        available: chainAnswer,
        token: 'TESTUSD',
        method: { kind: 'wallet', address },
        source: { kind: 'chain', chainId: 84532, block: 777n },
        asOf: AS_OF,
      };
    },
  };

  function build({ spendGate = true }: { spendGate?: boolean } = {}) {
    const provider = new MockModelProvider({ id: 'primary' });
    const inner = new ModelGateway([provider], TABLE);
    const gateway = Object.create(inner) as ModelGateway;
    gateway.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      calls += 1;
      return inner.complete(task, request);
    };
    const meter = new UsageMeter(sql, ledger, { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      ...(spendGate ? { spend: new UserSpendStore(sql) } : {}),
      // With the payment token blank the service wires no chain reader at all (index.ts); `chainSet = false` mirrors it.
      funds: paymentMethodFunds({
        sql,
        ledger: async () => {
          ledgerReads += 1;
          return ledgerBalance;
        },
        wallets,
        chain: chainSet ? chain : null,
      }),
    });
    return createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql, ownLinkedWallets: wallets });
  }

  const person = (opts?: { spendGate?: boolean }) => build(opts).createCaller(callerFor(USER));
  const other = () => build().createCaller(callerFor(OTHER));

  async function agentWithLimits(caller: ReturnType<typeof person>) {
    const { id } = await caller.own.create({ template: 'service-starter', createKey: `pm:${Math.random()}` });
    await caller.own.save({ id, name: 'TEST helper', instructions: INSTRUCTIONS, tools: ['support.kb.search'], perSessionCap: '1' });
    await caller.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
    return id;
  }

  const holds = async () =>
    (await sql<{ status: string }[]>`SELECT status FROM agents.spend_reservations WHERE user_id = ${USER}`).map((r) => r.status);
  const usageRows = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.usage_records`)[0]!.n;
  const stored = async (id: string) => sql`SELECT kind, address FROM agents.own_agent_payment_methods WHERE agent_id = ${id}`;

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
      TRUNCATE agents.own_agent_payment_methods, agents.own_agent_background_runs, agents.own_agent_surfaces, agents.own_agent_versions,
               agents.own_agent_co_owners, agents.own_agent_session_versions, agents.own_agent_limits, agents.own_agents,
               agents.spend_reservations, agents.user_spend_limits, agents.think_claims, agents.usage_records,
               agents.usage_windows, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    linked = { state: 'usable', wallets: [{ address: LINKED, linkedAt: AS_OF }] };
    identityAsks = 0;
    chainAnswer = 0n;
    chainReads = [];
    chainSet = true;
    // The platform balance would cover the run many times over: a wallet refusal can only come from the wallet.
    ledgerBalance = 100n * 10n ** 18n;
    ledgerReads = 0;
    calls = 0;
    ledger = new MemoryLedger();
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('choosing the payment method (own.paymentMethod)', () => {
    it('shows no method and the person’s linked wallets; identity unreachable reads unread, not "no wallet"', async () => {
      const caller = person();
      const id = await agentWithLimits(caller);
      expect(await caller.own.paymentMethod.get({ id })).toEqual({
        method: null,
        linked: { state: 'usable', wallets: [{ address: LINKED, linkedAt: AS_OF }] },
      });
      linked = null;
      expect(await caller.own.paymentMethod.get({ id })).toEqual({ method: null, linked: { state: 'unread' } });
    });

    it('chooses a linked wallet, checked through identity now, stored lower-case; clearing removes it', async () => {
      const caller = person();
      const id = await agentWithLimits(caller);
      const chosen = await caller.own.paymentMethod.set({ id, address: LINKED.toUpperCase().replace('0X', '0x') });
      expect(chosen.method).toEqual({ kind: 'wallet', address: LINKED, chosenAt: expect.any(String) });
      expect(identityAsks).toBeGreaterThan(0);
      expect(await stored(id)).toEqual([{ kind: 'wallet', address: LINKED }]);
      expect((await caller.own.paymentMethod.set({ id, address: null })).method).toBeNull();
      expect(await stored(id)).toEqual([]);
    });

    it.each([
      ['a wallet the person did not link', () => undefined, OTHER_WALLET, 'agents.payment_method.wallet_not_linked'],
      [
        'an account identity says may not use its wallets',
        () => {
          linked = { state: 'account_inactive' };
        },
        LINKED,
        'agents.payment_method.account_inactive',
      ],
      [
        'identity unreachable',
        () => {
          linked = null;
        },
        LINKED,
        'agents.payment_method.wallets_unread',
      ],
    ])('refuses %s and stores nothing', async (_label, arrange, address, code) => {
      const caller = person();
      const id = await agentWithLimits(caller);
      arrange();
      await expect(caller.own.paymentMethod.set({ id, address })).rejects.toMatchObject({ message: code });
      expect(await stored(id)).toEqual([]);
    });

    it('another person’s agent reads and writes as not found', async () => {
      const id = await agentWithLimits(person());
      await expect(other().own.paymentMethod.get({ id })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other().own.paymentMethod.set({ id, address: LINKED })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      expect(await stored(id)).toEqual([]);
    });
  });

  describe('a run against the wallet (J-agents-02 #4)', () => {
    async function withWallet(opts?: { spendGate?: boolean }) {
      const caller = person(opts);
      const id = await agentWithLimits(caller);
      await caller.own.paymentMethod.set({ id, address: LINKED });
      const { sessionId } = await caller.own.session.open({ id });
      return { caller, id, sessionId };
    }

    it.each([
      ['under the spend gate', true],
      ['without a spend gate', false],
    ])(
      '%s: a figure below the worst case refuses naming the wallet, the figure, chain, block and time; engine never called, nothing held or billed',
      async (_label, spendGate) => {
        chainAnswer = WORST - 1n;
        const { caller, id, sessionId } = await withWallet({ spendGate });
        const before = await ledger.balance(userAvailable(USER, 'USDT'));
        await expect(caller.own.run({ id, sessionId, requestId: 'pm-poor-run', ask: ASK })).rejects.toMatchObject({
          message: 'agents.funds_insufficient',
        });
        expect(calls).toBe(0);
        expect(chainReads).toEqual([LINKED]);
        expect(ledgerReads).toBe(0);
        expect(await holds()).toEqual([]);
        expect(await usageRows()).toBe(0);
        expect(await ledger.balance(userAvailable(USER, 'USDT'))).toEqual(before);
        const [row] = await caller.own.runs({ id, limit: 10 });
        expect(row).toMatchObject({ status: 'refused', refusalCode: 'agents.funds_insufficient', cost: '0' });
        expect(row!.messageParams).toEqual({
          worstCase: formatAmount(WORST),
          asset: 'USDT',
          method: 'wallet',
          address: LINKED,
          available: formatAmount(WORST - 1n),
          token: 'TESTUSD',
          source: 'chain',
          chainId: 84532,
          block: '777',
          asOf: AS_OF,
        });
      },
    );

    it('a wallet that covers the worst case runs, though only the wallet was read', async () => {
      chainAnswer = WORST;
      ledgerBalance = 0n;
      const { caller, id, sessionId } = await withWallet();
      const ran = await caller.own.run({ id, sessionId, requestId: 'pm-ok-run', ask: ASK });
      expect(ran.text.length).toBeGreaterThan(0);
      expect(calls).toBe(1);
      expect(ledgerReads).toBe(0);
    });

    it.each([
      [
        'the chain cannot be reached',
        () => {
          chainAnswer = new FundsUnreadError({ kind: 'wallet', address: LINKED }, 'chain_unreachable');
        },
        'chain_unreachable',
      ],
      [
        'the wallet was unlinked since it was chosen',
        () => {
          linked = { state: 'usable', wallets: [] };
        },
        'wallet_unlinked',
      ],
      [
        'the account may not use its wallets now',
        () => {
          linked = { state: 'account_inactive' };
        },
        'account_inactive',
      ],
      [
        'identity cannot be asked',
        () => {
          linked = null;
        },
        'identity_unreachable',
      ],
      [
        'the payment token is unset',
        () => {
          chainSet = false;
        },
        'payment_token_unset',
      ],
    ])('%s: the run does not start and says why; engine never called, nothing held or billed', async (_label, arrange, reason) => {
      const { id, sessionId } = await withWallet();
      arrange();
      // Rebuilt after arranging, so a blank token wires no chain reader, as the service does.
      const caller = person();
      await expect(caller.own.run({ id, sessionId, requestId: `pm-unread-${reason}`, ask: ASK })).rejects.toMatchObject({
        message: 'agents.funds_unread',
      });
      expect(calls).toBe(0);
      expect(ledgerReads).toBe(0);
      expect(await holds()).toEqual([]);
      expect(await usageRows()).toBe(0);
      if (reason !== 'chain_unreachable') expect(chainReads).toEqual([]);
      const [row] = await caller.own.runs({ id, limit: 10 });
      expect(row).toMatchObject({ status: 'refused', refusalCode: 'agents.funds_unread', cost: '0' });
      expect(row!.messageParams).toEqual({ worstCase: formatAmount(WORST), asset: 'USDT', method: 'wallet', address: LINKED, reason });
    });

    it('with no method chosen the platform balance is read exactly as before, and its refusal keeps today’s params', async () => {
      ledgerBalance = WORST - 1n;
      const caller = person();
      const id = await agentWithLimits(caller);
      const { sessionId } = await caller.own.session.open({ id });
      await expect(caller.own.run({ id, sessionId, requestId: 'pm-ledger-run', ask: ASK })).rejects.toMatchObject({
        message: 'agents.funds_insufficient',
      });
      expect(chainReads).toEqual([]);
      expect(identityAsks).toBe(0);
      expect(ledgerReads).toBe(1);
      expect(calls).toBe(0);
      const [row] = await caller.own.runs({ id, limit: 10 });
      expect(row!.messageParams).toEqual({ worstCase: formatAmount(WORST), asset: 'USDT' });
    });
  });
}

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, houseFees, userAvailable } from '@intafaced/ledger-client';
import { ModelGateway } from './gateway/gateway.js';
import { parseRoutingTable, unpricedTable, type RoutingTable } from './gateway/routing.js';
import { UsageMeter, chargeKeyFor } from './metering/meter.js';
import { usageCost, windowCost } from './metering/pricing.js';
import { MockModelProvider, mockUsage } from './providers/mock.js';
import type { CompletionRequest } from './providers/provider.js';
import { ProviderError, AgentError } from './errors.js';
import { AgentRuntime, RefusedError, estimateInputTokens } from './runtime.js';
import type { SpendGate } from './spend/gate.js';
import { UserSpendStore } from './spend/store.js';
import { hashAction } from './fleet/audit.js';
import { createAgentsRouter } from './router.js';
import type { AgentsRouterDeps } from './router.js';
import { actionsCsv, logReadKey, purgeExpiredTranscripts, type OpsLogSettings } from './oplog/routes.js';

/**
 * svc-agents — the fleet runtime end to end.
 *
 * The ledger is `MemoryLedger`, the reference implementation the conformance
 * suite proves equivalent to svc-ledger's Postgres engine (§4.4). The provider
 * is the deterministic mock, so a test can compute the expected bill
 * independently rather than asserting against whatever the code produced.
 *
 * Postgres is real, because every property worth testing here — append-only,
 * the window seal, the unique request id — lives in the database, and a fake
 * would test the fake.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/**
 * The test routing table.
 *
 * Model values are ALIASES, exactly as they are in the shipped default: the
 * adapter maps them to whatever a deployment has contracted for. Prices are
 * chosen to be exact at these token counts so an assertion reads as arithmetic
 * rather than as a magic constant.
 */
const TABLE: RoutingTable = parseRoutingTable({
  routes: [
    {
      task: 'plan',
      providerId: 'primary',
      model: 'reasoning-lg',
      maxOutputTokens: 256,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'quick',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 64,
      price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
    },
    {
      task: 'vectors',
      providerId: 'primary',
      model: 'embed-sm',
      maxOutputTokens: 1,
      price: { inputPerMillion: '0.1', outputPerMillion: '0' },
      capability: 'embed',
    },
    {
      task: 'orphan',
      providerId: 'nowhere',
      model: 'reasoning-lg',
      maxOutputTokens: 16,
      price: { inputPerMillion: '1', outputPerMillion: '1' },
    },
  ],
});

const PROBE = {
  agentId: 'probe',
  version: 1,
  capacityMode: 'confirm_each',
  tools: [
    { name: 'trade.quote', module: 'trade', mode: 'read' },
    { name: 'trade.order', module: 'trade', mode: 'write', maxCallsPerSession: 1, requiresApproval: true },
  ],
  limits: {
    maxActionsPerSession: 20,
    maxOutputTokensPerCall: 256,
    maxSpendPerSession: null,
    allowedModules: ['trade'],
    allowedTasks: ['plan', 'quick', 'orphan'],
  },
};

/** Same agent, with a spend ceiling low enough that one call cannot fit under it. */
const THRIFTY = {
  ...PROBE,
  agentId: 'thrifty',
  limits: { ...PROBE.limits, maxSpendPerSession: '0.000000000000000001' },
};

/**
 * The Postgres probe comes from `@intafaced/db` on purpose.
 *
 * This file used to open its own two-line `reachable()`. That helper swallowed
 * every error and returned `false` regardless of `CI` or `REQUIRE_POSTGRES=1`,
 * so on CI — where an unreachable database is supposed to be a hard failure —
 * this money suite would have skipped in silence and been counted as a pass.
 * Five suites carried the same private probe and the same hole.
 *
 * `postgresAvailable` is the one probe that honours `postgresRequired()`, and it
 * journals its decision so `pnpm verify` can name what did not run instead of
 * letting turbo's "N successful" imply that everything did.
 * (`tooling/ci/skip-honesty-scan.mjs` fails a build that re-adds a private probe.)
 */
const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-agents (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 8,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-test' },
    onnotice: () => undefined,
  });

  // Owns its database, or does not run. Must precede the first migration.
  await assertTestDatabase(sql, 'svc-agents');

  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let provider: MockModelProvider;
  let gateway: ModelGateway;
  let meter: UsageMeter;
  let runtime: AgentRuntime;

  const MESSAGES = [{ role: 'user' as const, content: 'Where do I stake?' }];

  /** The exact usage the mock will report for a task, computed independently. */
  function expectedUsage(task: string, messages = MESSAGES, maxOutputTokens?: number) {
    const route = TABLE.routes.find((r) => r.task === task)!;
    const request = {
      model: route.model,
      messages,
      maxOutputTokens: maxOutputTokens === undefined ? route.maxOutputTokens : Math.min(maxOutputTokens, route.maxOutputTokens),
    } as CompletionRequest;
    return { route, usage: mockUsage(request) };
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId: 'IFC', amount: amt(amount), rail: 'test', railRef: `${userId}:${amount}:${Math.random()}` }),
    );
  }

  const balanceOf = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'IFC'))).amount);
  const houseOf = async () => formatAmount((await ledger.balance(houseFees('agents', 'IFC'))).amount);

  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

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
      TRUNCATE agents.spend_reservations, agents.spend_limit_requests, agents.user_spend_limits, agents.think_claims, agents.agent_place_intents, agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions, agents.agent_definitions
      RESTART IDENTITY CASCADE
    `;

    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-agents');
    provider = new MockModelProvider({ id: 'primary' });
    gateway = new ModelGateway([provider], TABLE);
    meter = new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 });
    runtime = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });

    await runtime.registerAgent(PROBE);
    await runtime.registerAgent(THRIFTY);
    await fund(USER_A, '1000');
    await fund(USER_B, '1000');
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const open = (userId = USER_A, agentId = 'probe') => runtime.openSession({ userId, agentId });

  /**
   * Hold `gateway.complete` so two thinks overlap.
   *
   * `first` releases only the first entry, so a same-id replay that still
   * reaches the provider returns while the winner is inside the call.
   * `both` waits until two entries have started, then releases them together.
   */
  function gateComplete(inner: ModelGateway, mode: 'first' | 'both') {
    let entered = 0;
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const wrapped = Object.create(inner) as ModelGateway;
    wrapped.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      entered += 1;
      if (mode === 'first') {
        if (entered === 1) {
          markReady();
          await hold;
        }
      } else if (entered >= 2) {
        markReady();
        await hold;
      } else {
        await hold;
      }
      return inner.complete(task, request);
    };
    return {
      gateway: wrapped,
      entered: () => entered,
      release: () => releaseHold(),
      ready,
    };
  }

  function meteredRuntime(gw: ModelGateway) {
    return new AgentRuntime(sql, gw, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  describe('per-task model routing (§8.2)', () => {
    it('serves each task on the model its route configures', async () => {
      const session = await open();

      const plan = await runtime.think({ sessionId: session.id, requestId: 'r-plan', task: 'plan', messages: MESSAGES });
      const quick = await runtime.think({ sessionId: session.id, requestId: 'r-quick', task: 'quick', messages: MESSAGES });

      expect(plan.route.model).toBe('reasoning-lg');
      expect(quick.route.model).toBe('fast-sm');

      // The provider echoes the model it was asked for, so this asserts the
      // routing decision actually reached the adapter rather than being
      // recorded and then ignored.
      expect(plan.text).toContain('reasoning-lg');
      expect(quick.text).toContain('fast-sm');

      // And the audit row records the ALIAS, not a vendor's model id.
      expect(plan.action.model).toBe('reasoning-lg');
    });

    it('applies the route’s output ceiling, and lets a caller ask for less but not more', async () => {
      const session = await open();

      const capped = await runtime.think({
        sessionId: session.id,
        requestId: 'r-capped',
        task: 'quick',
        messages: MESSAGES,
        maxOutputTokens: 4096,
      });
      // 'quick' is configured at 64; asking for 4096 is clamped, not honoured.
      expect(capped.usage.outputTokens).toBeLessThanOrEqual(64);
      expect(capped.usage).toEqual(expectedUsage('quick').usage);

      const tighter = await runtime.think({
        sessionId: session.id,
        requestId: 'r-tight',
        task: 'quick',
        messages: MESSAGES,
        maxOutputTokens: 8,
      });
      expect(tighter.usage.outputTokens).toBeLessThanOrEqual(8);
    });

    it('is data, not code — swapping the table re-routes without touching a caller', async () => {
      const session = await open();
      const before = await runtime.think({ sessionId: session.id, requestId: 'r-1', task: 'plan', messages: MESSAGES });
      expect(before.route.model).toBe('reasoning-lg');

      gateway.setRoutingTable(
        parseRoutingTable({
          routes: [
            {
              task: 'plan',
              providerId: 'primary',
              model: 'fast-sm',
              maxOutputTokens: 32,
              price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
            },
          ],
        }),
      );

      const after = await runtime.think({ sessionId: session.id, requestId: 'r-2', task: 'plan', messages: MESSAGES });
      expect(after.route.model).toBe('fast-sm');
      expect(after.text).toContain('fast-sm');
    });

    it('refuses an unrouted task, and logs the attempt rather than swallowing it', async () => {
      const session = await open();

      await expect(
        runtime.think({ sessionId: session.id, requestId: 'r-nope', task: 'does.not.exist', messages: MESSAGES }),
      ).rejects.toMatchObject({ code: 'agents.route_not_found' });

      const log = await runtime.sessionLog(session.id, 500);
      expect(log.at(-1)).toMatchObject({ kind: 'completion', status: 'failed', task: 'does.not.exist' });
    });

    it('refuses a route whose provider is not registered', async () => {
      const session = await open();
      await expect(
        runtime.think({ sessionId: session.id, requestId: 'r-orphan', task: 'orphan', messages: MESSAGES }),
      ).rejects.toMatchObject({ code: 'agents.route_not_found' });
    });
  });

  // ── Metering ──────────────────────────────────────────────────────────────

  describe('metering (§8.2 — token/cost per user, billed via ledger)', () => {
    it('charges exactly the priced cost of the window, and the books close', async () => {
      const session = await open();
      const { route, usage } = expectedUsage('plan');

      const result = await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      expect(result.usage).toEqual(usage);
      expect(result.metered).toBe(true);

      const expected = windowCost([
        { inputTokens: BigInt(usage.inputTokens), outputTokens: BigInt(usage.outputTokens), price: route.price! },
      ]);
      expect(expected).toBeGreaterThan(0n);

      const settlement = await runtime.settleWindow(session.id, result.windowId!);

      expect(settlement.amount).toBe(expected);
      expect(settlement.chargeKey).toBe(chargeKeyFor(session.id, result.windowId!));
      expect(await houseOf()).toBe(formatAmount(expected));
      expect(await balanceOf(USER_A)).toBe(formatAmount(amt('1000') - expected));

      // §0.6: value moved between accounts, none was created.
      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('sums token counts across calls and rounds once, not once per call', async () => {
      const session = await open();
      const a = await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      const b = await runtime.think({
        sessionId: session.id,
        requestId: 'r-b',
        task: 'plan',
        messages: [{ role: 'user', content: 'And how do I unstake?' }],
      });

      const price = a.route.price!;
      const expected = windowCost([
        {
          inputTokens: BigInt(a.usage.inputTokens + b.usage.inputTokens),
          outputTokens: BigInt(a.usage.outputTokens + b.usage.outputTokens),
          price,
        },
      ]);

      const settlement = await runtime.settleWindow(session.id, a.windowId!);
      expect(settlement.amount).toBe(expected);
      // Never more than the per-call sum: rounding once cannot cost more.
      expect(settlement.amount).toBeLessThanOrEqual(usageCost(a.usage, price) + usageCost(b.usage, price));
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('bills a completion exactly once and refuses a free request-id replay', async () => {
      const session = await open();

      const first = await runtime.think({ sessionId: session.id, requestId: 'retry-me', task: 'plan', messages: MESSAGES });
      expect(first.metered).toBe(true);
      expect(provider.callCount).toBe(1);

      // Reusing the request id must not re-enter the engine free of charge
      // (spend-cap bypass / unlimited unbilled inference).
      await expect(runtime.think({ sessionId: session.id, requestId: 'retry-me', task: 'plan', messages: MESSAGES })).rejects.toMatchObject(
        { code: 'agents.request_id_replay' },
      );
      expect(provider.callCount).toBe(1);

      const rows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(rows).toHaveLength(1);

      const settlement = await runtime.settleWindow(session.id, first.windowId!);
      expect(settlement.amount).toBe(usageCost(first.usage, first.route.price!));
      expect(await houseOf()).toBe(formatAmount(settlement.amount));
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('overlapping thinks with the same request id call the provider once and bill the real cost', async () => {
      const session = await open();
      const gate = gateComplete(gateway, 'first');
      const local = meteredRuntime(gate.gateway);
      const { route, usage } = expectedUsage('plan');
      const expected = usageCost(usage, route.price!);
      expect(expected).toBeGreaterThan(0n);

      const first = local.think({ sessionId: session.id, requestId: 'overlap-same', task: 'plan', messages: MESSAGES });
      await gate.ready;

      const second = local.think({ sessionId: session.id, requestId: 'overlap-same', task: 'plan', messages: MESSAGES });
      await expect(second).rejects.toMatchObject({ code: 'agents.request_id_replay' });
      expect(gate.entered()).toBe(1);

      gate.release();
      const winner = await first;
      expect(typeof winner.cost).toBe('bigint');
      expect(winner.cost).toBe(expected);
      expect(winner.metered).toBe(true);

      const rows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(rows).toHaveLength(1);
      const executed = (await local.sessionLog(session.id, 500)).filter((a) => a.kind === 'completion' && a.status === 'executed');
      expect(executed).toHaveLength(1);
      expect(executed[0]!.cost).toBe(expected);
    });

    it('settles a window exactly once, however many times settlement is run', async () => {
      const session = await open();
      const call = await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });

      const first = await runtime.settleWindow(session.id, call.windowId!);
      const second = await runtime.settleWindow(session.id, call.windowId!);
      const third = await runtime.settleWindow(session.id, call.windowId!);

      expect(first.settled).toBe(true);
      expect(second.settled).toBe(false);
      expect(third.settled).toBe(false);
      expect(second.amount).toBe(first.amount);

      expect(await houseOf()).toBe(formatAmount(first.amount));
      expect(ledger.journal()).toHaveLength(3); // two deposits + one fee charge
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('recovers a sealed-but-unbilled window on session settle (seal → post crash resume)', async () => {
      // Crash between seal and ledger post leaves sealed_at set, charge_tx_id
      // null, and a positive charged_amount. openWindows must still list that
      // window so settleSession / session.close can finish the feeCharge.
      const session = await open();
      const call = await runtime.think({ sessionId: session.id, requestId: 'r-orphan', task: 'plan', messages: MESSAGES });
      const windowId = call.windowId!;

      // Manually seal with a known positive amount and NO charge_tx_id — the
      // state a process death between seal and post produces.
      const expected = usageCost(call.usage, call.route.price!);
      expect(expected).toBeGreaterThan(0n);
      await sql`
        UPDATE agents.usage_windows
           SET sealed_at = now(),
               charged_amount = ${formatAmount(expected)}::numeric,
               charge_key = ${chargeKeyFor(session.id, windowId)},
               charge_tx_id = NULL
         WHERE session_id = ${session.id} AND window_id = ${windowId}
      `;

      // Before the fix, openWindows only selected sealed_at IS NULL and this
      // would return [] — house never paid, user never charged, invisible.
      const pending = await meter.openWindows(session.id);
      expect(pending).toContain(windowId);

      const settlements = await runtime.settleSession(session.id);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]!.windowId).toBe(windowId);
      expect(settlements[0]!.amount).toBe(expected);
      expect(settlements[0]!.settled).toBe(true);
      expect(settlements[0]!.chargeTxId).not.toBeNull();

      // Idempotent resume: second settle finds nothing left.
      expect(await meter.openWindows(session.id)).toEqual([]);
      const again = await runtime.settleSession(session.id);
      expect(again).toEqual([]);

      expect(await houseOf()).toBe(formatAmount(expected));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('posts under the business idempotency key §8.2 specifies', async () => {
      const session = await open();
      const call = await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      const settlement = await runtime.settleWindow(session.id, call.windowId!);

      const key = `agent.usage:${session.id}:${call.windowId}`;
      expect(settlement.chargeKey).toBe(key);

      // The ledger's own key namespaces it under the module, and re-posting it
      // returns the original transaction rather than a second charge.
      const existing = await ledger.getTxByKey(`fee:agents:${key}`);
      expect(existing).not.toBeNull();
      expect(existing!.id).toBe(settlement.chargeTxId);
    });

    it('seals the window: usage cannot land in a period that has been billed', async () => {
      const session = await open();
      const call = await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.settleWindow(session.id, call.windowId!);

      // Same window (the clock has not moved an hour), already settled.
      await expect(runtime.think({ sessionId: session.id, requestId: 'r-late', task: 'plan', messages: MESSAGES })).rejects.toMatchObject({
        code: 'agents.window_sealed',
      });

      // The house was not paid twice, and the attempt is in the log.
      expect(await houseOf()).toBe(formatAmount((await runtime.settleWindow(session.id, call.windowId!)).amount));
      const log = await runtime.sessionLog(session.id, 500);
      expect(log.some((a) => a.status === 'failed')).toBe(true);
    });

    it('charges nothing for a session on the included allowance', async () => {
      const session = await runtime.openSession({ userId: USER_A, agentId: 'probe', metered: false });
      const result = await runtime.think({ sessionId: session.id, requestId: 'r-free', task: 'plan', messages: MESSAGES });

      expect(result.metered).toBe(false);
      expect(result.windowId).toBeNull();
      expect(await runtime.settleSession(session.id)).toEqual([]);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
    });

    it('omitted meteringEnabled must not bill', async () => {
      // S11-2: `meteringEnabled ?? true` is the same fail-open as env default
      // true — a constructor that forgets the flag still feeCharges.
      const omitted = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC' });
      const session = await omitted.openSession({ userId: USER_A, agentId: 'probe' });
      const result = await omitted.think({
        sessionId: session.id,
        requestId: 'r-omit-flag',
        task: 'plan',
        messages: MESSAGES,
      });

      expect(result.metered).toBe(false);
      expect(result.windowId).toBeNull();
      expect(await omitted.settleSession(session.id)).toEqual([]);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
    });

    it('keeps the audit when billing is off, and never writes usage_records or a charge', async () => {
      const unbilled = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const session = await unbilled.openSession({ userId: USER_A, agentId: 'probe' });
      const result = await unbilled.think({ sessionId: session.id, requestId: 'r-off', task: 'plan', messages: MESSAGES });

      // Kill-switch: no bill window, no ledger post, no usage_records row.
      expect(result.metered).toBe(false);
      expect(result.windowId).toBeNull();
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      expect(await unbilled.settleSession(session.id)).toEqual([]);
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
      const windows = await sql`SELECT window_id FROM agents.usage_windows WHERE session_id = ${session.id}`;
      expect(windows).toHaveLength(0);

      // Audit still holds token counts — "what did the fleet cost while off".
      const log = await unbilled.sessionLog(session.id, 500);
      const completion = log.find((a) => a.kind === 'completion')!;
      expect(completion.inputTokens).toBe(BigInt(result.usage.inputTokens));
      expect(completion.outputTokens).toBe(BigInt(result.usage.outputTokens));
      expect(completion.cost).toBe(0n);
    });

    it('metering-off allows the same requestId twice and never invents request_id_replay', async () => {
      // Unit card done bar (#1434 residual): when billing is off, replaying a
      // request id must not pretend a charge existed.
      const unbilled = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const session = await unbilled.openSession({ userId: USER_A, agentId: 'probe' });
      const first = await unbilled.think({
        sessionId: session.id,
        requestId: 'r-off-replay',
        task: 'plan',
        messages: MESSAGES,
      });
      const second = await unbilled.think({
        sessionId: session.id,
        requestId: 'r-off-replay',
        task: 'plan',
        messages: MESSAGES,
      });
      expect(first.metered).toBe(false);
      expect(second.metered).toBe(false);
      expect(first.cost).toBe(0n);
      expect(second.cost).toBe(0n);
      expect(provider.callCount).toBe(2);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
    });

    it('metering-off settle refuses feeCharge for windows left from metering-on', async () => {
      // Kill-switch must halt bill posts, not only new usage_records. A process
      // that flipped AGENTS_METERING_ENABLED=false still sees leftover windows.
      const on = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });
      const session = await on.openSession({ userId: USER_A, agentId: 'probe' });
      const call = await on.think({ sessionId: session.id, requestId: 'r-then-off', task: 'plan', messages: MESSAGES });
      expect(call.metered).toBe(true);
      expect(call.windowId).not.toBeNull();

      const off = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const attempt = await off.settleWindow(session.id, call.windowId!);
      expect(attempt.settled).toBe(false);
      expect(attempt.amount).toBe(0n);
      expect(attempt.chargeTxId).toBeNull();
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');

      // Window remains open — when metering returns, settle can finish honestly.
      const stillOpen = await meter.openWindows(session.id);
      expect(stillOpen).toContain(call.windowId!);
    });

    it('metering-off settleSession also refuses feeCharge for leftover windows', async () => {
      // D26-P1-A6: admin/session.close settleSession must inherit the same gate.
      const on = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });
      const session = await on.openSession({ userId: USER_A, agentId: 'probe' });
      const call = await on.think({
        sessionId: session.id,
        requestId: 'r-then-off-session',
        task: 'plan',
        messages: MESSAGES,
      });
      expect(call.windowId).not.toBeNull();

      const off = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const results = await off.settleSession(session.id);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.settled).toBe(false);
        expect(r.amount).toBe(0n);
        expect(r.chargeTxId).toBeNull();
      }
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      expect(await meter.openWindows(session.id)).toContain(call.windowId!);
    });

    it('keeps each user’s meter to themselves', async () => {
      const a = await open(USER_A);
      const b = await open(USER_B);

      const callA = await runtime.think({ sessionId: a.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.think({ sessionId: b.id, requestId: 'r-b', task: 'plan', messages: MESSAGES });

      await runtime.settleWindow(a.id, callA.windowId!);

      expect(await balanceOf(USER_B)).toBe('1000');
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });
  });

  // ── Guardrails ────────────────────────────────────────────────────────────

  describe('guardrails — refused before execution, and logged as refused', () => {
    it('never reaches a tool that is not in the declared toolset', async () => {
      const session = await open();
      let ran = false;

      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'bank.withdraw',
          execute: async () => {
            ran = true;
            return 'moved the money';
          },
        }),
      ).rejects.toBeInstanceOf(RefusedError);

      // THE point of a guardrail: the tool did not run.
      expect(ran).toBe(false);

      const log = await runtime.sessionLog(session.id, 500);
      const refusal = log.at(-1)!;
      expect(refusal).toMatchObject({
        kind: 'tool_call',
        status: 'refused',
        tool: 'bank.withdraw',
        refusalCode: 'agents.tool_not_declared',
      });
      // And it is explained — a refusal nobody can account for afterwards is
      // worse than an action that did not happen.
      expect(refusal.userMessageKey).toBe('agents.refused.tool_not_declared');
      expect(refusal.userMessageParams).toMatchObject({ tool: 'bank.withdraw' });
    });

    it('runs a declared tool and logs it', async () => {
      const session = await open();
      const result = await runtime.act({ sessionId: session.id, tool: 'trade.quote', execute: async () => ({ price: '42' }) });

      expect(result.result).toEqual({ price: '42' });
      expect(result.action).toMatchObject({ kind: 'tool_call', status: 'executed', tool: 'trade.quote' });
    });

    it('holds a tool that needs approval, then runs it once the user confirms', async () => {
      const session = await open();

      await expect(runtime.act({ sessionId: session.id, tool: 'trade.order', execute: async () => 'placed' })).rejects.toMatchObject({
        refusal: { code: 'agents.approval_required' },
      });

      const approved = await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'place-1',
        execute: async () => 'placed',
      });
      expect(approved.result).toBe('placed');

      // Conversational repeat with the same intent key must not place again.
      let second = 0;
      const replay = await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'place-1',
        execute: async () => {
          second += 1;
          return 'placed again';
        },
      });
      expect(replay.replayed).toBe(true);
      expect(replay.result).toBe('placed');
      expect(second).toBe(0);

      // A new intent still hits the per-session budget of one.
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.order',
          approved: true,
          idempotencyKey: 'place-2',
          execute: async () => 'placed again',
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.tool_call_limit' } });
    });

    it('overlapping places with the same key execute once, and a later retry returns that result', async () => {
      const session = await open();
      let entered = 0;
      let releaseHold!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });

      const first = runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'overlap-place',
        execute: async () => {
          entered += 1;
          markReady();
          await hold;
          return 'first-place';
        },
      });
      await ready;

      const second = runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'overlap-place',
        execute: async () => {
          entered += 1;
          return 'second-place';
        },
      });
      await expect(second).rejects.toMatchObject({ refusal: { code: 'agents.place_key_conflict' } });
      expect(entered).toBe(1);

      releaseHold();
      const winner = await first;
      expect(winner.result).toBe('first-place');
      expect(winner.replayed).toBeUndefined();

      let third = 0;
      const replay = await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'overlap-place',
        execute: async () => {
          third += 1;
          return 'placed again';
        },
      });
      expect(replay.replayed).toBe(true);
      expect(replay.result).toBe('first-place');
      expect(third).toBe(0);
      expect(entered).toBe(1);
    });

    it('a different place tool reusing the key is refused by the guardrail and does not receive the first result', async () => {
      const session = await open();
      await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'shared-key',
        execute: async () => 'order-result',
      });

      let ran = false;
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.place',
          approved: true,
          idempotencyKey: 'shared-key',
          execute: async () => {
            ran = true;
            return 'place-result';
          },
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.tool_not_declared' } });
      expect(ran).toBe(false);
    });

    it('a different place tool the guardrail would allow still does not place', async () => {
      await runtime.registerAgent({
        ...PROBE,
        agentId: 'both-place',
        tools: [
          { name: 'trade.order', module: 'trade', mode: 'write', maxCallsPerSession: 1, requiresApproval: true },
          { name: 'trade.place', module: 'trade', mode: 'write', maxCallsPerSession: 1, requiresApproval: true },
        ],
      });
      const session = await open(USER_A, 'both-place');
      await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'shared-key',
        execute: async () => 'order-result',
      });

      let unapproved = false;
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.place',
          idempotencyKey: 'shared-key',
          execute: async () => {
            unapproved = true;
            return 'place-result';
          },
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.approval_required' } });
      expect(unapproved).toBe(false);

      let ran = false;
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.place',
          approved: true,
          idempotencyKey: 'shared-key',
          execute: async () => {
            ran = true;
            return 'place-result';
          },
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.place_key_conflict' } });
      expect(ran).toBe(false);
    });

    it('a failed place releases the key so one later retry can place', async () => {
      const session = await open();
      let calls = 0;

      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.order',
          approved: true,
          idempotencyKey: 'retry-place',
          execute: async () => {
            calls += 1;
            throw new Error('venue rejected');
          },
        }),
      ).rejects.toThrow('venue rejected');

      const placed = await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'retry-place',
        execute: async () => {
          calls += 1;
          return 'placed-after-failure';
        },
      });

      expect(placed.result).toBe('placed-after-failure');
      expect(placed.replayed).toBeUndefined();
      expect(calls).toBe(2);

      let again = 0;
      const replay = await runtime.act({
        sessionId: session.id,
        tool: 'trade.order',
        approved: true,
        idempotencyKey: 'retry-place',
        execute: async () => {
          again += 1;
          return 'placed twice';
        },
      });
      expect(replay.replayed).toBe(true);
      expect(replay.result).toBe('placed-after-failure');
      expect(again).toBe(0);
    });

    it('refuses an engine call the agent is not permitted to make, and bills nothing', async () => {
      const session = await open();

      await expect(
        runtime.think({ sessionId: session.id, requestId: 'r-vec', task: 'vectors', messages: MESSAGES }),
      ).rejects.toBeInstanceOf(RefusedError);

      expect(provider.callCount).toBe(0);
      expect(await balanceOf(USER_A)).toBe('1000');

      const log = await runtime.sessionLog(session.id, 500);
      expect(log.at(-1)).toMatchObject({ kind: 'completion', status: 'refused', task: 'vectors' });
    });

    it('refuses a call that could cross the session spend ceiling, before spending anything', async () => {
      const session = await open(USER_A, 'thrifty');

      await expect(runtime.think({ sessionId: session.id, requestId: 'r-spend', task: 'plan', messages: MESSAGES })).rejects.toMatchObject({
        refusal: { code: 'agents.spend_limit' },
      });

      expect(provider.callCount).toBe(0);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('a charge that lands exactly on the ceiling commits its real cost', async () => {
      const { route, usage } = expectedUsage('quick', MESSAGES, 1);
      const expected = usageCost(usage, route.price!);
      expect(expected).toBeGreaterThan(0n);
      await runtime.registerAgent({
        ...PROBE,
        agentId: 'exact-cap',
        limits: { ...PROBE.limits, maxSpendPerSession: formatAmount(expected) },
      });
      const session = await open(USER_A, 'exact-cap');
      expect(session.guardrail.limits.maxSpendPerSession).toBe(expected);
      expect(typeof session.guardrail.limits.maxSpendPerSession).toBe('bigint');

      const result = await runtime.think({
        sessionId: session.id,
        requestId: 'exact-one',
        task: 'quick',
        messages: MESSAGES,
        maxOutputTokens: 1,
      });

      expect(typeof result.cost).toBe('bigint');
      expect(result.cost).toBe(expected);
      expect(result.metered).toBe(true);
      expect(await meter.sessionSpend(session.id)).toBe(expected);
    });

    it('overlapping thinks that each fit alone do not both commit past the ceiling', async () => {
      const { route, usage } = expectedUsage('quick', MESSAGES, 1);
      const expected = usageCost(usage, route.price!);
      expect(expected).toBeGreaterThan(0n);
      await runtime.registerAgent({
        ...PROBE,
        agentId: 'pair-cap',
        limits: { ...PROBE.limits, maxSpendPerSession: formatAmount(expected) },
      });
      const session = await open(USER_A, 'pair-cap');
      const gate = gateComplete(gateway, 'both');
      const local = meteredRuntime(gate.gateway);

      const left = local.think({
        sessionId: session.id,
        requestId: 'pair-a',
        task: 'quick',
        messages: MESSAGES,
        maxOutputTokens: 1,
      });
      const right = local.think({
        sessionId: session.id,
        requestId: 'pair-b',
        task: 'quick',
        messages: MESSAGES,
        maxOutputTokens: 1,
      });
      await gate.ready;
      gate.release();

      const settled = await Promise.allSettled([left, right]);
      const won = settled.filter((s): s is PromiseFulfilledResult<Awaited<typeof left>> => s.status === 'fulfilled');
      const lost = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(typeof won[0]!.value.cost).toBe('bigint');
      expect(won[0]!.value.cost).toBe(expected);
      expect(lost[0]!.reason).toMatchObject({ refusal: { code: 'agents.spend_limit' } });

      const rows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(rows).toHaveLength(1);
      expect(await meter.sessionSpend(session.id)).toBe(expected);
      const stored = await runtime.session(session.id);
      expect(stored!.guardrail.limits.maxSpendPerSession).toBe(expected);
      expect(typeof stored!.guardrail.limits.maxSpendPerSession).toBe('bigint');
    });

    it('a null spend ceiling stays null while overlapping thinks commit their real costs', async () => {
      const session = await open();
      expect(session.guardrail.limits.maxSpendPerSession).toBeNull();
      const gate = gateComplete(gateway, 'both');
      const local = meteredRuntime(gate.gateway);
      const { route, usage } = expectedUsage('plan');
      const expected = usageCost(usage, route.price!);

      const left = local.think({ sessionId: session.id, requestId: 'null-a', task: 'plan', messages: MESSAGES });
      const right = local.think({ sessionId: session.id, requestId: 'null-b', task: 'plan', messages: MESSAGES });
      await gate.ready;
      gate.release();
      const [a, b] = await Promise.all([left, right]);

      expect(typeof a.cost).toBe('bigint');
      expect(typeof b.cost).toBe('bigint');
      expect(a.cost).toBe(expected);
      expect(b.cost).toBe(expected);
      const stored = await runtime.session(session.id);
      expect(stored!.guardrail.limits.maxSpendPerSession).toBeNull();
      const rows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(rows).toHaveLength(2);
    });

    it('refuses a run when the user has set no spend limit, before the provider is called', async () => {
      const session = await open();
      const gated = new AgentRuntime(sql, gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend: new UserSpendStore(sql),
      });
      const before = provider.callCount;
      await expect(
        gated.think({ sessionId: session.id, requestId: 'no-user-cap', task: 'plan', messages: MESSAGES }),
      ).rejects.toMatchObject({
        refusal: { code: 'agents.spend_limit', userMessageKey: 'agents.refused.spend_limit_unset' },
      });
      expect(provider.callCount).toBe(before);
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('holds the route worst case, commits the real cost once, and refuses a second call that would pass the cap', async () => {
      const store = new UserSpendStore(sql);
      const route = TABLE.routes.find((row) => row.task === 'quick')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: 1 }, route.price!);
      const cap = formatAmount(worst);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: cap,
        perSession: cap,
        perPeriod: cap,
        period: 'day',
        idempotencyKey: 'cap-once',
      });
      const session = await open();
      const gated = new AgentRuntime(sql, gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend: store,
      });
      const before = provider.callCount;
      const result = await gated.think({
        sessionId: session.id,
        requestId: 'cap-a',
        task: 'quick',
        messages: MESSAGES,
        maxOutputTokens: 1,
      });
      expect(typeof result.cost).toBe('bigint');
      expect(result.cost).toBeLessThanOrEqual(worst);
      const held = await sql<Array<{ status: string; n: string }>>`
        SELECT status, count(*)::text AS n FROM agents.spend_reservations WHERE user_id = ${USER_A} GROUP BY status
      `;
      expect(held).toEqual([{ status: 'committed', n: '1' }]);
      await expect(
        gated.think({ sessionId: session.id, requestId: 'cap-b', task: 'quick', messages: MESSAGES, maxOutputTokens: 1 }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.spend_limit' } });
      expect(provider.callCount).toBe(before + 1);
    });

    it('an over-cap completion commits the hold, releases the claim, then refuses the text', async () => {
      // The provider can outrun the worst case that was reserved. Throwing
      // before the reservation finishes leaves the hold `held` and the meter
      // claim stuck, so the same request id can never be retired.
      const store = new UserSpendStore(sql);
      const route = TABLE.routes.find((row) => row.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const { usage } = expectedUsage('plan');
      const inflatedUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens + 1_000_000 };
      const inflated = usageCost(inflatedUsage, route.price!);
      expect(inflated).toBeGreaterThan(worst);
      const cap = formatAmount(worst);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: cap,
        perSession: cap,
        perPeriod: cap,
        period: 'day',
        idempotencyKey: 'over-cap',
      });
      const session = await open();
      const wrapped = Object.create(gateway) as ModelGateway;
      wrapped.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
        const done = await gateway.complete(task, request);
        return { ...done, result: { ...done.result, usage: inflatedUsage, text: 'over-cap secret' } };
      };
      const gated = new AgentRuntime(sql, wrapped, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true, spend: store });
      const before = provider.callCount;
      await expect(gated.think({ sessionId: session.id, requestId: 'over-cap', task: 'plan', messages: MESSAGES })).rejects.toMatchObject({
        refusal: {
          code: 'agents.spend_limit',
          userMessageKey: 'agents.refused.spend_cap',
          userMessageParams: { limit: cap, asset: 'IFC', scope: 'call' },
        },
      });
      expect(provider.callCount).toBe(before + 1);
      const rows = await sql<Array<{ status: string; held: string; committed: string | null }>>`
        SELECT status, amount::text AS held, committed_amount::text AS committed
          FROM agents.spend_reservations
         WHERE user_id = ${USER_A} AND reservation_key = 'over-cap'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('committed');
      expect(amt(rows[0]!.held)).toBe(worst);
      expect(rows[0]!.committed).not.toBeNull();
      expect(amt(rows[0]!.committed!)).toBe(worst);
      expect(amt(rows[0]!.committed!)).not.toBe(inflated);
      const claims = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM agents.think_claims WHERE session_id = ${session.id} AND request_id = 'over-cap'
      `;
      expect(claims[0]!.n).toBe('0');
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
      const log = await gated.sessionLog(session.id, 50);
      expect(log.some((row) => row.status === 'executed' && row.outputDigest != null)).toBe(false);
      expect(log.some((row) => row.kind === 'completion' && row.status === 'refused')).toBe(true);
    });

    function overCapGateway(): { gateway: ModelGateway; worst: bigint; cap: string } {
      const route = TABLE.routes.find((row) => row.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const { usage } = expectedUsage('plan');
      const inflatedUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens + 1_000_000 };
      const wrapped = Object.create(gateway) as ModelGateway;
      wrapped.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
        const done = await gateway.complete(task, request);
        return { ...done, result: { ...done.result, usage: inflatedUsage, text: 'over-cap secret' } };
      };
      return { gateway: wrapped, worst, cap: formatAmount(worst) };
    }

    function flakyCommit(store: UserSpendStore, failTimes: number, releaseError?: Error): SpendGate {
      let commits = 0;
      return {
        reserve: (input) => store.reserve(input),
        release: (input) => {
          if (releaseError) return Promise.reject(releaseError);
          return store.release(input);
        },
        commitIn: (tx, input) => {
          commits += 1;
          if (commits <= failTimes) return Promise.reject(new Error('commit unavailable'));
          return store.commitIn(tx, input);
        },
      };
    }

    it('retries an over-cap commit without calling the provider again', async () => {
      const store = new UserSpendStore(sql);
      const inflated = overCapGateway();
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: inflated.cap,
        perSession: inflated.cap,
        perPeriod: inflated.cap,
        period: 'day',
        idempotencyKey: 'over-cap-retry',
      });
      const session = await open();
      const gated = new AgentRuntime(sql, inflated.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend: flakyCommit(store, 1),
      });
      const before = provider.callCount;
      await expect(
        gated.think({ sessionId: session.id, requestId: 'over-cap-retry', task: 'plan', messages: MESSAGES }),
      ).rejects.toMatchObject({
        refusal: { code: 'agents.spend_limit', userMessageKey: 'agents.refused.spend_cap' },
      });
      expect(provider.callCount).toBe(before + 1);
      const rows = await sql<Array<{ status: string; committed: string | null }>>`
        SELECT status, committed_amount::text AS committed
          FROM agents.spend_reservations
         WHERE user_id = ${USER_A} AND reservation_key = 'over-cap-retry'
      `;
      expect(rows[0]!.status).toBe('committed');
      expect(amt(rows[0]!.committed!)).toBe(inflated.worst);
      const claims = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM agents.think_claims WHERE session_id = ${session.id} AND request_id = 'over-cap-retry'
      `;
      expect(claims[0]!.n).toBe('0');
    });

    it('releases the claim and the hold together when an over-cap commit still fails', async () => {
      const store = new UserSpendStore(sql);
      const inflated = overCapGateway();
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: inflated.cap,
        perSession: inflated.cap,
        perPeriod: inflated.cap,
        period: 'day',
        idempotencyKey: 'over-cap-give-up',
      });
      const session = await open();
      const gated = new AgentRuntime(sql, inflated.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend: flakyCommit(store, 2, new Error('release unavailable')),
      });
      const before = provider.callCount;
      await expect(gated.think({ sessionId: session.id, requestId: 'over-cap-give-up', task: 'plan', messages: MESSAGES })).rejects.toThrow(
        'release unavailable',
      );
      expect(provider.callCount).toBe(before + 1);
      const rows = await sql<Array<{ status: string }>>`
        SELECT status FROM agents.spend_reservations WHERE user_id = ${USER_A} AND reservation_key = 'over-cap-give-up'
      `;
      expect(rows[0]!.status).toBe('held');
      const claims = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM agents.think_claims WHERE session_id = ${session.id} AND request_id = 'over-cap-give-up'
      `;
      expect(claims[0]!.n).toBe('0');
    });

    it('releases the hold when an over-cap commit cannot be retried', async () => {
      const store = new UserSpendStore(sql);
      const inflated = overCapGateway();
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: inflated.cap,
        perSession: inflated.cap,
        perPeriod: inflated.cap,
        period: 'day',
        idempotencyKey: 'over-cap-release',
      });
      const session = await open();
      const gated = new AgentRuntime(sql, inflated.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend: flakyCommit(store, 2),
      });
      const before = provider.callCount;
      await expect(gated.think({ sessionId: session.id, requestId: 'over-cap-release', task: 'plan', messages: MESSAGES })).rejects.toThrow(
        'commit unavailable',
      );
      expect(provider.callCount).toBe(before + 1);
      const rows = await sql<Array<{ status: string }>>`
        SELECT status FROM agents.spend_reservations WHERE user_id = ${USER_A} AND reservation_key = 'over-cap-release'
      `;
      expect(rows[0]!.status).toBe('released');
      const claims = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM agents.think_claims WHERE session_id = ${session.id} AND request_id = 'over-cap-release'
      `;
      expect(claims[0]!.n).toBe('0');
    });

    it('an unmetered run commits the real cost so the user cap accumulates', async () => {
      // recorded ? cost : 0n commits zero while metering is off, so a second
      // call still fits under a cap that the first call already spent.
      const store = new UserSpendStore(sql);
      const route = TABLE.routes.find((row) => row.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const { usage } = expectedUsage('plan');
      const cost = usageCost(usage, route.price!);
      expect(cost).toBeGreaterThan(0n);
      expect(cost).toBeLessThan(worst);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: formatAmount(worst),
        perSession: formatAmount(worst),
        perPeriod: formatAmount(worst),
        period: 'day',
        idempotencyKey: 'unmetered-accum',
      });
      const session = await open();
      const unbilled = new AgentRuntime(sql, gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: false,
        spend: store,
      });
      const result = await unbilled.think({ sessionId: session.id, requestId: 'unmetered-cost', task: 'plan', messages: MESSAGES });
      expect(result.metered).toBe(false);
      expect(result.cost).toBe(0n);
      const rows = await sql<Array<{ status: string; committed: string | null }>>`
        SELECT status, committed_amount::text AS committed
          FROM agents.spend_reservations
         WHERE user_id = ${USER_A} AND reservation_key = 'unmetered-cost'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('committed');
      expect(amt(rows[0]!.committed!)).toBe(cost);
      expect(amt(rows[0]!.committed!)).not.toBe(0n);
      const log = await unbilled.sessionLog(session.id, 50);
      const executed = log.find((row) => row.kind === 'completion' && row.status === 'executed');
      expect(executed?.cost).toBe(0n);
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
      const before = provider.callCount;
      await expect(
        unbilled.think({ sessionId: session.id, requestId: 'unmetered-cost-2', task: 'plan', messages: MESSAGES }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.spend_limit' } });
      expect(provider.callCount).toBe(before);
    });

    it('metering-off does not call the provider again on a committed hold that no longer fits', async () => {
      // A committed row is not a free replay and not agents.request_id_replay.
      // The next call needs its own hold, decided against the committed total.
      const store = new UserSpendStore(sql);
      const route = TABLE.routes.find((row) => row.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const cap = formatAmount(worst);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: cap,
        perSession: cap,
        perPeriod: cap,
        period: 'day',
        idempotencyKey: 'off-replay-hold',
      });
      const session = await open();
      const unbilled = new AgentRuntime(sql, gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: false,
        spend: store,
      });
      const before = provider.callCount;
      const first = await unbilled.think({
        sessionId: session.id,
        requestId: 'off-committed',
        task: 'plan',
        messages: MESSAGES,
      });
      expect(first.metered).toBe(false);
      expect(first.cost).toBe(0n);
      await expect(
        unbilled.think({
          sessionId: session.id,
          requestId: 'off-committed',
          task: 'plan',
          messages: MESSAGES,
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.spend_limit' } });
      expect(provider.callCount).toBe(before + 1);
      const { usage } = expectedUsage('plan');
      const cost = usageCost(usage, route.price!);
      const rows = await sql<Array<{ status: string; committed: string | null }>>`
        SELECT status, committed_amount::text AS committed
          FROM agents.spend_reservations
         WHERE user_id = ${USER_A}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('committed');
      expect(amt(rows[0]!.committed!)).toBe(cost);
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
    });

    it('metering-off repeats a request id only after a new hold that fits the committed total', async () => {
      const store = new UserSpendStore(sql);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: '1000',
        perSession: '1000',
        perPeriod: '1000',
        period: 'day',
        idempotencyKey: 'off-replay-fits',
      });
      const session = await open();
      const unbilled = new AgentRuntime(sql, gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: false,
        spend: store,
      });
      const before = provider.callCount;
      const first = await unbilled.think({
        sessionId: session.id,
        requestId: 'off-fits',
        task: 'plan',
        messages: MESSAGES,
      });
      const second = await unbilled.think({
        sessionId: session.id,
        requestId: 'off-fits',
        task: 'plan',
        messages: MESSAGES,
      });
      expect(first.metered).toBe(false);
      expect(second.metered).toBe(false);
      expect(first.cost).toBe(0n);
      expect(second.cost).toBe(0n);
      expect(provider.callCount).toBe(before + 2);
      const { usage, route } = expectedUsage('plan');
      const cost = usageCost(usage, route.price!);
      const rows = await sql<Array<{ reservation_key: string; status: string; committed: string | null }>>`
        SELECT reservation_key, status, committed_amount::text AS committed
          FROM agents.spend_reservations
         WHERE user_id = ${USER_A}
         ORDER BY reservation_key
      `;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.reservation_key)).toEqual(['off-fits', 'off-fits:1']);
      expect(rows.every((row) => row.status === 'committed')).toBe(true);
      expect(amt(rows[0]!.committed!) + amt(rows[1]!.committed!)).toBe(cost + cost);
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
    });

    it('an in-flight hold does not authorize another provider call when a new one does not fit', async () => {
      const store = new UserSpendStore(sql);
      const route = TABLE.routes.find((row) => row.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const cap = formatAmount(worst);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: cap,
        perSession: cap,
        perPeriod: cap,
        period: 'day',
        idempotencyKey: 'off-inflight',
      });
      const session = await open();
      await store.reserve({
        userId: USER_A,
        sessionId: session.id,
        reservationKey: 'off-inflight',
        assetId: 'IFC',
        amount: cap,
      });
      const unbilled = new AgentRuntime(sql, gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: false,
        spend: store,
      });
      const before = provider.callCount;
      await expect(
        unbilled.think({
          sessionId: session.id,
          requestId: 'off-inflight',
          task: 'plan',
          messages: MESSAGES,
        }),
      ).rejects.toMatchObject({ code: 'agents.spend_reservation_conflict' });
      expect(provider.callCount).toBe(before);
      const rows = await sql<Array<{ status: string; n: string }>>`
        SELECT status, count(*)::text AS n FROM agents.spend_reservations WHERE user_id = ${USER_A} GROUP BY status
      `;
      expect(rows).toEqual([{ status: 'held', n: '1' }]);
    });

    it('concurrent metering-off thinks with one request id call the provider once', async () => {
      const store = new UserSpendStore(sql);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: '1000',
        perSession: '1000',
        perPeriod: '1000',
        period: 'day',
        idempotencyKey: 'off-concurrent',
      });
      const session = await open();
      const gate = gateComplete(gateway, 'first');
      const unbilled = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: false,
        spend: store,
      });
      const before = provider.callCount;
      const first = unbilled.think({ sessionId: session.id, requestId: 'off-same', task: 'plan', messages: MESSAGES });
      await gate.ready;
      await expect(
        unbilled.think({ sessionId: session.id, requestId: 'off-same', task: 'plan', messages: MESSAGES }),
      ).rejects.toMatchObject({ code: 'agents.spend_reservation_conflict' });
      expect(gate.entered()).toBe(1);
      expect(provider.callCount).toBe(before);
      gate.release();
      const done = await first;
      expect(done.metered).toBe(false);
      expect(provider.callCount).toBe(before + 1);
      const rows = await sql<Array<{ status: string; n: string }>>`
        SELECT status, count(*)::text AS n FROM agents.spend_reservations WHERE user_id = ${USER_A} GROUP BY status
      `;
      expect(rows).toEqual([{ status: 'committed', n: '1' }]);
    });

    it('reconcileSpendHolds releases an old hold only when an age is set', async () => {
      const store = new UserSpendStore(sql);
      await store.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: '1000',
        perSession: '1000',
        perPeriod: '1000',
        period: 'day',
        idempotencyKey: 'reconcile-age',
      });
      const session = await open();
      await store.reserve({
        userId: USER_A,
        sessionId: session.id,
        reservationKey: 'stale-runtime',
        assetId: 'IFC',
        amount: '1',
        now: new Date('2020-01-01T00:00:00Z'),
      });
      const gated = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true, spend: store });
      await expect(gated.reconcileSpendHolds('   ')).rejects.toMatchObject({ code: 'agents.spend_hold_max_age_unset' });
      const rowsHeld = await sql<Array<{ status: string }>>`
        SELECT status FROM agents.spend_reservations WHERE user_id = ${USER_A} AND reservation_key = 'stale-runtime'
      `;
      expect(rowsHeld[0]?.status).toBe('held');
      const released = await gated.reconcileSpendHolds('1', new Date());
      expect(released.released).toBe(1);
      const rows = await sql<Array<{ status: string }>>`
        SELECT status FROM agents.spend_reservations WHERE user_id = ${USER_A} AND reservation_key = 'stale-runtime'
      `;
      expect(rows[0]?.status).toBe('released');
    });

    it('research-only never reaches place even when the tool is granted and approved', async () => {
      await runtime.registerAgent({ ...PROBE, agentId: 'research', capacityMode: 'research_only' });
      const session = await open(USER_A, 'research');
      let ran = false;
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.order',
          approved: true,
          idempotencyKey: 'chat-repeat',
          execute: async () => {
            ran = true;
            return 'placed';
          },
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.mode_forbids_write' } });
      expect(ran).toBe(false);
    });

    it('unknown capacity mode refuses live writes rather than defaulting to live', async () => {
      await runtime.registerAgent({ ...PROBE, agentId: 'no-mode', capacityMode: undefined });
      const session = await open(USER_A, 'no-mode');
      let ran = false;
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.order',
          approved: true,
          idempotencyKey: 'k',
          execute: async () => {
            ran = true;
            return 'placed';
          },
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.mode_unknown' } });
      expect(ran).toBe(false);
    });

    it('refuses bank.withdraw without a separate withdraw scope, even when granted', async () => {
      await runtime.registerAgent({
        ...PROBE,
        agentId: 'cashier',
        tools: [...PROBE.tools, { name: 'bank.withdraw', module: 'bank', mode: 'write', requiresApproval: true }],
        limits: { ...PROBE.limits, allowedModules: ['trade', 'bank'] },
      });
      const session = await open(USER_A, 'cashier');
      let ran = false;
      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'bank.withdraw',
          approved: true,
          execute: async () => {
            ran = true;
            return 'sent';
          },
        }),
      ).rejects.toMatchObject({ refusal: { code: 'agents.withdraw_scope_required' } });
      expect(ran).toBe(false);
    });

    it('binds the guardrail at session open — widening it later does not reach a running session', async () => {
      const session = await open();

      // The agent gains a tool while the session is in flight.
      await runtime.registerAgent({
        ...PROBE,
        version: 2,
        tools: [...PROBE.tools, { name: 'trade.close', module: 'trade', mode: 'write' }],
      });

      await expect(runtime.act({ sessionId: session.id, tool: 'trade.close', execute: async () => 'closed' })).rejects.toMatchObject({
        refusal: { code: 'agents.tool_not_declared' },
      });

      // A NEW session picks the widened guardrail up.
      const next = await open();
      expect(next.guardrailVersion).toBe(2);
      await expect(runtime.act({ sessionId: next.id, tool: 'trade.close', execute: async () => 'closed' })).resolves.toBeTruthy();
    });

    it('operator kill (enabled=false) survives boot re-register of the guardrail', async () => {
      // Kill-switch: DB flag stops new sessions. Boot re-upsert must refresh
      // the factory snapshot without flipping the agent back on.
      await sql`UPDATE agents.agent_definitions SET enabled = false WHERE agent_id = ${PROBE.agentId}`;
      await expect(runtime.openSession({ userId: USER_A, agentId: PROBE.agentId })).rejects.toMatchObject({
        code: 'agents.agent_not_found',
      });

      await runtime.registerAgent({
        ...PROBE,
        version: 9,
        tools: [...PROBE.tools, { name: 'trade.close', module: 'trade', mode: 'write' }],
      });

      const def = await runtime.agentDefinition(PROBE.agentId);
      expect(def?.enabled).toBe(false);
      expect(def?.guardrail.version).toBe(9);
      await expect(runtime.openSession({ userId: USER_A, agentId: PROBE.agentId })).rejects.toMatchObject({
        code: 'agents.agent_not_found',
      });
    });

    it('refuses everything on a closed session', async () => {
      const session = await open();
      await runtime.closeSession(session.id);

      await expect(runtime.think({ sessionId: session.id, requestId: 'r-late', task: 'plan', messages: MESSAGES })).rejects.toMatchObject({
        code: 'agents.session_closed',
      });
    });

    it('logs a tool that threw as failed, not as refused', async () => {
      const session = await open();

      await expect(
        runtime.act({
          sessionId: session.id,
          tool: 'trade.quote',
          execute: async () => {
            throw new Error('venue unreachable');
          },
        }),
      ).rejects.toThrow('venue unreachable');

      const log = await runtime.sessionLog(session.id, 500);
      // 'failed' is a different investigation from 'refused': one is the
      // platform working, the other is something breaking.
      expect(log.at(-1)).toMatchObject({ kind: 'tool_call', status: 'failed', refusalCode: null });
    });
  });

  // ── The audit table ───────────────────────────────────────────────────────

  describe('agent_actions — the Agentic Law (§8.2)', () => {
    it('records every action, including the ones that were refused', async () => {
      const session = await open();
      await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.act({ sessionId: session.id, tool: 'trade.quote', execute: async () => 'ok' });
      await runtime.act({ sessionId: session.id, tool: 'bank.withdraw', execute: async () => 'ok' }).catch(() => undefined);
      await runtime.closeSession(session.id);

      const log = await runtime.sessionLog(session.id, 500);
      expect(log.map((a) => `${a.kind}:${a.status}`)).toEqual([
        'session_open:executed',
        'completion:executed',
        'tool_call:executed',
        'tool_call:refused',
        'session_close:executed',
      ]);

      // Dense sequence: a gap would mean an action went unrecorded.
      expect(log.map((a) => a.sequence)).toEqual([0, 1, 2, 3, 4]);
    });

    it('is append-only — an UPDATE is rejected by the database', async () => {
      const session = await open();
      await runtime.act({ sessionId: session.id, tool: 'trade.quote', execute: async () => 'ok' });

      await expect(sql`UPDATE agents.agent_actions SET status = 'executed' WHERE session_id = ${session.id}`).rejects.toThrow(
        /append-only/,
      );
    });

    it('is append-only — a DELETE is rejected by the database', async () => {
      const session = await open();
      await runtime.act({ sessionId: session.id, tool: 'bank.withdraw', execute: async () => 'ok' }).catch(() => undefined);

      // The row a bad actor would most want gone.
      await expect(sql`DELETE FROM agents.agent_actions WHERE session_id = ${session.id} AND status = 'refused'`).rejects.toThrow(
        /append-only/,
      );

      const log = await runtime.sessionLog(session.id, 500);
      expect(log.some((a) => a.status === 'refused')).toBe(true);
    });

    it('cannot be edited even to correct it — the correction is another row', async () => {
      const session = await open();
      await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });

      await expect(sql`UPDATE agents.agent_actions SET cost = 0 WHERE session_id = ${session.id}`).rejects.toThrow(/append-only/);
    });

    it('chains each session’s actions, so a rewrite around the service is detectable', async () => {
      const session = await open();
      await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.act({ sessionId: session.id, tool: 'trade.quote', execute: async () => 'ok' });

      expect(await runtime.audit.verifyChain(session.id)).toEqual({ ok: true });

      const log = await runtime.sessionLog(session.id, 500);
      expect(log[0]!.prevHash).toBeNull();
      expect(log[1]!.prevHash).toBe(log[0]!.hash);
      expect(log[2]!.prevHash).toBe(log[1]!.hash);
    });

    it('detects a row whose contents no longer match its hash', async () => {
      const session = await open();
      const log = await runtime.sessionLog(session.id, 500);
      const row = log[0]!;

      // The database will not let us tamper, so the detection is asserted
      // against the hash function directly: changing any field changes the hash,
      // which is what makes `verifyChain` meaningful rather than decorative.
      const honest = hashAction({ ...row, userMessageParams: row.userMessageParams }, row.prevHash);
      const tampered = hashAction({ ...row, status: 'refused', userMessageParams: row.userMessageParams }, row.prevHash);

      expect(honest).toBe(row.hash);
      expect(tampered).not.toBe(row.hash);
    });

    it('stores digests of the prompt and the answer, never their text', async () => {
      const session = await open();
      const secret = 'my recovery phrase is aardvark banana cinnamon';
      const result = await runtime.think({
        sessionId: session.id,
        requestId: 'r-secret',
        task: 'plan',
        messages: [{ role: 'user', content: secret }],
      });

      const raw = await sql<Array<Record<string, unknown>>>`
        SELECT * FROM agents.agent_actions WHERE id = ${result.action.id}
      `;
      expect(JSON.stringify(raw[0])).not.toContain('aardvark');
      expect(result.action.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.action.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('gives a user their own log, and only their own', async () => {
      const a = await open(USER_A);
      const b = await open(USER_B);
      await runtime.think({ sessionId: a.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.think({ sessionId: b.id, requestId: 'r-b', task: 'plan', messages: MESSAGES });

      const log = await runtime.userLog(USER_A, 100);
      expect(log.length).toBeGreaterThan(0);
      expect(log.every((entry) => entry.userId === USER_A)).toBe(true);
    });

    it('keys every log line for i18n rather than shipping prose', async () => {
      const session = await open();
      await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.act({ sessionId: session.id, tool: 'bank.withdraw', execute: async () => 'ok' }).catch(() => undefined);

      for (const action of await runtime.sessionLog(session.id, 500)) {
        expect(action.userMessageKey).toMatch(/^agents\./);
      }
    });
  });

  // ── Degradation ───────────────────────────────────────────────────────────

  describe('provider failure degrades cleanly', () => {
    it('bills nothing when the engine is down, and says so in the log', async () => {
      const session = await open();
      provider.breakWith(new ProviderError('upstream is down', 'primary', true, 503));

      await expect(runtime.think({ sessionId: session.id, requestId: 'r-down', task: 'plan', messages: MESSAGES })).rejects.toBeInstanceOf(
        AgentError,
      );

      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');

      const rows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(rows).toHaveLength(0);

      const log = await runtime.sessionLog(session.id, 500);
      expect(log.at(-1)).toMatchObject({ kind: 'completion', status: 'failed' });
      expect(log.at(-1)!.userMessageKey).toBe('agents.error.engine_unavailable');
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('bills once when a transient failure is retried under the same request id', async () => {
      const session = await open();
      const flaky = new MockModelProvider({ id: 'primary', failFirst: 1 });
      const flakyRuntime = new AgentRuntime(sql, new ModelGateway([flaky], TABLE), meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
      });

      await expect(
        flakyRuntime.think({ sessionId: session.id, requestId: 'same-request', task: 'plan', messages: MESSAGES }),
      ).rejects.toBeInstanceOf(AgentError);

      const ok = await flakyRuntime.think({ sessionId: session.id, requestId: 'same-request', task: 'plan', messages: MESSAGES });
      const settlement = await flakyRuntime.settleWindow(session.id, ok.windowId!);

      expect(settlement.amount).toBe(usageCost(ok.usage, ok.route.price!));
      expect(await houseOf()).toBe(formatAmount(settlement.amount));
      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('does not route to a provider that is already known to be unhealthy', async () => {
      const session = await open();
      provider.breakWith(new ProviderError('upstream is down', 'primary', true, 503));

      await expect(runtime.think({ sessionId: session.id, requestId: 'r-x', task: 'plan', messages: MESSAGES })).rejects.toMatchObject({
        code: 'agents.provider_unavailable',
      });

      // Refused on health, so the request never left the process.
      expect(provider.callCount).toBe(0);
    });

    it('recovers without leaving a partial charge behind', async () => {
      const session = await open();
      provider.breakWith(new ProviderError('upstream is down', 'primary', true, 503));
      await runtime.think({ sessionId: session.id, requestId: 'r-1', task: 'plan', messages: MESSAGES }).catch(() => undefined);

      provider.repair();
      const ok = await runtime.think({ sessionId: session.id, requestId: 'r-2', task: 'plan', messages: MESSAGES });
      const settlement = await runtime.settleWindow(session.id, ok.windowId!);

      expect(settlement.amount).toBe(usageCost(ok.usage, ok.route.price!));
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });
  });

  // ── Events ────────────────────────────────────────────────────────────────

  describe('events (§10)', () => {
    it('publishes a completed action, a rejected action, and a settled window', async () => {
      const session = await open();
      const call = await runtime.think({ sessionId: session.id, requestId: 'r-a', task: 'plan', messages: MESSAGES });
      await runtime.act({ sessionId: session.id, tool: 'bank.withdraw', execute: async () => 'ok' }).catch(() => undefined);
      await runtime.settleWindow(session.id, call.windowId!);

      expect(bus.emitted('agentActionCompleted').length).toBeGreaterThan(0);
      expect(bus.emitted('agentActionRejected')[0]?.payload).toMatchObject({
        refusalCode: 'agents.tool_not_declared',
        tool: 'bank.withdraw',
      });
      expect(bus.emitted('agentUsageSettled')[0]?.payload).toMatchObject({ assetId: 'IFC', windowId: call.windowId! });
    });

    it('carries no prompt, no answer and no vendor model id on the wire', async () => {
      const session = await open();
      await runtime.think({
        sessionId: session.id,
        requestId: 'r-a',
        task: 'plan',
        messages: [{ role: 'user', content: 'aardvark banana cinnamon' }],
      });

      const serialised = JSON.stringify(bus.published);
      expect(serialised).not.toContain('aardvark');
      // The routing task travels; the model does not.
      expect(serialised).toContain('plan');
      expect(serialised).not.toContain('reasoning-lg');
    });
  });

  // ── D26-P2-01h: real metering-off kill-switch through public tRPC doors ───
  // Paired with metering-public-doors-promise-falsify.test.ts (DB-free createCaller
  // matrix). Lives here so TRUNCATE stays single-owner with this Postgres suite.

  describe('D26-P2-01h public doors — real AgentRuntime metering-off', () => {
    const DOORS_SECRET = 'an-agents-runtime-metering-doors-secret';
    const doorsEdge = createEdgeContext({ secret: DOORS_SECRET, serviceName: 'svc-agents' });

    function doorsPrincipal(overrides: Partial<Principal> = {}): Principal {
      return {
        sub: USER_A,
        userId: USER_A,
        sid: '22222222-2222-4222-8222-222222222222',
        scopes: ['agents:read', 'agents:execute', 'admin:write'],
        tier: 'none',
        mfa: false,
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      } as Principal;
    }

    /** The person's own request; `asService` adds the svc-agents caller name the settle doors require. Run doors refuse a service (OWNER 107). */
    function doorsSigned(p: Principal = doorsPrincipal(), asService = false) {
      const raw = encodePrincipal(p);
      const signed = {
        ...doorsEdge({
          headers: {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, DOORS_SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          },
          id: 'req-doors',
        }),
      };
      return asService ? { ...signed, service: 'svc-agents' as const } : signed;
    }

    function routerDeps(rt: AgentRuntime): AgentsRouterDeps {
      return { runtime: rt, gateway, meter, feeAssetId: 'IFC' };
    }

    it('run.complete through createCaller never bills / never feeCharges', async () => {
      const off = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const session = await off.openSession({ userId: USER_A, agentId: 'probe' });
      const result = await createAgentsRouter(routerDeps(off)).createCaller(doorsSigned()).run.complete({
        sessionId: session.id,
        requestId: 'doors-off-complete-1',
        task: 'plan',
        messages: MESSAGES,
      });

      expect(result.metered).toBe(false);
      expect(result.cost).toBe('0');
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
    });

    it('run.complete same requestId twice through createCaller never invents a charge or request_id_replay', async () => {
      const off = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const session = await off.openSession({ userId: USER_A, agentId: 'probe' });
      const caller = createAgentsRouter(routerDeps(off)).createCaller(doorsSigned());
      const first = await caller.run.complete({
        sessionId: session.id,
        requestId: 'doors-off-replay',
        task: 'plan',
        messages: MESSAGES,
      });
      const second = await caller.run.complete({
        sessionId: session.id,
        requestId: 'doors-off-replay',
        task: 'plan',
        messages: MESSAGES,
      });

      expect(first.metered).toBe(false);
      expect(second.metered).toBe(false);
      expect(first.cost).toBe('0');
      expect(second.cost).toBe('0');
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      const usageRows = await sql`SELECT id FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usageRows).toHaveLength(0);
    });

    it('usage.settle / settleSession / session.close refuse leftover windows without feeCharge', async () => {
      const on = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });
      const session = await on.openSession({ userId: USER_A, agentId: 'probe' });
      const call = await on.think({
        sessionId: session.id,
        requestId: 'doors-then-off',
        task: 'plan',
        messages: MESSAGES,
      });
      expect(call.metered).toBe(true);
      expect(call.windowId).not.toBeNull();

      const off = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: false });
      const caller = createAgentsRouter(routerDeps(off)).createCaller(doorsSigned(doorsPrincipal(), true));
      const person = createAgentsRouter(routerDeps(off)).createCaller(doorsSigned());

      const settle = await caller.usage.settle({ sessionId: session.id, windowId: call.windowId! });
      expect(settle).toMatchObject({ amount: '0', settled: false, assetId: 'IFC' });

      const settleAll = await caller.usage.settleSession({ sessionId: session.id });
      expect(settleAll.settlements.every((s) => s.settled === false && s.amount === '0')).toBe(true);

      const closed = await person.session.close({ sessionId: session.id });
      expect(closed.status).toBe('closed');

      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await houseOf()).toBe('0');
      const stillOpen = await meter.openWindows(session.id);
      expect(stillOpen).toContain(call.windowId!);
    });
  });

  describe('OWNER 107 — a run starts only when it can be paid for, priced and run by the person', () => {
    /** Counts how often the engine is reached through a gateway. */
    function counting(inner: ModelGateway) {
      let calls = 0;
      const wrapped = Object.create(inner) as ModelGateway;
      wrapped.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
        calls += 1;
        return inner.complete(task, request);
      };
      return { gateway: wrapped, calls: () => calls };
    }
    const refusalCode = (err: unknown) => (err instanceof RefusedError ? err.refusal.code : String(err));

    it('refuses a task with no published rate before the engine, and logs the refusal', async () => {
      const blank = counting(new ModelGateway([provider], unpricedTable(TABLE)));
      const rt = new AgentRuntime(sql, blank.gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });
      const session = await rt.openSession({ userId: USER_A, agentId: 'probe' });
      const err = await rt.think({ sessionId: session.id, requestId: 'blank-rate', task: 'plan', messages: MESSAGES }).catch((e) => e);
      expect(refusalCode(err)).toBe('agents.price_unset');
      expect(blank.calls()).toBe(0);
      const log = await rt.sessionLog(session.id, 50);
      expect(log.at(-1)).toMatchObject({ status: 'refused', refusalCode: 'agents.price_unset' });
      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('refuses a run whose worst case the available balance cannot cover, before the hold and the engine', async () => {
      const route = TABLE.routes.find((r) => r.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const gate = counting(gateway);
      const spend = new UserSpendStore(sql);
      const below = formatAmount(worst - 1n);
      const rt = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend,
        funds: { available: async () => amt(below) },
      });
      await rt.registerAgent({ ...PROBE, agentId: 'capped', limits: { ...PROBE.limits, maxSpendPerSession: '1' } });
      const session = await rt.openSession({ userId: USER_A, agentId: 'capped' });
      const err = await rt.think({ sessionId: session.id, requestId: 'poor-1', task: 'plan', messages: MESSAGES }).catch((e) => e);
      expect(refusalCode(err)).toBe('agents.funds_insufficient');
      expect(gate.calls()).toBe(0);
      const holds = await sql`SELECT 1 FROM agents.spend_reservations WHERE session_id = ${session.id}`;
      expect(holds).toHaveLength(0);
      const usage = await sql`SELECT 1 FROM agents.usage_records WHERE session_id = ${session.id}`;
      expect(usage).toHaveLength(0);

      // Exactly the worst case is enough.
      const enough = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend,
        funds: { available: async () => worst },
      });
      const ok = await enough.think({ sessionId: session.id, requestId: 'poor-2', task: 'plan', messages: MESSAGES });
      expect(ok.metered).toBe(true);
      expect(gate.calls()).toBe(1);
    });

    it('with a spend gate, a balance that cannot be read refuses as unread before the hold and the engine, and bills 0', async () => {
      const gate = counting(gateway);
      const rt = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend: new UserSpendStore(sql),
        funds: {
          available: async () => {
            throw new Error('ledger down');
          },
        },
      });
      await rt.registerAgent({ ...PROBE, agentId: 'unread-gate', limits: { ...PROBE.limits, maxSpendPerSession: '1' } });
      const session = await rt.openSession({ userId: USER_A, agentId: 'unread-gate' });
      const err = await rt.think({ sessionId: session.id, requestId: 'unread-gate-1', task: 'plan', messages: MESSAGES }).catch((e) => e);
      expect(refusalCode(err)).toBe('agents.funds_unread');
      expect(gate.calls()).toBe(0);
      expect(await sql`SELECT 1 FROM agents.spend_reservations WHERE session_id = ${session.id}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM agents.usage_records WHERE session_id = ${session.id}`).toHaveLength(0);
      const log = await rt.sessionLog(session.id, 50);
      expect(log.at(-1)).toMatchObject({ status: 'refused', refusalCode: 'agents.funds_unread' });
      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('refuses when the balance cannot be read: an unknown balance is not a covered one', async () => {
      const gate = counting(gateway);
      const rt = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        funds: {
          available: async () => {
            throw new Error('ledger down');
          },
        },
      });
      const session = await rt.openSession({ userId: USER_A, agentId: 'probe' });
      const err = await rt.think({ sessionId: session.id, requestId: 'unread', task: 'plan', messages: MESSAGES }).catch((e) => e);
      expect(refusalCode(err)).toBe('agents.funds_unread');
      expect(gate.calls()).toBe(0);
    });

    it('a person with no limits of their own runs under the agent’s cap, held across runs at once', async () => {
      const route = TABLE.routes.find((r) => r.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const spend = new UserSpendStore(sql);
      // A cap that one worst case fits under and two do not.
      const cap = formatAmount(worst + worst / 2n);
      await runtime.registerAgent({ ...PROBE, agentId: 'pair', limits: { ...PROBE.limits, maxSpendPerSession: cap } });
      const session = await runtime.openSession({ userId: USER_A, agentId: 'pair' });
      const first = await spend.reserve({
        userId: USER_A,
        sessionId: session.id,
        reservationKey: 'pair-1',
        assetId: 'IFC',
        amount: formatAmount(worst),
        agentCap: cap,
      });
      expect(first.status).toBe('held');
      await expect(
        spend.reserve({
          userId: USER_A,
          sessionId: session.id,
          reservationKey: 'pair-2',
          assetId: 'IFC',
          amount: formatAmount(worst),
          agentCap: cap,
        }),
      ).rejects.toMatchObject({ code: 'agents.spend_limit' });
      // Without the agent's cap, a person with no limits is refused as before.
      await expect(
        spend.reserve({ userId: USER_A, sessionId: session.id, reservationKey: 'pair-3', assetId: 'IFC', amount: '0.000001' }),
      ).rejects.toMatchObject({ code: 'agents.spend_limit_unset' });

      const rt = new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true, spend });
      const freshSession = await rt.openSession({ userId: USER_B, agentId: 'pair' });
      const ran = await rt.think({ sessionId: freshSession.id, requestId: 'pair-run', task: 'plan', messages: MESSAGES });
      expect(ran.metered).toBe(true);
    });

    it('counts usage not yet charged against the balance: a run the balance covers only before that debt does not start', async () => {
      const route = TABLE.routes.find((r) => r.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const spend = new UserSpendStore(sql);
      let available = worst * 10n;
      const gate = counting(gateway);
      const rt = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend,
        funds: { available: async () => available },
      });
      await rt.registerAgent({ ...PROBE, agentId: 'owed', limits: { ...PROBE.limits, maxSpendPerSession: '1000' } });
      const session = await rt.openSession({ userId: USER_A, agentId: 'owed' });
      await rt.think({ sessionId: session.id, requestId: 'owed-1', task: 'plan', messages: MESSAGES });
      const owed = await meter.sessionSpend(session.id);
      expect(owed > 0n).toBe(true);

      // The ledger still shows the whole balance: the window is open, nothing is charged yet.
      available = worst + owed - 1n;
      const err = await rt.think({ sessionId: session.id, requestId: 'owed-2', task: 'plan', messages: MESSAGES }).catch((e) => e);
      expect(refusalCode(err)).toBe('agents.funds_insufficient');
      expect(gate.calls()).toBe(1);
      const holds = await sql`SELECT status FROM agents.spend_reservations WHERE session_id = ${session.id} AND reservation_key = 'owed-2'`;
      expect(holds).toHaveLength(0);
      expect(await meter.sessionSpend(session.id)).toBe(owed);

      available = worst + owed;
      await rt.think({ sessionId: session.id, requestId: 'owed-3', task: 'plan', messages: MESSAGES });
      expect(gate.calls()).toBe(2);
    });

    it('two runs at once whose worst cases together exceed the balance: exactly one starts, the other bills 0 and holds nothing', async () => {
      const route = TABLE.routes.find((r) => r.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const spend = new UserSpendStore(sql);
      const gate = counting(gateway);
      const rt = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend,
        funds: { available: async () => worst + worst / 2n },
      });
      await rt.registerAgent({ ...PROBE, agentId: 'twin', limits: { ...PROBE.limits, maxSpendPerSession: '1000' } });
      // Two sessions, so the agent's per-session cap is not what decides.
      const one = await rt.openSession({ userId: USER_A, agentId: 'twin' });
      const two = await rt.openSession({ userId: USER_A, agentId: 'twin' });
      const results = await Promise.allSettled([
        rt.think({ sessionId: one.id, requestId: 'twin-1', task: 'plan', messages: MESSAGES }),
        rt.think({ sessionId: two.id, requestId: 'twin-2', task: 'plan', messages: MESSAGES }),
      ]);
      const admitted = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refusalCode(refused[0]!.reason)).toBe('agents.funds_insufficient');
      expect(gate.calls()).toBe(1);
      const refusedSession = results[0]!.status === 'rejected' ? one.id : two.id;
      expect(await sql`SELECT 1 FROM agents.spend_reservations WHERE session_id = ${refusedSession}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM agents.usage_records WHERE session_id = ${refusedSession}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM agents.spend_reservations WHERE status = 'held'`).toHaveLength(0);
      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('the agent’s cap applies even when the person’s own limit is higher: the lower of the two wins', async () => {
      const route = TABLE.routes.find((r) => r.task === 'plan')!;
      const worst = usageCost({ inputTokens: estimateInputTokens(undefined, MESSAGES), outputTokens: route.maxOutputTokens }, route.price!);
      const spend = new UserSpendStore(sql);
      await spend.set({
        userId: USER_A,
        assetId: 'IFC',
        perCall: '100',
        perSession: '100',
        perPeriod: '100',
        period: 'month',
        idempotencyKey: 'own-high',
      });
      const cap = formatAmount(worst + worst / 2n);
      await runtime.registerAgent({ ...PROBE, agentId: 'lower', limits: { ...PROBE.limits, maxSpendPerSession: cap } });
      const session = await runtime.openSession({ userId: USER_A, agentId: 'lower' });
      const reserve = (key: string) =>
        spend.reserve({
          userId: USER_A,
          sessionId: session.id,
          reservationKey: key,
          assetId: 'IFC',
          amount: formatAmount(worst),
          agentCap: cap,
        });
      expect((await reserve('lower-1')).status).toBe('held');
      await expect(reserve('lower-2')).rejects.toMatchObject({ code: 'agents.spend_limit' });
      const rows = await sql<
        Array<{ reservation_key: string }>
      >`SELECT reservation_key FROM agents.spend_reservations WHERE session_id = ${session.id}`;
      expect(rows.map((r) => r.reservation_key)).toEqual(['lower-1']);
    });

    it('a replayed request id reads as a replay even when the balance is now short, and the engine is not called again', async () => {
      const spend = new UserSpendStore(sql);
      let available = amt('1000');
      const gate = counting(gateway);
      const rt = new AgentRuntime(sql, gate.gateway, meter, bus, {
        feeAssetId: 'IFC',
        meteringEnabled: true,
        spend,
        funds: { available: async () => available },
      });
      await rt.registerAgent({ ...PROBE, agentId: 'again', limits: { ...PROBE.limits, maxSpendPerSession: '1000' } });
      const session = await rt.openSession({ userId: USER_A, agentId: 'again' });
      await rt.think({ sessionId: session.id, requestId: 'again-1', task: 'plan', messages: MESSAGES });
      available = 0n;
      await expect(rt.think({ sessionId: session.id, requestId: 'again-1', task: 'plan', messages: MESSAGES })).rejects.toMatchObject({
        code: 'agents.request_id_replay',
      });
      expect(gate.calls()).toBe(1);
    });

    it('session.detail shows each usage window: open while running, settled once with its charge after close; never another person’s', async () => {
      const SECRET = 'an-agents-owner-107-session-detail-secret';
      const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
      const as = (userId: string) => {
        const raw = encodePrincipal({
          sub: userId,
          userId,
          sid: '44444444-4444-4444-8444-444444444444',
          scopes: ['agents:read', 'agents:execute'],
          tier: 'none',
          mfa: false,
          expiresAt: new Date(Date.now() + 60_000),
        } as Principal);
        return edge({
          headers: {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          },
          id: 'req-detail',
        });
      };
      const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql });
      const person = router.createCaller(as(USER_A));
      const session = await person.session.open({ agentId: 'probe' });
      const ran = await person.run.complete({ sessionId: session.id, requestId: 'detail-1', task: 'plan', messages: MESSAGES });
      const before = await person.session.detail({ sessionId: session.id });
      expect(before.windows).toEqual([expect.objectContaining({ state: 'open', amount: null, chargeKey: null })]);

      await person.session.close({ sessionId: session.id });
      const after = await person.session.detail({ sessionId: session.id });
      expect(after.session.status).toBe('closed');
      expect(after.windows).toHaveLength(1);
      expect(after.windows[0]).toMatchObject({ state: 'settled', amount: ran.cost });
      expect(after.windows[0]!.chargeKey).toMatch(/^agent\.usage:/);
      expect(await balanceOf(USER_A)).toBe(formatAmount(amt('1000') - amt(ran.cost)));

      await expect(router.createCaller(as(USER_B)).session.detail({ sessionId: session.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('session.detail lists a run as running while the engine has not answered, then completed; a replay is still one run', async () => {
      const SECRET = 'an-agents-session-detail-runs-secret';
      const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
      const raw = encodePrincipal({
        sub: USER_A,
        userId: USER_A,
        sid: '44444444-4444-4444-8444-444444444445',
        scopes: ['agents:read', 'agents:execute'],
        tier: 'none',
        mfa: false,
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal);
      const ctx = edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-detail-runs',
      });
      const dir = mkdtempSync(join(tmpdir(), 'agents-hold-'));
      const hold = join(dir, 'engine.hold');
      const held = new MockModelProvider({ id: 'primary', holdFile: hold });
      const heldRuntime = new AgentRuntime(sql, new ModelGateway([held], TABLE), meter, bus, { feeAssetId: 'IFC', meteringEnabled: true });
      const person = createAgentsRouter({ runtime: heldRuntime, gateway, meter, feeAssetId: 'IFC', sql }).createCaller(ctx);
      const session = await person.session.open({ agentId: 'probe' });
      try {
        writeFileSync(hold, 'held');
        let failed: unknown = null;
        const running = person.run.complete({ sessionId: session.id, requestId: 'detail-runs-1', task: 'plan', messages: MESSAGES });
        running.catch((err: unknown) => (failed = err));
        await vi.waitFor(
          () => {
            expect(failed).toBeNull();
            expect(existsSync(`${hold}.held`)).toBe(true);
          },
          { timeout: 5_000 },
        );
        // The engine is parked at its door and has not answered: the run is already on record, and nothing is used yet.
        expect(held.callCount).toBe(1);
        const during = await person.session.detail({ sessionId: session.id });
        expect(during.runs).toEqual([{ requestId: 'detail-runs-1', startedAt: expect.any(String), state: 'running' }]);
        expect(await meter.hasRequest(session.id, 'detail-runs-1')).toBe(false);
        rmSync(hold);
        await running;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const after = await person.session.detail({ sessionId: session.id });
      expect(after.runs).toEqual([{ requestId: 'detail-runs-1', startedAt: expect.any(String), state: 'completed' }]);
      await expect(
        person.run.complete({ sessionId: session.id, requestId: 'detail-runs-1', task: 'plan', messages: MESSAGES }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect((await person.session.detail({ sessionId: session.id })).runs).toEqual(after.runs);
      expect(held.callCount).toBe(1);
    }, 20_000);

    it('session.select keeps the selected session for the person on any device; another person’s session is not found and changes nothing', async () => {
      const SECRET = 'an-agents-selected-session-secret';
      const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
      const as = (userId: string, sid: string) => {
        const raw = encodePrincipal({
          sub: userId,
          userId,
          sid,
          scopes: ['agents:read', 'agents:execute'],
          tier: 'none',
          mfa: false,
          expiresAt: new Date(Date.now() + 60_000),
        } as Principal);
        return edge({
          headers: {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          },
          id: 'req-select',
        });
      };
      const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql });
      // Two sign-ins of the same person: two devices.
      const phone = router.createCaller(as(USER_A, '55555555-5555-4555-8555-555555555555'));
      const laptop = router.createCaller(as(USER_A, '66666666-6666-4666-8666-666666666666'));
      expect(await laptop.session.selected()).toBeNull();
      const older = await phone.session.open({ agentId: 'probe' });
      await phone.session.open({ agentId: 'probe' });
      expect(await phone.session.select({ sessionId: older.id })).toEqual({ sessionId: older.id, agentId: 'probe' });
      expect(await laptop.session.selected()).toEqual({ sessionId: older.id, agentId: 'probe' });

      const other = router.createCaller(as(USER_B, '77777777-7777-4777-8777-777777777777'));
      const theirs = await other.session.open({ agentId: 'probe' });
      await expect(phone.session.select({ sessionId: theirs.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await laptop.session.selected()).toEqual({ sessionId: older.id, agentId: 'probe' });
      expect(await other.session.selected()).toBeNull();
    });

    it('the run doors take only the person: a delegated token or a service on the request is refused', async () => {
      const SECRET = 'an-agents-owner-107-person-doors-secret';
      const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
      const signed = (extra: Partial<Principal> = {}) => {
        const raw = encodePrincipal({
          sub: USER_A,
          userId: USER_A,
          sid: '33333333-3333-4333-8333-333333333333',
          scopes: ['agents:read', 'agents:execute'],
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
          id: 'req-owner-107',
        });
      };
      const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC' });
      expect((await router.createCaller(signed()).session.open({ agentId: 'probe' })).status).toBe('open');
      for (const ctx of [
        signed({ kid: '66666666-6666-4666-8666-666666666666' }),
        signed({ sub_account: '77777777-7777-4777-8777-777777777777' }),
        { ...signed(), service: 'svc-trade' as const },
      ]) {
        await expect(router.createCaller(ctx as ReturnType<typeof signed>).session.open({ agentId: 'probe' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
    });

    it('only the person selects which session their history shows: a key, a sub-account or a service is refused and changes nothing', async () => {
      const SECRET = 'an-agents-select-person-only-secret';
      const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
      const signed = (extra: Partial<Principal> = {}) => {
        const raw = encodePrincipal({
          sub: USER_A,
          userId: USER_A,
          sid: '33333333-3333-4333-8333-333333333333',
          scopes: ['agents:read', 'agents:execute'],
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
          id: 'req-select-person',
        });
      };
      const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql });
      const person = router.createCaller(signed());
      const first = await person.session.open({ agentId: 'probe' });
      const second = await person.session.open({ agentId: 'probe' });
      expect(await person.session.select({ sessionId: first.id })).toEqual({ sessionId: first.id, agentId: 'probe' });
      for (const ctx of [
        signed({ kid: '66666666-6666-4666-8666-666666666666' }),
        signed({ sub_account: '77777777-7777-4777-8777-777777777777' }),
        { ...signed(), service: 'svc-trade' as const },
      ]) {
        await expect(router.createCaller(ctx as ReturnType<typeof signed>).session.select({ sessionId: second.id })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      expect(await person.session.selected()).toEqual({ sessionId: first.id, agentId: 'probe' });
    });
  });

  // ── The operator's agent log and the kept transcript (AG-audit-01, AG-audit-02) ──
  // Lives here so TRUNCATE stays single-owner with this Postgres suite.

  describe('operator agent log (opsLog) and kept transcripts', () => {
    const SECRET = 'an-agents-operator-log-test-secret-32';
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
    const OPERATOR = '44444444-4444-4444-8444-444444444444';
    const REASONS = ['TEST customer complaint', 'TEST incident review'];
    const SETTINGS: OpsLogSettings = { reasons: REASONS, limit: 50, retentionDays: 1 };
    const operatorCtx = (scopes = ['admin:read'], extra: Partial<Principal> = {}) => {
      const raw = encodePrincipal({
        ...extra,
        sub: OPERATOR,
        userId: OPERATOR,
        sid: '55555555-5555-4555-8555-555555555555',
        scopes,
        tier: 'none',
        mfa: true,
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal);
      return edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-ops-log',
      });
    };
    const opsLog = (settings: Partial<OpsLogSettings> = {}) =>
      createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql, opsLog: { ...SETTINGS, ...settings } }).createCaller(
        operatorCtx(),
      ).opsLog;
    const reads = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.agent_log_reads`)[0]!.n;
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const kept = () => new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true, transcriptRetentionDays: 1 });

    beforeEach(async () => {
      await sql`TRUNCATE agents.agent_log_reads, agents.agent_transcripts`;
    });

    /** One executed engine call and one refused task for USER_A, run with retention on. */
    async function history() {
      const rt = kept();
      const session = await rt.openSession({ userId: USER_A, agentId: 'probe' });
      const ran = await rt.think({ sessionId: session.id, requestId: 'ops-log-ran', task: 'plan', messages: MESSAGES });
      await expect(
        rt.think({ sessionId: session.id, requestId: 'ops-log-refused', task: 'vectors', messages: MESSAGES }),
      ).rejects.toBeInstanceOf(RefusedError);
      const [refused] = await sql<{ id: string; refusal_code: string }[]>`
        SELECT id, refusal_code FROM agents.agent_actions WHERE session_id = ${session.id} AND status = 'refused'
      `;
      return { session, ranId: ran.action.id, refused: refused! };
    }

    it('keeps an engine call’s prompt text while retention is on, its sha256 the row’s input digest; with retention 0 keeps none', async () => {
      const { ranId } = await history();
      const [row] = await sql<{ text: string; user_id: string; days: number }[]>`
        SELECT text, user_id, extract(epoch FROM expires_at - stored_at)::int / 86400 AS days FROM agents.agent_transcripts WHERE action_id = ${ranId}
      `;
      const [action] = await sql<{ input_digest: string }[]>`SELECT input_digest FROM agents.agent_actions WHERE id = ${ranId}`;
      expect(row).toMatchObject({ user_id: USER_A, days: 1 });
      expect(row!.text).toContain('Where do I stake?');
      expect(sha256(row!.text)).toBe(action!.input_digest);
      // The refused call ran nothing and keeps nothing.
      expect((await sql`SELECT 1 FROM agents.agent_transcripts`).length).toBe(1);

      const session = await runtime.openSession({ userId: USER_A, agentId: 'probe' });
      const unkept = await runtime.think({ sessionId: session.id, requestId: 'ops-log-unkept', task: 'plan', messages: MESSAGES });
      expect((await sql`SELECT 1 FROM agents.agent_transcripts WHERE action_id = ${unkept.action.id}`).length).toBe(0);
    });

    it('refuses every read by its code while the owner’s reasons are blank, a missing or unlisted reason, or a blank limit, and writes no audit row', async () => {
      const read = { userId: USER_A, requestId: 'ops-log:refuse:1' };
      await expect(opsLog({ reasons: null }).reasons()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'agents.log_read_reason_unset',
      });
      for (const door of ['actions', 'export'] as const) {
        await expect(opsLog({ reasons: null })[door]({ ...read, reason: REASONS[0] })).rejects.toMatchObject({
          message: 'agents.log_read_reason_unset',
        });
        await expect(opsLog()[door](read)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'agents.log_read_reason_required' });
        await expect(opsLog()[door]({ ...read, reason: 'curiosity' })).rejects.toMatchObject({ message: 'agents.log_read_reason_unknown' });
        await expect(opsLog({ limit: null })[door]({ ...read, reason: REASONS[0] })).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'agents.ops_actions_limit_unset',
        });
      }
      await expect(
        opsLog({ reasons: null }).transcript({ actionId: USER_B, reason: REASONS[0], requestId: 'ops-log:t:1' }),
      ).rejects.toMatchObject({
        message: 'agents.log_read_reason_unset',
      });
      expect(await opsLog().reasons()).toEqual({ reasons: REASONS });
      expect(await reads()).toBe(0);
    });

    it('lists one customer’s actions with tool and refusal code and no prompt text, writing one audit row per read, once per request id', async () => {
      const { ranId, refused } = await history();
      const read = { userId: USER_A, reason: REASONS[1], requestId: 'ops-log:actions:1' };
      const page = await opsLog().actions(read);
      expect(page).toMatchObject({ more: false, limit: 50, auditRows: 1 });
      expect(page.items.find((i) => i.id === ranId)).toMatchObject({
        kind: 'completion',
        tool: 'plan',
        outcome: 'executed',
        refusalCode: null,
      });
      expect(page.items.find((i) => i.id === refused.id)).toMatchObject({
        tool: 'vectors',
        outcome: 'refused',
        refusalCode: refused.refusal_code,
      });
      expect(page.tools).toEqual(expect.arrayContaining(['plan', 'vectors']));
      expect(JSON.stringify(page)).not.toContain('Where do I stake?');
      // The retried request writes no second row; a new request writes its own.
      expect((await opsLog().actions(read)).auditRows).toBe(1);
      expect(await reads()).toBe(1);
      const [audit] = await sql`SELECT operator_id, subject_id, kind, reason, filter, action_id, row_count FROM agents.agent_log_reads`;
      expect(audit).toMatchObject({
        operator_id: OPERATOR,
        subject_id: USER_A,
        kind: 'actions',
        reason: REASONS[1],
        filter: {},
        action_id: null,
        row_count: page.items.length,
      });
      await opsLog().actions({ ...read, requestId: 'ops-log:actions:2' });
      expect(await reads()).toBe(2);
      // Another customer's rows are not in this one's read.
      expect((await opsLog().actions({ ...read, userId: USER_B, requestId: 'ops-log:actions:3' })).items).toEqual([]);
    });

    it('filters by outcome and tool, flags a page past the owner’s limit, and exports the same rows as CSV', async () => {
      const { refused } = await history();
      const read = { userId: USER_A, reason: REASONS[0], outcome: 'refused' as const, tool: 'vectors' };
      const page = await opsLog().actions({ ...read, requestId: 'ops-log:filter:1' });
      expect(page.items.map((i) => i.id)).toEqual([refused.id]);
      const file = await opsLog().export({ ...read, requestId: 'ops-log:export:1' });
      expect(file).toMatchObject({ rows: 1, more: false, auditRows: 1 });
      const [header, ...lines] = file.csv.trim().split('\n');
      expect(header).toBe('Time,Tool,Outcome,Refusal code,Input digest,Action id');
      expect(lines).toEqual([`${page.items[0]!.occurredAt},vectors,Refused,${refused.refusal_code},,${refused.id}`]);
      const [audit] = await sql`SELECT kind, filter, row_count FROM agents.agent_log_reads WHERE kind = 'export'`;
      expect(audit).toMatchObject({ kind: 'export', filter: { outcome: 'refused', tool: 'vectors' }, row_count: 1 });
      const capped = await opsLog({ limit: 1 }).actions({ userId: USER_A, reason: REASONS[0], requestId: 'ops-log:capped:1' });
      expect(capped).toMatchObject({ more: true, limit: 1 });
      expect(capped.items).toHaveLength(1);
    });

    it('opens a kept transcript for a reason, with the digest computed from its text; refuses blank or zero retention, an unknown action and an unkept call', async () => {
      const { ranId, refused } = await history();
      const open = (actionId: string, requestId: string, settings = {}) =>
        opsLog(settings).transcript({ actionId, reason: REASONS[0], requestId });
      await expect(open(ranId, 'ops-log:t:unset', { retentionDays: null })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'agents.transcript_retention_unset',
      });
      await expect(open(ranId, 'ops-log:t:zero', { retentionDays: 0 })).rejects.toMatchObject({ message: 'agents.transcript_not_kept' });
      await expect(open('99999999-9999-4999-8999-999999999999', 'ops-log:t:none')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'agents.action_not_found',
      });
      await expect(open(refused.id, 'ops-log:t:refused')).rejects.toMatchObject({ message: 'agents.transcript_not_kept' });
      await expect(opsLog().transcript({ actionId: ranId, requestId: 'ops-log:t:noreason' })).rejects.toMatchObject({
        message: 'agents.log_read_reason_required',
      });
      expect(await reads()).toBe(0);

      const shown = await open(ranId, 'ops-log:t:ok');
      const [action] = await sql<{ input_digest: string }[]>`SELECT input_digest FROM agents.agent_actions WHERE id = ${ranId}`;
      expect(shown).toMatchObject({ actionId: ranId, userId: USER_A, auditRows: 1, inputDigest: action!.input_digest });
      expect(shown.digest).toBe(sha256(shown.text));
      expect(shown.digest).toBe(action!.input_digest);
      const [audit] = await sql`SELECT kind, action_id, subject_id, row_count FROM agents.agent_log_reads`;
      expect(audit).toMatchObject({ kind: 'transcript', action_id: ranId, subject_id: USER_A, row_count: 1 });

      // Kept under a longer retention than today's, the text is not read past today's retention.
      await sql`UPDATE agents.agent_transcripts SET stored_at = now() - interval '2 days', expires_at = now() + interval '1 day' WHERE action_id = ${ranId}`;
      await expect(open(ranId, 'ops-log:t:shortened')).rejects.toMatchObject({ message: 'agents.transcript_not_kept' });
      expect((await open(ranId, 'ops-log:t:longer', { retentionDays: 3 })).digest).toBe(action!.input_digest);

      // Past its expiry the text is never read.
      await sql`UPDATE agents.agent_transcripts SET stored_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE action_id = ${ranId}`;
      await expect(open(ranId, 'ops-log:t:expired')).rejects.toMatchObject({ message: 'agents.transcript_not_kept' });
    });

    it('refuses a request id reused for another customer, reason or filter, and returns nothing for it', async () => {
      await history();
      const read = { userId: USER_A, reason: REASONS[0], requestId: 'ops-log:reuse:1' };
      await opsLog().actions(read);
      for (const reused of [{ userId: USER_B }, { reason: REASONS[1] }, { outcome: 'refused' as const }]) {
        await expect(opsLog().actions({ ...read, ...reused })).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'agents.log_read_request_reused',
        });
      }
      // The same read retried is still the one row.
      expect((await opsLog().actions(read)).auditRows).toBe(1);
      const audit = await sql`SELECT subject_id, reason FROM agents.agent_log_reads`;
      expect(audit).toEqual([{ subject_id: USER_A, reason: REASONS[0] }]);

      // Past the retry window the same request id is refused: a fresh read needs its own row.
      const stale = { ...read, requestId: 'ops-log:reuse:stale' };
      await sql`
        INSERT INTO agents.agent_log_reads (business_key, operator_id, subject_id, kind, reason, row_count, read_at)
        VALUES (${logReadKey('actions', OPERATOR, stale.requestId)}, ${OPERATOR}, ${USER_A}, 'actions', ${REASONS[0]}, 1,
                now() - interval '6 minutes')
      `;
      await expect(opsLog().actions(stale)).rejects.toMatchObject({ code: 'CONFLICT', message: 'agents.log_read_request_reused' });
      expect(await reads()).toBe(2);
    });

    it('writes a cell a spreadsheet would run as a formula as text in the export', () => {
      const row = { occurredAt: '2026-10-29T00:00:00.000Z', kind: 'completion', outcome: 'refused' as const, inputDigest: null, id: 'a' };
      const csv = actionsCsv([
        { ...row, tool: '=HYPERLINK("https://example.invalid","x")', refusalCode: 'agents.refused.task_not_allowed' },
        { ...row, tool: '+1', refusalCode: '@x' },
      ]);
      expect(csv.split('\n').slice(1, 3)).toEqual([
        `2026-10-29T00:00:00.000Z,"'=HYPERLINK(""https://example.invalid"",""x"")",Refused,agents.refused.task_not_allowed,,a`,
        `2026-10-29T00:00:00.000Z,'+1,Refused,'@x,,a`,
      ]);
    });

    it('purges every kept transcript past its expiry or older than today’s retention, on its own; blank or 0 retention keeps none', async () => {
      const { ranId } = await history();
      expect(await purgeExpiredTranscripts(sql, 1)).toBe(0);
      await sql`UPDATE agents.agent_transcripts SET stored_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE action_id = ${ranId}`;
      // An engine call with retention 0 keeps nothing and leaves the purge to the timer.
      const session = await runtime.openSession({ userId: USER_A, agentId: 'probe' });
      await runtime.think({ sessionId: session.id, requestId: 'ops-log-purge', task: 'plan', messages: MESSAGES });
      expect((await sql`SELECT 1 FROM agents.agent_transcripts`).length).toBe(1);
      expect(await purgeExpiredTranscripts(sql, 1)).toBe(1);
      expect((await sql`SELECT 1 FROM agents.agent_transcripts`).length).toBe(0);

      // Kept under a longer retention, a row older than today's goes before its own expiry.
      const longer = (await history()).ranId;
      await sql`UPDATE agents.agent_transcripts SET stored_at = now() - interval '2 days', expires_at = now() + interval '1 day' WHERE action_id = ${longer}`;
      expect(await purgeExpiredTranscripts(sql, 3)).toBe(0);
      expect(await purgeExpiredTranscripts(sql, 1)).toBe(1);

      // Blank or 0 retention keeps none: every kept row goes, however fresh.
      for (const retention of [0, null]) {
        await history();
        expect(await purgeExpiredTranscripts(sql, 1)).toBe(0);
        expect(await purgeExpiredTranscripts(sql, retention)).toBe(1);
      }
    });

    it('needs admin:read, and an audit row is never rewritten', async () => {
      const customer = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql, opsLog: SETTINGS }).createCaller(
        operatorCtx(['agents:read', 'agents:execute']),
      );
      await expect(customer.opsLog.actions({ userId: USER_A, reason: REASONS[0], requestId: 'ops-log:scope:1' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // Only an operator's own session reads: never a sub-account or an API key.
      for (const extra of [{ sub_account: '66666666-6666-4666-8666-666666666666' }, { kid: 'key-ops-log' }]) {
        const via = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql, opsLog: SETTINGS }).createCaller(
          operatorCtx(['admin:read'], extra),
        );
        await expect(via.opsLog.actions({ userId: USER_A, reason: REASONS[0], requestId: 'ops-log:person:1' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      expect(await reads()).toBe(0);
      await opsLog().actions({ userId: USER_A, reason: REASONS[0], requestId: 'ops-log:append:1' });
      await expect(sql`UPDATE agents.agent_log_reads SET reason = 'TEST other'`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM agents.agent_log_reads`).rejects.toThrow(/append-only/);
      expect(await reads()).toBe(1);
    });
  });
}

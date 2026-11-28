/**
 * svc-pay's real entry, `index.ts`, booted in this process against a migrated throwaway database. Nothing is stood in:
 * the modules named in `vi.mock` below are the real ones, each export wrapped so the test can see what the boot built
 * and what it handed to whom. The ledger, the bus and identity are absent (dead addresses), as on a stack where they
 * have not come up yet. The doors are asked over `app.inject`, the logs read from the boot's own logger.
 */
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  serviceAuthHeaders,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { bootDatabase, bootEnv, BOOT_INTERNAL_SECRET, BOOT_SECRET, type BootDatabase } from './boot.testkit.js';
import { emitCapturedOverCap } from './control/over-cap-signal.js';
import { CONVERSION_HOLD_SWEEP_MS, CONVERSION_LATE_FILL_TICK_MS } from './conversion/late-fill-schedule.js';
import { MERCHANT_WATCH_METRICS_PATH } from './agents/merchant-watch-metrics-routes.js';
import { loadHaltAutoTripConfig } from './halts/config.js';
import { payChainReadyHonesty } from './ready-honesty.js';

const seen = vi.hoisted(() => {
  type Call = { args: unknown[]; result: unknown };
  const calls = new Map<string, Call[]>();
  const log = (name: string, call: Call) => {
    const list = calls.get(name) ?? [];
    list.push(call);
    calls.set(name, list);
  };
  /** The module with the named exports wrapped: a class records each construction, a function each call. */
  const wrap = (mod: Record<string, unknown>, names: readonly string[]) => {
    const out: Record<string, unknown> = { ...mod };
    for (const name of names) {
      const original = mod[name] as ((...args: unknown[]) => unknown) & (new (...args: unknown[]) => object);
      if (typeof original !== 'function') throw new Error(`${name} is not exported as a function or class`);
      if (/^class\b/.test(Function.prototype.toString.call(original))) {
        const wrapped = class extends original {
          constructor(...args: unknown[]) {
            super(...args);
            log(name, { args, result: this });
          }
        };
        Object.defineProperty(wrapped, 'name', { value: original.name });
        out[name] = wrapped;
      } else {
        out[name] = function (this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          log(name, { args, result });
          return result;
        };
      }
    }
    return out;
  };
  const state: { app: FastifyInstance | null } = { app: null };
  const logs: Array<Record<string, unknown>> = [];
  const w = (names: readonly string[]) => async (original: () => Promise<unknown>) =>
    wrap((await original()) as Record<string, unknown>, names);
  return { calls, w, state, logs, of: (name: string): Call[] => calls.get(name) ?? [] };
});

vi.mock('fastify', async (original) => {
  const mod = (await original()) as { default: (...args: unknown[]) => FastifyInstance };
  // The boot's logger writes into `seen.logs` as well as nowhere else: every line it logs is kept, parsed.
  const fastify = (options: { logger?: Record<string, unknown> } = {}, ...rest: unknown[]) => {
    const logger = options.logger
      ? { ...options.logger, stream: { write: (line: string) => void seen.logs.push(JSON.parse(line)) } }
      : options.logger;
    const app = mod.default({ ...options, logger }, ...rest);
    seen.state.app ??= app;
    return app;
  };
  return { ...mod, default: Object.assign(fastify, mod.default) };
});
vi.mock('./rails/broadcast-store.js', seen.w(['PostgresBroadcastStore', 'MemoryBroadcastStore']));
vi.mock('./rails/chain-port.js', seen.w(['MemoryChain']));
vi.mock('./rails/posture.js', seen.w(['defaultChainFor']));
vi.mock('./rails/chain-watcher.js', seen.w(['CryptoChainWatcher', 'PostgresChainWatcherCursorStore', 'MemoryChainWatcherCursorStore']));
vi.mock('./affiliate-accrue.js', seen.w(['createAffiliateAccrueClient']));
vi.mock('./affiliate-payout.js', seen.w(['createAffiliatePayoutClient']));
vi.mock('./payment-service.js', seen.w(['PayService']));
vi.mock('./user-money-service.js', seen.w(['UserMoneyService']));
vi.mock('./conversion/service.js', seen.w(['ConversionService']));
vi.mock('./merchant-webhooks.js', seen.w(['MerchantWebhookService']));
vi.mock('./seams/registry.js', seen.w(['buildPayGuards']));
vi.mock('./seams/guards.js', seen.w(['composeGuards']));
vi.mock('./withdrawals/allowlist/guard.js', seen.w(['createAllowlistGuards']));
vi.mock('./withdrawals/approvals/guard.js', seen.w(['createWithdrawalApprovalGuards']));
vi.mock('./withdrawals/allowlist/service.js', seen.w(['AllowlistService']));
vi.mock('./withdrawals/approvals/service.js', seen.w(['WithdrawalApprovalService']));
vi.mock('./withdrawals/allowlist/router.js', seen.w(['createAllowlistRouter']));
vi.mock('./namespaces/index.js', seen.w(['createPayNamespaces']));
vi.mock('./halts/store.js', seen.w(['PayHaltStore']));
vi.mock('./halts/adopt-boot.js', seen.w(['retryAdoptConfig']));
vi.mock('./halts/autotrip-log.js', seen.w(['setAutoTripAccountErrorSink']));
vi.mock('./control/index.js', seen.w(['ControlService']));
vi.mock('./metrics/index.js', seen.w(['createMetricsRuntime', 'startMetricsRefresher']));
vi.mock('./capture-reconcile.js', seen.w(['setCaptureReconcileLogger']));
vi.mock('./control/guards.js', seen.w(['setOverCapNoticeLogger']));
vi.mock('./control/over-cap-signal.js', seen.w(['onCapturedOverCap']));
vi.mock('./capture-reconcile-routes.js', seen.w(['registerCaptureReconcileRoutes']));
vi.mock('./agents/merchant-watch-metrics-routes.js', seen.w(['registerMerchantWatchMetricsRoutes']));
vi.mock('./subscriptions/index.js', seen.w(['registerSubscriptionCycleRoutes', 'SubscriptionService']));
vi.mock('@intafaced/contracts/raw-body', seen.w(['retainRawBody']));
vi.mock('./payout-reconciler.js', seen.w(['startPayoutReconciler']));
vi.mock('./router.js', seen.w(['createPayRouter']));
vi.mock('./merchant-state-router.js', seen.w(['createMerchantStateRouter']));
vi.mock('./kyb-router.js', seen.w(['createKybPspRouter']));
vi.mock('./submerchant-router.js', seen.w(['createSubMerchantRouter']));
vi.mock('./merchant-account-controls.js', seen.w(['MerchantAccountControls']));
vi.mock('./public-rest.js', seen.w(['registerPublicPayRest']));
vi.mock('./founder-authority.js', seen.w(['createFounderAuthority']));

const USER = '11111111-1111-4111-8111-111111111111';
const IDENTITY_URL = 'http://127.0.0.1:9';
const edge = generateEdgePrincipalKeyPair();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const one = (name: string) => {
  const list = seen.of(name);
  expect(list, `${name} calls`).toHaveLength(1);
  return list[0]!;
};
const argOf = <T = Record<string, unknown>>(name: string, index = 0): T => one(name).args[index] as T;

let database: BootDatabase;
let app: FastifyInstance;
const envBefore = { ...process.env };
/** The boot's warnings, as its logger wrote them (pino level 40). */
const warnings = () => seen.logs.filter((line) => line.level === 40);
const intervals: Array<{ ms: number | undefined; run: () => void; handle: unknown }> = [];
const cleared: unknown[] = [];
const timers: { holdSweep?: unknown; lateFillSweep?: unknown } = {};
let shutdown: (() => void) | undefined;

describe('svc-pay boot (index.ts)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    database = await bootDatabase();
    const env = bootEnv(database.db.url, await freePort(), {
      PATH: undefined,
      LOG_LEVEL: 'warn',
      IDENTITY_URL,
      EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey,
      EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120',
      EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10',
      PAY_CRYPTO_WATCHER_ENABLED: 'true',
    });
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const setInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, ms?: number) => {
      const handle = setInterval(run, ms);
      intervals.push({ ms, run, handle });
      return handle;
    }) as typeof globalThis.setInterval);
    const clearInterval = globalThis.clearInterval;
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((handle: Parameters<typeof clearInterval>[0]) => {
      cleared.push(handle);
      clearInterval(handle);
    }) as typeof globalThis.clearInterval);
    const before = new Set(process.listeners('SIGTERM'));
    await import('./index.js');
    app = seen.state.app!;
    shutdown = process.listeners('SIGTERM').find((listener) => !before.has(listener)) as (() => void) | undefined;
  }, 240_000);

  afterAll(async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      if (shutdown) {
        process.removeListener('SIGTERM', shutdown);
        shutdown();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 20_000 });
      }
    } finally {
      exit.mockRestore();
      for (const { handle } of intervals) clearTimeout(handle as NodeJS.Timeout);
      vi.restoreAllMocks();
      for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
      Object.assign(process.env, envBefore);
      await database?.stop();
    }
  }, 60_000);

  const principal = () =>
    ({
      sub: USER,
      userId: USER,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['pay:read'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    }) as Parameters<typeof encodeForwardedPrincipal>[0];
  const edgeSigned = () => {
    const raw = encodeForwardedPrincipal(principal(), 60);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeaderEd25519(raw, edge.privateKey, 'DE'),
      'x-intafaced-region': 'DE',
    };
  };
  const foreignSigned = () => {
    const raw = encodeForwardedPrincipal(principal(), 60);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeaderEd25519(raw, generateEdgePrincipalKeyPair().privateKey, 'DE'),
      'x-intafaced-region': 'DE',
    };
  };
  const secretSigned = () => {
    const raw = encodePrincipal(principal());
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, BOOT_SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    };
  };
  const service = (body: string) => ({
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody('svc-cron', BOOT_INTERNAL_SECRET, body),
  });
  const procedures = () => Object.keys((one('createPayNamespaces').result as { _def: { procedures: object } })._def.procedures);

  describe('money wiring', () => {
    it('constructs the durable journal and injects it into defaultChainFor', () => {
      const store = one('PostgresBroadcastStore');
      expect(store.args[0]).toBe(argOf('PayService', 0));
      expect(one('defaultChainFor').args).toEqual([process.env, store.result]);
    });

    it('does not fall back to MemoryBroadcastStore at boot', () => {
      // The only in-memory journals are the in-memory TEST chain's own keys; none stands in for the durable one.
      const chains = seen
        .of('MemoryChain')
        .map((c) => (typeof c.result === 'object' && c.result !== null ? Reflect.get(c.result, 'keys') : undefined));
      expect(chains.length).toBeGreaterThan(0);
      expect(seen.of('MemoryBroadcastStore').map((c) => c.result)).toEqual(chains);
    });

    it('constructs the durable cursor and does not fall back to MemoryChainWatcherCursorStore at boot', () => {
      expect(one('PostgresChainWatcherCursorStore').args[0]).toBe(argOf('PayService', 0));
      expect(seen.of('MemoryChainWatcherCursorStore')).toEqual([]);
    });

    it('starts the watcher only behind EvmLiveChain — no mnemonic, no invented deposit', () => {
      // PAY_CRYPTO_WATCHER_ENABLED=true here, and the chain is the in-memory TEST chain: no watcher.
      expect(one('defaultChainFor').result).toMatchObject({ posture: 'sandbox' });
      expect(seen.of('CryptoChainWatcher')).toEqual([]);
    });

    it('builds one guard registry and hands it to the payment service, the user-money service and conversion', () => {
      const guards = one('buildPayGuards');
      expect(guards.args[0]).toMatchObject({ sql: argOf('PayService', 0), ledger: one('PayService').args[1] });
      expect(argOf('PayService', 3)).toMatchObject({ guards: guards.result });
      expect(argOf('UserMoneyService', 3)).toMatchObject({ guards: guards.result });
      expect(argOf('ConversionService')).toMatchObject({ guards: guards.result });
    });

    it('index builds the identity accrue and payout clients for the payment service', () => {
      const accrue = one('createAffiliateAccrueClient');
      const payout = one('createAffiliatePayoutClient');
      expect(accrue.args.slice(0, 2)).toEqual([IDENTITY_URL, BOOT_INTERNAL_SECRET]);
      expect(payout.args.slice(0, 2)).toEqual([IDENTITY_URL, BOOT_INTERNAL_SECRET]);
      expect(argOf('PayService', 3)).toMatchObject({ affiliateAccrue: accrue.result, affiliatePayout: payout.result });
    });

    it('a captured payment settles its subscription execution, and nothing pre-notifies', async () => {
      const options = argOf<{ afterPaymentEvent: (event: unknown) => Promise<void> }>('PayService', 3);
      const subscriptions = one('SubscriptionService').result as { markExecutionSettledForPayment: (id: string) => Promise<unknown> };
      const webhooks = one('MerchantWebhookService').result as { enqueue: (event: unknown) => Promise<unknown> };
      const settled = vi.spyOn(subscriptions, 'markExecutionSettledForPayment').mockResolvedValue(undefined);
      const enqueued = vi.spyOn(webhooks, 'enqueue').mockResolvedValue(undefined);
      try {
        const payment = { id: '66666666-6666-4666-8666-666666666666' };
        await options.afterPaymentEvent({ type: 'payment.captured', payment });
        await options.afterPaymentEvent({ type: 'payment.created', payment });
        expect(settled.mock.calls).toEqual([[payment.id]]);
        expect(enqueued).toHaveBeenCalledTimes(2);
        expect(Object.keys(subscriptions)).not.toContain('notifyBeforeCharge');
      } finally {
        settled.mockRestore();
        enqueued.mockRestore();
      }
    });

    it('the allowlist rides the withdrawal claim before the approval gate, and the direct door asks it first', async () => {
      const claim = [one('createAllowlistGuards').result, one('createWithdrawalApprovalGuards').result];
      const composed = seen.of('composeGuards').filter((c) => c.args.includes(claim[0]) || c.args.includes(claim[1]));
      expect(composed.map((c) => c.args)).toEqual([claim]);
      const [claimGuards] = composed;
      expect(argOf('UserMoneyService', 3)).toMatchObject({ claimGuards: claimGuards!.result });
      const door = one('createPayRouter').args[11] as { assertDirectAllowed: (input: unknown) => Promise<void> };
      const allowlist = one('AllowlistService').result as { assertDirectAllowed: (input: unknown) => Promise<void> };
      const approvals = one('WithdrawalApprovalService').result as { assertDirectAllowed: (input: unknown) => Promise<void> };
      const order: string[] = [];
      const refused = new Error('allowlist refused');
      const a = vi.spyOn(allowlist, 'assertDirectAllowed').mockImplementation(async () => void order.push('allowlist'));
      const b = vi.spyOn(approvals, 'assertDirectAllowed').mockImplementation(async () => void order.push('approvals'));
      try {
        await door.assertDirectAllowed({ id: 'w-1' });
        expect(order).toEqual(['allowlist', 'approvals']);
        a.mockRejectedValueOnce(refused);
        await expect(door.assertDirectAllowed({ id: 'w-2' })).rejects.toBe(refused);
        expect(order).toEqual(['allowlist', 'approvals']);
      } finally {
        a.mockRestore();
        b.mockRestore();
      }
      expect(one('createAllowlistRouter').args).toEqual([allowlist]);
      expect(argOf('createPayNamespaces')).toMatchObject({ allowlist: { service: allowlist } });
    });
  });

  describe('composition', () => {
    it('src/index.ts still composes the routers this fixture mirrors, with the one live founder authority', () => {
      const sql = argOf('PayService', 0);
      const pay = one('PayService').result;
      const rails = one('PayService').args[2];
      const userMoney = one('UserMoneyService').result;
      const founderAuthority = one('createFounderAuthority').result;
      const router = one('createPayRouter').args;
      expect(router.slice(0, 3)).toEqual([pay, rails, userMoney]);
      const subMerchants = router[3];
      expect(seen.of('createMerchantStateRouter')).toHaveLength(1);
      expect(seen.of('createKybPspRouter')).toHaveLength(1);
      expect(one('createSubMerchantRouter').args).toEqual([subMerchants, pay, sql]);
      expect(one('MerchantAccountControls').args.slice(0, 2)).toEqual([sql, founderAuthority]);
      expect(one('createMetricsRuntime').args[0]).toEqual({ sql, pay, trees: subMerchants, rails });
      expect(one('createMetricsRuntime').args[1]).toHaveProperty('settlementAssets');
      expect(one('registerPublicPayRest').args[0]).toBe(app);
      const haltStore = one('PayHaltStore');
      expect(haltStore.args[0]).toBe(sql);
      expect(haltStore.args[1]).toEqual(loadHaltAutoTripConfig(process.env));
      expect(haltStore.args[2]).toBe(rails);
      const ns = argOf('createPayNamespaces');
      expect(ns).toMatchObject({
        founderAuthority,
        metrics: one('createMetricsRuntime').result,
        registries: { sql },
        sql,
        payHalts: { store: haltStore.result, merchants: pay, team: expect.anything() },
        treasury: { sql },
        control: one('ControlService').result,
      });
      expect((ns.registries as { approvals?: unknown }).approvals).toBeDefined();
      expect(ns.receiptPlaces).toEqual(expect.any(Function));
      expect(one('ControlService').args[0]).toBe(sql);
      expect(one('startMetricsRefresher').args[0]).toBe((one('createMetricsRuntime').result as { projector: unknown }).projector);
      expect(seen.of('retryAdoptConfig')).toHaveLength(1);
      expect(seen.of('setAutoTripAccountErrorSink')).toHaveLength(1);
    });

    it('is merged into the live appRouter in index.ts together with the guard registry', async () => {
      const { appRouter } = await import('./index.js');
      const live = Object.keys(appRouter._def.procedures);
      for (const path of procedures()) expect(live, path).toContain(path);
      expect(live.some((path) => path.startsWith('founderAdmin.registries.'))).toBe(true);
      expect(live.some((path) => path.startsWith('merchantOps.'))).toBe(true);
      expect(live.some((path) => path.startsWith('b2bRamp.'))).toBe(true);
      expect(live.some((path) => path.startsWith('allowlist.') || path.includes('.allowlist.'))).toBe(true);
    });
  });

  describe('doors', () => {
    it('index.ts serves /ready via payChainReadyHonesty, not chain.description', async () => {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const chain = one('defaultChainFor').result as { posture: Parameters<typeof payChainReadyHonesty>[0]; description: string };
      expect(res.json().chain).toEqual(payChainReadyHonesty(chain.posture));
      expect(res.body).not.toContain(chain.description);
    });

    it('index registers S2S routes at boot', async () => {
      expect(one('retainRawBody').args[0]).toBe(app);
      expect(argOf('registerMerchantWatchMetricsRoutes', 1)).toMatchObject({ internalSecret: BOOT_INTERNAL_SECRET });
      expect((await app.inject({ method: 'GET', url: MERCHANT_WATCH_METRICS_PATH })).statusCode).toBe(401);
      const signed = await app.inject({
        method: 'GET',
        url: MERCHANT_WATCH_METRICS_PATH,
        headers: serviceAuthHeaders('svc-agents', BOOT_INTERNAL_SECRET),
      });
      expect(signed.statusCode).not.toBe(401);
      expect(signed.statusCode).not.toBe(404);
    });

    it('registers the shared registrar and defines no second handler', async () => {
      expect(one('registerSubscriptionCycleRoutes').args[0]).toBe(app);
      const unsigned = await app.inject({
        method: 'POST',
        url: '/internal/jobs/run-due-subscriptions',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(unsigned.statusCode).toBe(401);
      const payload = JSON.stringify({});
      const res = await app.inject({ method: 'POST', url: '/internal/jobs/run-due-subscriptions', headers: service(payload), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('pay.due_subscriptions_batch_limit_unset');
    });

    it('the job does not post, and index mounts the shared registrar', async () => {
      expect(one('registerCaptureReconcileRoutes').args[0]).toBe(app);
      expect(argOf('registerCaptureReconcileRoutes', 1)).toMatchObject({ mode: 'off', pay: one('PayService').result });
      const payload = JSON.stringify({ limit: 5 });
      const unsigned = await app.inject({
        method: 'POST',
        url: '/internal/jobs/reconcile-authorized-captures',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(unsigned.statusCode).toBe(401);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/jobs/reconcile-authorized-captures',
        headers: service(payload),
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('pay.capture_reconcile_disabled');
    });

    it('hands the edge trust settings to the tRPC edge context and the merchant REST door', async () => {
      const trpc = (headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: '/trpc/merchantOps.team.list?input=%7B%22limit%22%3A1%7D', headers });
      const rest = (headers: Record<string, string>) => app.inject({ method: 'GET', url: `/v1/payments/${USER}`, headers });
      for (const door of [trpc, rest]) {
        expect((await door({})).statusCode).toBe(401);
        expect((await door(foreignSigned())).statusCode).toBe(401);
        expect((await door(edgeSigned())).statusCode).not.toBe(401);
        expect((await door(secretSigned())).statusCode).not.toBe(401);
      }
    });
  });

  describe('logs and timers', () => {
    it('the alert event is the active span event, and index wires the log listener', () => {
      expect(seen.of('onCapturedOverCap')).toHaveLength(1);
      const signal = { paymentId: 'pay-1', merchantId: 'mer-1', assetCode: 'USDT', amount: '10', exceeded: ['daily_intake'] };
      emitCapturedOverCap(signal);
      expect(warnings()).toContainEqual(
        expect.objectContaining({ event: 'payment.captured_over_cap', ...signal, msg: 'payment.captured_over_cap' }),
      );
      for (const setter of ['setOverCapNoticeLogger', 'setCaptureReconcileLogger']) expect(seen.of(setter), setter).toHaveLength(1);
    });

    it('index.ts starts the job and env.ts has no default for either setting', () => {
      expect(one('startPayoutReconciler').args.slice(0, 3)).toEqual([
        argOf('PayService', 0),
        one('PayService').result,
        { intervalMs: undefined, batchLimit: undefined },
      ]);
      expect(one('startPayoutReconciler').result).toBeNull();
      expect(warnings()).toContainEqual(
        expect.objectContaining({ code: 'pay.payout_reconcile_interval_unset', msg: expect.stringMatching(/^payout reconciler off: /) }),
      );
    });

    it('drains merchant webhooks 25 at a time and says once that no retry policy is set', async () => {
      const webhooks = one('MerchantWebhookService').result as { processDue: (limit: number) => Promise<{ paused?: string }> };
      const due = vi.spyOn(webhooks, 'processDue');
      try {
        const drain = intervals.find((i) => i.ms === 15_000);
        expect(drain).toBeDefined();
        drain!.run();
        drain!.run();
        await vi.waitFor(() => expect(due.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(due.mock.calls.every((call) => call.length === 1 && call[0] === 25)).toBe(true);
        await vi.waitFor(() =>
          expect(warnings().filter((w) => w.msg === 'merchant webhooks: no retry policy set, nothing is sent')).toHaveLength(1),
        );
      } finally {
        due.mockRestore();
      }
    });

    it('starts the hold sweep on the 5-minute timer and keeps the founder trigger', async () => {
      const conversion = one('ConversionService').result as {
        sweepOrphanHolds: (trigger: string) => Promise<unknown>;
        sweepLateFills: (trigger: string) => Promise<unknown>;
      };
      const sweep = vi.spyOn(conversion, 'sweepOrphanHolds').mockResolvedValue(undefined);
      const lateFills = vi.spyOn(conversion, 'sweepLateFills').mockResolvedValue({ errors: [] });
      try {
        const holdSweep = intervals.filter((i) => i.ms === CONVERSION_HOLD_SWEEP_MS);
        expect(holdSweep).toHaveLength(1);
        holdSweep[0]!.run();
        expect(sweep.mock.calls).toEqual([['hold-sweep']]);
        timers.holdSweep = holdSweep[0]!.handle;
        // The late-fill sweep is the one tick on its own timer that asks conversion for late fills.
        for (const tick of intervals.filter((i) => i.ms === CONVERSION_LATE_FILL_TICK_MS)) {
          const before = lateFills.mock.calls.length;
          tick.run();
          if (lateFills.mock.calls.length > before) {
            expect(timers.lateFillSweep).toBeUndefined();
            timers.lateFillSweep = tick.handle;
          }
        }
        expect(lateFills.mock.calls).toEqual([['late-fill-sweep']]);
        expect(sweep.mock.calls).toEqual([['hold-sweep']]);
      } finally {
        sweep.mockRestore();
        lateFills.mockRestore();
      }
    });

    it('stops both conversion timers on shutdown', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        expect(shutdown).toBeDefined();
        process.removeListener('SIGTERM', shutdown!);
        const stop = shutdown!;
        shutdown = undefined;
        stop();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 20_000 });
      } finally {
        exit.mockRestore();
      }
      expect(timers.holdSweep).toBeDefined();
      expect(timers.lateFillSweep).toBeDefined();
      expect(cleared).toContain(timers.holdSweep);
      expect(cleared).toContain(timers.lateFillSweep);
    });
  });
});

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFounderAuthority } from '../founder-authority.js';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { loadHaltAutoTripConfig } from '../halts/config.js';
import { PayHaltStore } from '../halts/store.js';
import { createPayNamespaces } from './index.js';
import { loadTreasuryLimits } from '../treasury/config.js';
import { UNWIRED_CONVERSION_INVENTORY } from '../treasury/exposure.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_payhalts_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const founderA = id();
const founderB = id();
const OPERATOR_REASON = 'secret-operator-note: venue X is being investigated';
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const principalFor = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: [...SESSION_SCOPES],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});
const ctxOf = (principal: Principal | null, service: string | null = null): Context => ({
  principal,
  service,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: principal ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});
/** Identity answers "enabled" only for the founders listed. */
const fetcherFor = (founders: string[]) =>
  vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { userId: string };
    const enabled = founders.includes(body.userId);
    if (!enabled) return new Response('{}', { status: 403 });
    return new Response(
      JSON.stringify({ result: { data: { status: 'enabled', userId: body.userId, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  });

type Callable = (input?: unknown) => Promise<any>;
const at = (caller: unknown, path: string): Callable =>
  path.split('.').reduce((node, key) => (node as Record<string, unknown>)[key], caller) as Callable;

describe('payHalts.* with a real halt store', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  const store = (knownRails: { has(railId: string): boolean } = { has: () => false }) =>
    new PayHaltStore(sql, loadHaltAutoTripConfig({}), knownRails);
  const router = (fetcher: typeof fetch, knownRails?: { has(railId: string): boolean }) =>
    createPayNamespaces({
      founderAuthority: createFounderAuthority({ ...identity, fetcher }),
      payHalts: { store: knownRails ? store(knownRails) : store(), merchants: pay },
    });

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), { payoutDestinations: memoryPayoutDestinations() });
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.halts, pay.halt_events, pay.halt_clear_requests, pay.halt_failure_streaks, pay.halt_autotrip_window, pay.halt_autotrip_counted, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const setBody = (over: Record<string, unknown> = {}) => ({
    requestId: id(),
    scope: 'payout',
    target: { level: 'global' },
    halted: true,
    reason: OPERATOR_REASON,
    expectedVersion: '0',
    ...over,
  });
  const founderOnly = ['payHalts.set', 'payHalts.history', 'payHalts.operatorStatus', 'payHalts.pendingClears'] as const;
  const inputFor = (path: string) =>
    path === 'payHalts.set' ? setBody() : path === 'payHalts.history' || path === 'payHalts.pendingClears' ? { limit: 10 } : undefined;
  const haltRows = async () => (await sql`SELECT scope FROM pay.halts`).length;

  describe('G1-G3: set, history and operatorStatus are founder-only', () => {
    it('G1: a merchant session with MFA but no founder entitlement is refused and nothing is written', async () => {
      const merchantUser = id();
      const fetcher = fetcherFor([founderA]);
      const caller = router(fetcher).createCaller(ctxOf(principalFor(merchantUser)));
      for (const path of founderOnly) await expect(at(caller, path)(inputFor(path))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await haltRows()).toBe(0);
      expect((await sql`SELECT 1 FROM pay.halt_events`).length).toBe(0);
    });

    it('G2: an ifc_ API key (even a founder holder with admin scopes) is refused before identity is asked', async () => {
      const fetcher = fetcherFor([founderA]);
      const caller = router(fetcher).createCaller(
        ctxOf(principalFor(founderA, { kid: id(), scopes: ['admin:read', 'admin:write', 'admin:compliance'] })),
      );
      for (const path of founderOnly) await expect(at(caller, path)(inputFor(path))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await haltRows()).toBe(0);
    });

    it('G3: admin scopes without a founder entitlement are refused; so are no-MFA founders, sub-accounts and service calls', async () => {
      const fetcher = fetcherFor([founderA]);
      const r = router(fetcher);
      const refused = [
        ctxOf(principalFor(id(), { scopes: ['admin:read', 'admin:write', 'admin:compliance'] })),
        ctxOf(principalFor(founderA, { mfa: false })),
        ctxOf(principalFor(founderA, { sub_account: id() } as Partial<Principal>)),
        ctxOf(principalFor(founderA), 'svc-admin'),
      ];
      for (const ctx of refused)
        for (const path of founderOnly)
          await expect(at(r.createCaller(ctx), path)(inputFor(path))).rejects.toMatchObject({
            code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED/),
          });
      expect(await haltRows()).toBe(0);
    });

    it('a founder sets in one call; clearing takes two distinct founders through the router; history carries both', async () => {
      const r = router(fetcherFor([founderA, founderB]));
      const a = r.createCaller(ctxOf(principalFor(founderA)));
      const b = r.createCaller(ctxOf(principalFor(founderB)));
      const set = await a.payHalts.set(setBody() as never);
      expect(set).toMatchObject({ outcome: 'changed', state: { halted: true, source: 'operator', actorUserId: founderA, version: '1' } });

      const clear = setBody({ halted: false, expectedVersion: '1', reason: 'rail repaired' });
      expect((await a.payHalts.set(clear as never)).outcome).toBe('pending_confirmation');
      expect((await a.payHalts.set(clear as never)).outcome).toBe('pending_confirmation');
      expect((await b.payHalts.set(clear as never)).outcome).toBe('changed');

      const history = await a.payHalts.history({ limit: 10 });
      expect(history.map((e) => [e.halted, e.actorUserId, e.confirmedByUserId])).toEqual([
        [false, founderA, founderB],
        [true, founderA, null],
      ]);
      const operator = await a.payHalts.operatorStatus();
      expect(operator.autoTrip).toEqual({ enabled: false, consecutiveFailures: null });
      expect(operator.states.find((s) => s.scope === 'payout')).toMatchObject({ halted: false, version: '2' });
    });

    it('refuses a user or rail halt off payout, refuses an unknown rail, and accepts a payout rail', async () => {
      const known = { has: (railId: string) => railId === 'crypto-native' };
      const caller = router(fetcherFor([founderA]), known).createCaller(ctxOf(principalFor(founderA)));
      const refused = async (body: Record<string, unknown>) =>
        caller.payHalts.set(setBody(body) as never).then(
          () => null,
          (e: unknown) => e as { code: string; message: string },
        );
      const user = { level: 'user', userId: founderA };
      for (const scope of ['intake', 'settlement', 'conversion'] as const) {
        expect(await refused({ scope, target: user })).toMatchObject({ code: 'BAD_REQUEST', message: 'pay.halt_target_unsupported' });
        expect(await refused({ scope, target: { level: 'rail', railId: 'crypto-native' } })).toMatchObject({
          code: 'BAD_REQUEST',
          message: 'pay.halt_target_unsupported',
        });
      }
      expect(await refused({ scope: 'payout', target: { level: 'rail', railId: 'missing-rail' } })).toMatchObject({
        code: 'NOT_FOUND',
        message: 'pay.halt_target_unknown_rail',
      });
      const set = await caller.payHalts.set(setBody({ scope: 'payout', target: { level: 'rail', railId: 'crypto-native' } }) as never);
      expect(set).toMatchObject({ outcome: 'changed', state: { halted: true, target: { level: 'rail', railId: 'crypto-native' } } });
      const userSet = await caller.payHalts.set(setBody({ scope: 'payout', target: user }) as never);
      expect(userSet).toMatchObject({ outcome: 'changed', state: { halted: true, target: { level: 'user', userId: founderA } } });
      expect(await sql`SELECT target FROM pay.halts WHERE scope <> 'payout'`).toHaveLength(0);
    });

    it('pendingClears names the founder who proposed, pages by request id, and drops a clear once it is confirmed or expired', async () => {
      const r = router(fetcherFor([founderA, founderB]));
      const a = r.createCaller(ctxOf(principalFor(founderA)));
      const b = r.createCaller(ctxOf(principalFor(founderB)));
      const scopes = ['intake', 'payout', 'settlement'] as const;
      const ids: string[] = [];
      for (const scope of scopes) {
        await a.payHalts.set(setBody({ scope, halted: true, expectedVersion: '0' }) as never);
        const requestId = id();
        ids.push(requestId);
        expect(
          (await a.payHalts.set(setBody({ scope, requestId, halted: false, expectedVersion: '1', reason: 'rail repaired' }) as never))
            .outcome,
        ).toBe('pending_confirmation');
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let n = 0; n < 5; n += 1) {
        const page = await a.payHalts.pendingClears({ limit: 1, ...(cursor ? { cursor } : {}) });
        expect(page.proposals.length).toBeLessThanOrEqual(1);
        if (page.proposals[0]) expect(page.proposals[0].requestedByUserId).toBe(founderA);
        seen.push(...page.proposals.map((p) => p.requestId));
        if (!page.nextCursor) break;
        expect(page.nextCursor).not.toBe(cursor);
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual([...ids].sort());

      expect(
        (
          await b.payHalts.set(
            setBody({ scope: 'intake', requestId: ids[0], halted: false, expectedVersion: '1', reason: 'rail repaired' }) as never,
          )
        ).outcome,
      ).toBe('changed');
      const expiredId = ids[1];
      if (expiredId === undefined) throw new Error('expected a second clear proposal');
      await sql`UPDATE pay.halt_clear_requests SET requested_at = now() - interval '2 hours' WHERE request_id = ${expiredId}`;
      const live = await a.payHalts.pendingClears({ limit: 10 });
      expect(live.proposals.map((p) => p.requestId)).toEqual([ids[2]]);
      expect(live.nextCursor).toBeNull();
    });

    it('pendingClears omits a proposal whose expected version no longer matches the halt', async () => {
      const r = router(fetcherFor([founderA, founderB]));
      const a = r.createCaller(ctxOf(principalFor(founderA)));
      const requestId = id();
      await a.payHalts.set(setBody({ scope: 'intake', halted: true, expectedVersion: '0' }) as never);
      expect(
        (
          await a.payHalts.set(
            setBody({ scope: 'intake', requestId, halted: false, expectedVersion: '1', reason: 'rail repaired' }) as never,
          )
        ).outcome,
      ).toBe('pending_confirmation');
      expect((await a.payHalts.pendingClears({ limit: 10 })).proposals.map((p) => p.requestId)).toEqual([requestId]);
      await sql`UPDATE pay.halts SET version = version + 1 WHERE scope = 'intake' AND target = 'global'`;
      const [still] = await sql<Array<{ status: string; expected_version: string }>>`
        SELECT status, expected_version FROM pay.halt_clear_requests WHERE request_id = ${requestId}
      `;
      expect(still).toMatchObject({ status: 'pending' });
      expect((await a.payHalts.pendingClears({ limit: 10 })).proposals).toEqual([]);
    });
  });

  describe('merchant status read', () => {
    it('shows only the merchant-safe shape: no reason, no actor, no source, no version', async () => {
      const owner = id();
      const m = await pay.createMerchant({ userId: owner, pricing: { feeBps: 0 } });
      const r = router(fetcherFor([founderA]));
      await r.createCaller(ctxOf(principalFor(founderA))).payHalts.set(setBody({ scope: 'intake' }) as never);
      await r
        .createCaller(ctxOf(principalFor(founderA)))
        .payHalts.set(setBody({ scope: 'payout', target: { level: 'merchant', merchantId: m.id } }) as never);

      const merchantCaller = r.createCaller(ctxOf(principalFor(owner, { scopes: ['pay:read'], mfa: false })));
      const status = await merchantCaller.payHalts.status({ merchantId: m.id });
      expect(status.readable).toBe(true);
      expect(status.states.find((s) => s.scope === 'intake' && s.target.level === 'global')).toMatchObject({ halted: true });
      expect(status.states.find((s) => s.scope === 'payout' && s.target.level === 'merchant')).toMatchObject({ halted: true });
      expect(status.states.find((s) => s.scope === 'conversion' && s.target.level === 'global')).toMatchObject({
        halted: false,
        changedAt: null,
      });
      for (const state of status.states) expect(Object.keys(state).sort()).toEqual(['changedAt', 'halted', 'scope', 'target']);
      const wire = JSON.stringify(status);
      for (const leak of [
        OPERATOR_REASON,
        'secret-operator-note',
        founderA,
        'operator',
        'auto_trip',
        '"version"',
        'actorUserId',
        'source',
        'reason',
      ]) {
        expect(wire).not.toContain(leak);
      }
      // Without a merchant id: the global switches only.
      const global = await merchantCaller.payHalts.status({});
      expect(global.states.every((s) => s.target.level === 'global')).toBe(true);
    });

    it('another merchant, and a merchant id that does not exist, get the same refusal', async () => {
      const m = await pay.createMerchant({ userId: id(), pricing: { feeBps: 0 } });
      const stranger = router(fetcherFor([])).createCaller(ctxOf(principalFor(id(), { scopes: ['pay:read'], mfa: false })));
      const other = await stranger.payHalts.status({ merchantId: m.id }).then(
        () => null,
        (e: unknown) => e as { code: string; message: string; cause?: { code?: string } },
      );
      const missing = await stranger.payHalts.status({ merchantId: id() }).then(
        () => null,
        (e: unknown) => e as { code: string; message: string; cause?: { code?: string } },
      );
      expect(other).not.toBeNull();
      expect(other).toMatchObject({ code: 'FORBIDDEN', message: 'pay.merchant_forbidden' });
      expect(missing).toMatchObject({ code: other!.code, message: other!.message });
    });

    it('an unreadable store reports readable:false with every scope halted, never "all clear"', async () => {
      const r = router(fetcherFor([]));
      await sql`ALTER TABLE pay.halts RENAME TO halts_offline`;
      try {
        const status = await r.createCaller(ctxOf(principalFor(id(), { scopes: ['pay:read'], mfa: false }))).payHalts.status({});
        expect(status.readable).toBe(false);
        expect(status.states).toHaveLength(4);
        expect(status.states.every((s) => s.halted)).toBe(true);
      } finally {
        await sql`ALTER TABLE pay.halts_offline RENAME TO halts`;
      }
    });
  });

  describe('founderAdmin.treasury.exposure', () => {
    it('is founder-only and reads exposure per asset, with a missing limit shown as null', async () => {
      await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status) VALUES ('u1', 'USDT', 4, 'crypto-native', '{}'::jsonb, 'c1', 'held')`;
      const fetcher = fetcherFor([founderA]);
      const r = createPayNamespaces({
        founderAuthority: createFounderAuthority({ ...identity, fetcher }),
        treasury: {
          sql,
          limits: loadTreasuryLimits({ PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ EUR: '50' }) }),
          inventory: UNWIRED_CONVERSION_INVENTORY,
        },
      });
      const result = await r.createCaller(ctxOf(principalFor(founderA))).founderAdmin.treasury.exposure({});
      expect(result.perAsset).toEqual([
        { assetCode: 'EUR', openConversionInventory: null, pendingPayouts: '0', limit: '50' },
        { assetCode: 'USDT', openConversionInventory: null, pendingPayouts: '4', limit: null },
      ]);
      await expect(r.createCaller(ctxOf(principalFor(id()))).founderAdmin.treasury.exposure({})).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});

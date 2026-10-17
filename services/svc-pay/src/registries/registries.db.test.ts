import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stubApprovalConsumer, unwiredApprovalConsumer, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { createRegistryReader } from './read-api.js';
import { KNOWN_VENUE_KEYS } from './service.js';

/**
 * The registries against a real Postgres: every forward migration, including
 * 0069 and 0070, the real router and service, the real reader. Same arrangement
 * as the other svc-pay db suites: `TEST_DATABASE_URL`, or a Testcontainer when
 * it is unset.
 */
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
    .withDatabase('intafaced_registries_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const SECOND = 'founder-b';
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

type Err = { code: string; cause?: { code?: string } };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

describe('venue, network and wallet-route registries', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let approver: string | null = SECOND;
  let consumed: ActionApprovalConsumeInput[] = [];

  const approvals: ActionApprovalConsumer = {
    async consume(input) {
      consumed.push(input);
      if (approver === null) return unwiredApprovalConsumer().consume(input);
      return stubApprovalConsumer(approver).consume(input);
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const reg = () => api.founderAdmin.registries;
  const approval = { approvalId: 'appr-1', operationId: 'op-1' };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({ founderAuthority: async () => FOUNDER, registries: { sql: db.sql, approvals } });
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = ns.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    approver = SECOND;
    consumed = [];
    await db.sql.unsafe(`ALTER TABLE pay.registry_events DISABLE TRIGGER registry_events_append_only_trg`);
    await db.sql.unsafe(
      `TRUNCATE pay.registry_events, pay.wallet_routes, pay.network_registry, pay.venue_registry RESTART IDENTITY CASCADE`,
    );
    await db.sql.unsafe(`ALTER TABLE pay.registry_events ENABLE TRIGGER registry_events_append_only_trg`);
  });

  const venue = (o: Record<string, unknown> = {}) => ({
    venueId: 'binance-spot',
    displayName: 'Binance Spot',
    mode: 'testnet',
    priority: 1,
    enabled: false,
    minOrder: '10',
    maxOrder: '1000',
    supportedPairs: ['USDT/USD'],
    expectedVersion: null,
    reason: 'initial entry',
    ...o,
  });
  const network = (o: Record<string, unknown> = {}) => ({
    networkId: 'ethereum',
    displayName: 'Ethereum',
    assetCodes: ['USDT'],
    confirmationsRequired: 12,
    enabled: false,
    feeEstimateSource: 'venue_quote',
    feeEstimateAmount: null,
    expectedVersion: null,
    reason: 'initial entry',
    ...o,
  });
  const route = (o: Record<string, unknown> = {}) => ({
    assetCode: 'USDT',
    networkId: 'ethereum',
    payoutAllowed: false,
    merchantAllow: [],
    merchantDeny: [],
    maxSinglePayout: '500',
    expectedVersion: null,
    reason: 'initial entry',
    ...o,
  });

  const events = () => db.sql<Array<Record<string, any>>>`SELECT * FROM pay.registry_events ORDER BY seq`;

  describe('schema', () => {
    it('holds no credential column anywhere, and refuses live and unconfigured states at the database too', async () => {
      const cols = await db.sql<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'pay' AND table_name IN ('venue_registry', 'network_registry', 'wallet_routes', 'registry_events')`;
      expect(cols.length).toBeGreaterThan(20);
      expect(cols.filter((c) => /secret|api_?key|token|password|credential|passphrase|private|address/i.test(c.column_name))).toEqual([]);

      await expect(
        db.sql`INSERT INTO pay.venue_registry (venue_id, display_name, mode, priority, updated_by) VALUES ('binance-spot', 'x', 'live', 1, 'f')`,
      ).rejects.toMatchObject({ constraint_name: 'venue_registry_mode_no_live' });
      await expect(
        db.sql`INSERT INTO pay.venue_registry (venue_id, display_name, mode, priority, enabled, updated_by) VALUES ('binance-spot', 'x', 'disabled', 1, true, 'f')`,
      ).rejects.toMatchObject({ constraint_name: 'venue_registry_enabled_needs_testnet' });
      await expect(
        db.sql`INSERT INTO pay.venue_registry (venue_id, display_name, mode, priority, min_order, updated_by) VALUES ('binance-spot', 'x', 'testnet', 1, '1e3', 'f')`,
      ).rejects.toMatchObject({ constraint_name: 'venue_registry_min_order_decimal' });
      await expect(
        db.sql`INSERT INTO pay.network_registry (network_id, display_name, fee_estimate_source, updated_by) VALUES ('eth', 'E', 'fixed', 'f')`,
      ).rejects.toMatchObject({ constraint_name: 'network_registry_fixed_fee_has_amount' });
    });

    it('seeds nothing: a fresh database has no venue, network or route', async () => {
      const [counted] = await db.sql<Array<{ n: number }>>`
        SELECT (SELECT count(*) FROM pay.venue_registry) + (SELECT count(*) FROM pay.network_registry) + (SELECT count(*) FROM pay.wallet_routes) AS n`;
      expect(Number(counted?.n)).toBe(0);
    });

    it('the audit trail is append-only', async () => {
      await reg().venues.save(venue());
      await expect(db.sql`UPDATE pay.registry_events SET reason = 'edited'`).rejects.toMatchObject({ code: '23001' });
      await expect(db.sql`DELETE FROM pay.registry_events`).rejects.toMatchObject({ code: '23001' });
    });
  });

  describe('venues', () => {
    it('creates an entry switched off, audited with the founder id and the whole after-state', async () => {
      const saved = await reg().venues.save(venue());
      expect(saved).toMatchObject({
        venueId: 'binance-spot',
        enabled: false,
        version: 1,
        updatedBy: FOUNDER,
        routable: false,
        health: null,
      });
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        registry: 'venue',
        entry_key: 'binance-spot',
        action: 'create',
        actor_id: FOUNDER,
        approver_id: null,
        dual_control: false,
        before: null,
      });
      expect(rows[0]!.after).toMatchObject({ venueId: 'binance-spot', minOrder: '10', maxOrder: '1000', enabled: false });
      expect(consumed).toEqual([]);
    });

    it('refuses to create an entry already switched on', async () => {
      const e = await refused(reg().venues.save(venue({ enabled: true })));
      expect(e.cause?.code).toBe('registries.create_must_be_inert');
      expect(await events()).toHaveLength(0);
    });

    it('refuses live mode with a typed error: on create, on edit and in a preview, and writes nothing', async () => {
      const onCreate = await refused(reg().venues.save(venue({ mode: 'live' })));
      expect(onCreate).toMatchObject({ code: 'FORBIDDEN' });
      expect(onCreate.cause?.code).toBe('registries.live_mode_refused');

      const saved = await reg().venues.save(venue());
      const onEdit = await refused(reg().venues.save(venue({ mode: 'live', expectedVersion: saved.version, ...approval })));
      expect(onEdit.cause?.code).toBe('registries.live_mode_refused');
      const inPreview = await refused(reg().preview({ registry: 'venue', change: venue({ mode: 'live', expectedVersion: 1 }) }));
      expect(inPreview.cause?.code).toBe('registries.live_mode_refused');
      const enabledLive = await refused(reg().venues.save(venue({ mode: 'live', enabled: true, expectedVersion: 1 })));
      expect(enabledLive.cause?.code).toBe('registries.live_mode_refused');

      expect(consumed).toEqual([]);
      expect(await events()).toHaveLength(1);
      const [stored] = await db.sql<Array<{ mode: string }>>`SELECT mode FROM pay.venue_registry`;
      expect(stored?.mode).toBe('testnet');
    });

    it('refuses an id that is not a venue-adapter key, and enabling a non-testnet venue', async () => {
      expect((await refused(reg().venues.save(venue({ venueId: 'made-up-venue' })))).cause?.code).toBe('registries.venue_unknown');
      const saved = await reg().venues.save(venue({ mode: 'disabled' }));
      const e = await refused(reg().venues.save(venue({ mode: 'disabled', enabled: true, expectedVersion: saved.version })));
      expect(e.cause?.code).toBe('registries.enabled_needs_testnet');
    });

    it('the known venue keys mirror the venue-adapter factory list', () => {
      const src = readFileSync(
        join(here, '..', '..', '..', '..', 'packages', 'venue-adapter', 'src', 'fabric', 'venues', 'factory.ts'),
        'utf8',
      );
      const literal = /PUBLIC_MARKET_DATA_VENUE_IDS = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
      const ids = [...literal.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      expect([...KNOWN_VENUE_KEYS].sort()).toEqual([...ids].sort());
    });

    it('refuses an inverted min and max', async () => {
      const e = await refused(reg().venues.save(venue({ minOrder: '2000', maxOrder: '1000' })));
      expect(e.cause?.code).toBe('registries.limits_inverted');
    });

    it('enabling needs a second founder; each refusal is typed and nothing changes', async () => {
      const v = await reg().venues.save(venue());
      const enable = venue({ enabled: true, expectedVersion: v.version, reason: 'go to testnet' });

      const none = await refused(reg().venues.save(enable));
      expect(none).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(none.cause?.code).toBe('action_approval.missing');

      approver = null; // identity not wired: nobody can approve
      const unwired = await refused(reg().venues.save({ ...enable, ...approval }));
      expect(unwired.cause?.code).toBe('action_approval.identity_unwired');

      approver = FOUNDER; // the approver is the requester
      const same = await refused(reg().venues.save({ ...enable, ...approval }));
      expect(same).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(same.cause?.code).toBe('missing_operator');

      expect((await db.sql`SELECT enabled FROM pay.venue_registry`)[0]!.enabled).toBe(false);
      expect(await events()).toHaveLength(1);

      approver = SECOND;
      const done = await reg().venues.save({ ...enable, ...approval });
      expect(done).toMatchObject({ enabled: true, version: 2, routable: true });
      const rows = await events();
      expect(rows.at(-1)).toMatchObject({ action: 'update', actor_id: FOUNDER, approver_id: SECOND, dual_control: true });
      expect(rows.at(-1)!.before).toMatchObject({ enabled: false });
      expect(rows.at(-1)!.after).toMatchObject({ enabled: true });
    });

    it('the approval is bound to the exact change: the consumed hash equals the preview hash, and a different change has a different hash', async () => {
      const v = await reg().venues.save(venue());
      const enable = venue({ enabled: true, expectedVersion: v.version });
      const preview = await reg().preview({ registry: 'venue', change: enable });
      expect(preview).toMatchObject({ needsDualControl: true, reasons: ['enabled'], actionType: 'pay.registry_change' });
      const other = await reg().preview({ registry: 'venue', change: { ...enable, maxOrder: '999' } });
      expect(other.payloadHash).not.toBe(preview.payloadHash);
      await reg().venues.save({ ...enable, ...approval });
      expect(consumed).toHaveLength(1);
      expect(consumed[0]).toMatchObject({ payloadHash: preview.payloadHash, targetId: 'pay.registry_change', targetService: 'svc-pay' });
    });

    it('disabling needs a second founder too, then loosening needs one and tightening does not', async () => {
      const v = await reg().venues.save(venue());
      await reg().venues.save({ ...venue({ enabled: true, expectedVersion: v.version }), ...approval });
      consumed = [];

      // tightening, renaming, re-ordering: single founder
      const tightened = await reg().venues.save(
        venue({
          enabled: true,
          expectedVersion: 2,
          maxOrder: '900',
          minOrder: '20',
          displayName: 'Binance',
          priority: 5,
          reason: 'tighten',
        }),
      );
      expect(tightened.version).toBe(3);
      expect(consumed).toEqual([]);

      // loosening while enabled: refused alone
      const loosen = venue({
        enabled: true,
        expectedVersion: 3,
        maxOrder: '5000',
        minOrder: '20',
        displayName: 'Binance',
        priority: 5,
        reason: 'raise cap',
      });
      expect((await refused(reg().venues.save(loosen))).cause?.code).toBe('action_approval.missing');
      expect((await reg().venues.save({ ...loosen, ...approval })).maxOrder).toBe('5000');

      // disabling: refused alone, allowed with a second founder
      const disable = venue({
        enabled: false,
        expectedVersion: 4,
        maxOrder: '5000',
        minOrder: '20',
        displayName: 'Binance',
        priority: 5,
        reason: 'pause',
      });
      expect((await refused(reg().venues.save(disable))).cause?.code).toBe('action_approval.missing');
      expect((await reg().venues.save({ ...disable, ...approval })).enabled).toBe(false);
    });

    it('lists blank limits as not routable with what is missing, and a stale version conflicts', async () => {
      const v = await reg().venues.save(venue({ minOrder: null, maxOrder: null, supportedPairs: [] }));
      expect(v).toMatchObject({ routable: false, missing: ['min_order', 'max_order', 'supported_pairs'] });
      expect((await refused(reg().venues.save(venue({ expectedVersion: 7 })))).cause?.code).toBe('registries.version_conflict');
      expect((await refused(reg().venues.save(venue()))).cause?.code).toBe('registries.already_exists');
      expect((await refused(reg().venues.save(venue({ venueId: 'okx-spot', expectedVersion: 1 })))).cause?.code).toBe(
        'registries.not_found',
      );
    });

    it('passes venue health through when a provider is wired, and says unknown (null) when not', async () => {
      const listed = await reg().venues.list({});
      expect(listed).toEqual([]);
      await reg().venues.save(venue());
      expect((await reg().venues.list({}))[0].health).toBeNull();
    });
  });

  describe('networks and wallet routes', () => {
    it('a fixed fee source needs its amount; blank fee source is not routable', async () => {
      const n = await reg().networks.save(network({ feeEstimateSource: null }));
      expect(n).toMatchObject({ routable: false, missing: ['fee_estimate_source'] });
      const fixed = await refused(reg().networks.save(network({ networkId: 'tron', feeEstimateSource: 'fixed', feeEstimateAmount: null })));
      expect(fixed.code).toBe('BAD_REQUEST');
    });

    it('enable and disable need a second founder; lowering confirmations on an enabled network does too', async () => {
      const n = await reg().networks.save(network());
      const enable = network({ enabled: true, expectedVersion: n.version });
      expect((await refused(reg().networks.save(enable))).cause?.code).toBe('action_approval.missing');
      expect((await reg().networks.save({ ...enable, ...approval })).routable).toBe(true);
      const lower = network({ enabled: true, expectedVersion: 2, confirmationsRequired: 6 });
      expect((await refused(reg().networks.save(lower))).cause?.code).toBe('action_approval.missing');
      expect((await reg().networks.save({ ...lower, ...approval })).confirmationsRequired).toBe(6);
      const rows = await events();
      expect(rows.map((r) => [r.registry, r.entry_key, r.dual_control])).toEqual([
        ['network', 'ethereum', false],
        ['network', 'ethereum', true],
        ['network', 'ethereum', true],
      ]);
    });

    it('a wallet route needs a known network that lists the asset', async () => {
      expect((await refused(reg().walletRoutes.save(route()))).cause?.code).toBe('registries.network_unknown');
      await reg().networks.save(network());
      expect((await refused(reg().walletRoutes.save(route({ assetCode: 'DAI' })))).cause?.code).toBe('registries.asset_not_on_network');
      expect(await reg().walletRoutes.save(route())).toMatchObject({ payoutAllowed: false, routable: false, assetCode: 'USDT' });
    });

    it('allowing payouts, widening the allow list and shortening the deny list need a second founder', async () => {
      await reg().networks.save(network());
      const r = await reg().walletRoutes.save(route());
      const allow = route({ payoutAllowed: true, expectedVersion: r.version, merchantDeny: [MERCHANT] });
      expect((await refused(reg().walletRoutes.save(allow))).cause?.code).toBe('action_approval.missing');
      await reg().walletRoutes.save({ ...allow, ...approval });
      const shorter = route({ payoutAllowed: true, expectedVersion: 2, merchantDeny: [] });
      expect((await refused(reg().walletRoutes.save(shorter))).cause?.code).toBe('action_approval.missing');
      const raised = route({ payoutAllowed: true, expectedVersion: 2, merchantDeny: [MERCHANT], maxSinglePayout: '501' });
      expect((await refused(reg().walletRoutes.save(raised))).cause?.code).toBe('action_approval.missing');
      const tightened = route({ payoutAllowed: true, expectedVersion: 2, merchantDeny: [MERCHANT, OTHER], maxSinglePayout: '100' });
      expect((await reg().walletRoutes.save(tightened)).version).toBe(3);
    });

    it('history lists the audit trail for an entry, newest first', async () => {
      await reg().networks.save(network());
      await reg().networks.save({ ...network({ displayName: 'Ethereum L1', expectedVersion: 1 }) });
      const h = await reg().history({ registry: 'network', entryKey: 'ethereum', limit: 10 });
      expect(h.map((e: { action: string }) => e.action)).toEqual(['update', 'create']);
      expect(h[0]).toMatchObject({ actorId: FOUNDER, dualControl: false });
      expect(await reg().history({ registry: 'venue', limit: 10 })).toEqual([]);
    });
  });

  describe('read API for internal consumers (W6)', () => {
    it('returns only enabled, fully configured entries, in priority order', async () => {
      const reader = createRegistryReader(db.sql);
      expect(await reader.listRoutableVenues()).toEqual([]);

      const a = await reg().venues.save(venue({ priority: 2 }));
      const b = await reg().venues.save(venue({ venueId: 'bybit-spot', priority: 1, supportedPairs: ['USDT/USD', 'BTC/USDT'] }));
      const c = await reg().venues.save(venue({ venueId: 'okx-spot', priority: 3, minOrder: null }));
      expect(await reader.listRoutableVenues()).toEqual([]); // all still switched off
      for (const [id, v] of [
        ['binance-spot', a],
        ['bybit-spot', b],
        ['okx-spot', c],
      ] as const) {
        await reg().venues.save({
          ...venue({
            venueId: id,
            enabled: true,
            expectedVersion: v.version,
            priority: v.priority,
            minOrder: v.minOrder,
            supportedPairs: v.supportedPairs,
          }),
          ...approval,
        });
      }
      const routable = await reader.listRoutableVenues();
      expect(routable.map((v) => v.venueId)).toEqual(['bybit-spot', 'binance-spot']); // okx has a blank minimum
      expect(routable[0]).not.toHaveProperty('version');

      expect((await reader.venuesFor({ pair: 'BTC/USDT', amount: '50' })).map((v) => v.venueId)).toEqual(['bybit-spot']);
      expect((await reader.venuesFor({ pair: 'USDT/USD', amount: '50' })).map((v) => v.venueId)).toEqual(['bybit-spot', 'binance-spot']);
      expect(await reader.venuesFor({ pair: 'USDT/USD', amount: '9.99' })).toEqual([]);
      expect(await reader.venuesFor({ pair: 'USDT/USD', amount: '1000.000000000000000001' })).toEqual([]);
      expect(await reader.venuesFor({ pair: 'ETH/USD', amount: '50' })).toEqual([]);
    });

    it('evaluates a payout through the registries and refuses every blank', async () => {
      const reader = createRegistryReader(db.sql);
      const ask = { assetCode: 'USDT', networkId: 'ethereum', merchantId: MERCHANT, amount: '100' };
      expect(await reader.evaluatePayout(ask)).toEqual({ allowed: false, code: 'registries.payout_no_route' });

      const n = await reg().networks.save(network({ assetCodes: ['USDT', 'USDC'] }));
      await reg().walletRoutes.save(route({ payoutAllowed: false, maxSinglePayout: null }));
      expect(await reader.evaluatePayout(ask)).toMatchObject({ allowed: false, code: 'registries.payout_network_not_routable' });

      await reg().networks.save({ ...network({ enabled: true, expectedVersion: n.version, assetCodes: ['USDT', 'USDC'] }), ...approval });
      expect(await reader.evaluatePayout(ask)).toMatchObject({ allowed: false, code: 'registries.payout_not_allowed' });

      await reg().walletRoutes.save({ ...route({ payoutAllowed: true, maxSinglePayout: null, expectedVersion: 1 }), ...approval });
      expect(await reader.evaluatePayout(ask)).toMatchObject({ allowed: false, code: 'registries.payout_limit_blank' });
      expect(await reader.listRoutableWalletRoutes()).toEqual([]);

      await reg().walletRoutes.save({ ...route({ payoutAllowed: true, maxSinglePayout: '500', expectedVersion: 2 }), ...approval });
      expect(await reader.evaluatePayout(ask)).toMatchObject({ allowed: true });
      expect(await reader.evaluatePayout({ ...ask, amount: '500.1' })).toMatchObject({ code: 'registries.payout_over_limit' });
      expect((await reader.listRoutableWalletRoutes()).map((r) => r.assetCode)).toEqual(['USDT']);

      // Removing the asset from the network (tightening is single-founder) makes the route unusable at once.
      await reg().networks.save(network({ enabled: true, expectedVersion: 2, assetCodes: ['USDC'] }));
      expect(await reader.evaluatePayout(ask)).toMatchObject({ allowed: false, code: 'registries.payout_asset_not_on_network' });
      expect(await reader.listRoutableWalletRoutes()).toEqual([]);
    });
  });

  describe('no secret reaches the database', () => {
    it('an extra credential field is a parse error and a pasted key in a name or reason is refused; nothing is stored', async () => {
      expect(await refused(reg().venues.save({ ...venue(), apiKey: 'abc' }))).toMatchObject({ code: 'BAD_REQUEST' });
      expect(await refused(reg().venues.save({ ...venue(), secret: 'abc' }))).toMatchObject({ code: 'BAD_REQUEST' });
      expect(await refused(reg().venues.save(venue({ displayName: 'sk_live_51H8abcdEFGH1234' })))).toMatchObject({ code: 'BAD_REQUEST' });
      expect(await refused(reg().venues.save(venue({ reason: 'use key AKIAIOSFODNN7EXAMPLE' })))).toMatchObject({ code: 'BAD_REQUEST' });
      expect(await events()).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM pay.venue_registry`).toHaveLength(0);
    });
  });
});

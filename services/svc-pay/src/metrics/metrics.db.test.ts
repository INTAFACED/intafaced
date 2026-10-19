import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { type Context } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount as amt, type Amount } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { SubMerchantService } from '../submerchants.js';
import { createFounderAuthority } from '../founder-authority.js';
import { createPayNamespaces } from '../namespaces/index.js';
import {
  computeFromSource,
  createMetricsRuntime,
  diffProjections,
  listProjectionKeys,
  listSourceKeys,
  readProjection,
  MetricsProjector,
  type DayProjection,
  type MetricsKey,
  type MetricsRuntime,
} from './index.js';
import type { MerchantDayRow, StatusRow, LinkRow } from './compute.js';

/**
 * W2 acceptance suite for the metrics read model. Postgres is real: the figures
 * are produced by triggers, a dirty log and SQL aggregates, none of which an
 * in-memory fake would have.
 *
 * Same arrangement as the other svc-pay db suites: `TEST_DATABASE_URL`, or a
 * Testcontainer when it is unset. Every forward migration is applied, as in
 * production.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-metrics-test-secret-at-least-32-chars';
const DAY_MS = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_metrics_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

// ── an oracle that shares no code with the SQL it checks ─────────────────────

/**
 * Recomputes every projected figure from the raw source rows with plain loops
 * and bigint. It deliberately does not call `computeFromSource`: if the SQL and
 * the oracle agree, it is because two independent implementations of the same
 * definition agree.
 */
async function oracle(sql: TestDatabase['sql'], only?: string): Promise<DayProjection> {
  const payments = await sql<Array<{ id: string; merchant_id: string; currency: string; status: string; created_at: Date }>>`
    SELECT id, merchant_id, currency, status::text AS status, created_at FROM pay.payments`;
  const events = await sql<Array<{ payment_id: string; event: string; payload: { amount: string }; ts: Date }>>`
    SELECT payment_id, event, payload, ts FROM pay.payment_events WHERE event IN ('captured', 'refunded') ORDER BY seq`;
  const settlements = await sql<
    Array<{ merchant_id: string; asset_id: string; gross: string; fees: string; net: string; status: string; created_at: Date }>
  >`
    SELECT merchant_id, asset_id, gross::text, fees::text, net::text, status::text AS status, created_at FROM pay.settlements`;
  const sessions = await sql<Array<{ payment_id: string | null; link_id: string }>>`SELECT payment_id, link_id FROM pay.checkout_sessions`;

  const byId = new Map(payments.map((p) => [p.id, p]));
  type Mut = { -readonly [K in keyof MerchantDayRow]: MerchantDayRow[K] };
  const rows = new Map<string, Mut>();
  const row = (merchantId: string, day: string, assetCode: string): Mut => {
    const id = `${merchantId}|${day}|${assetCode}`;
    let r = rows.get(id);
    if (!r) {
      r = {
        merchantId,
        day,
        assetCode,
        paymentsCreated: 0,
        captured: 0n,
        capturedCount: 0,
        largestCaptured: 0n,
        refunded: 0n,
        refundedCount: 0,
        settleGross: 0n,
        settleFees: 0n,
        settleNet: 0n,
        settleCount: 0,
        unsettledNet: 0n,
      };
      rows.set(id, r);
    }
    return r;
  };
  const keep = (m: string) => only === undefined || m === only;

  const firstCapture = new Map<string, Date>();
  const capturedBy = new Map<string, Amount>();
  const refundedBy = new Map<string, Amount>();
  for (const e of events) {
    const p = byId.get(e.payment_id)!;
    const a = amt(e.payload.amount);
    if (e.event === 'captured') {
      const first = firstCapture.get(p.id);
      if (!first || e.ts < first) firstCapture.set(p.id, e.ts);
      capturedBy.set(p.id, (capturedBy.get(p.id) ?? 0n) + a);
      if (keep(p.merchant_id)) {
        const r = row(p.merchant_id, dayOf(e.ts), p.currency);
        r.captured += a;
        r.capturedCount += 1;
        if (a > r.largestCaptured) r.largestCaptured = a;
      }
    } else {
      refundedBy.set(p.id, (refundedBy.get(p.id) ?? 0n) + a);
    }
  }
  for (const e of events) {
    if (e.event !== 'refunded') continue;
    const p = byId.get(e.payment_id)!;
    const first = firstCapture.get(p.id);
    if (!first || !keep(p.merchant_id)) continue;
    const r = row(p.merchant_id, dayOf(first), p.currency);
    r.refunded += amt(e.payload.amount);
    r.refundedCount += 1;
  }
  const statuses = new Map<string, StatusRow>();
  const links = new Map<string, LinkRow>();
  const linkOf = new Map(sessions.filter((s) => s.payment_id).map((s) => [s.payment_id!, s.link_id]));
  for (const p of payments) {
    if (!keep(p.merchant_id)) continue;
    const day = dayOf(p.created_at);
    const r = row(p.merchant_id, day, p.currency);
    r.paymentsCreated += 1;
    if (p.status === 'captured') r.unsettledNet += (capturedBy.get(p.id) ?? 0n) - (refundedBy.get(p.id) ?? 0n);
    const sid = `${p.merchant_id}|${day}|${p.status}`;
    const s = statuses.get(sid);
    statuses.set(sid, { merchantId: p.merchant_id, day, status: p.status, payments: (s?.payments ?? 0) + 1 });
    const link = linkOf.get(p.id);
    if (link && capturedBy.has(p.id)) {
      const lid = `${p.merchant_id}|${day}|${link}`;
      const l = links.get(lid);
      links.set(lid, { merchantId: p.merchant_id, day, linkId: link, payments: (l?.payments ?? 0) + 1 });
    }
  }
  for (const s of settlements) {
    if (!keep(s.merchant_id) || !['posted', 'paid_out'].includes(s.status)) continue;
    const r = row(s.merchant_id, dayOf(s.created_at), s.asset_id);
    r.settleGross += amt(s.gross);
    r.settleFees += amt(s.fees);
    r.settleNet += amt(s.net);
    r.settleCount += 1;
  }
  return { days: [...rows.values()], statuses: [...statuses.values()], links: [...links.values()] };
}

async function allKeys(sql: TestDatabase['sql']): Promise<MetricsKey[]> {
  const m = new Map<string, MetricsKey>();
  for (const k of [...(await listSourceKeys(sql)), ...(await listProjectionKeys(sql))]) m.set(`${k.merchantId}|${k.day}`, k);
  return [...m.values()];
}

/** The projection must equal the oracle exactly, in every table. */
async function expectProjectionEqualsSource(sql: TestDatabase['sql']): Promise<void> {
  const projection = await readProjection(sql, await allKeys(sql));
  expect(diffProjections(await oracle(sql), projection)).toEqual([]);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const userOf = () => randomUUID();
const principal = (userId: string, extra: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: randomUUID(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
  ...extra,
});
const ctxOf = (p: Principal | null): Context => ({
  principal: p,
  service: null,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: p ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});

/**
 * 30 s per test, not vitest's 5 s default. Measured on CI (runs 38718530279 to
 * 38737143811): this file takes 3 s on a laptop and 45 to 106 s there, because
 * the pay package runs 145 test files against one Postgres on a shared runner. The
 * seeded-run tests alone took 2.3 to 6.2 s on main before and after the flows were
 * made concurrent, so a 5 s limit failed about one run in five on speed alone.
 *
 * It matters beyond the one red test. vitest does not cancel a test body that has
 * timed out: the seeding and the refreshers keep running while the next test's
 * beforeEach issues its TRUNCATE (ACCESS EXCLUSIVE on the pay tables), and the two
 * deadlock. PR 4784's "deadlock detected" failures were exactly that, the test
 * harness's TRUNCATE against the previous test's leftover transactions, never two
 * product statements against each other. A timeout generous enough not to trip
 * keeps that from starting.
 */
describe('svc-pay metrics read model PG-hard', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let rails: RailRegistry;
  let pay: PayService;
  let trees: SubMerchantService;
  let projector: MetricsProjector;
  let metrics: MetricsRuntime;
  let fraudOpen: (merchantId?: string) => number;
  let clock: Date;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.metrics_merchant_day_link, pay.metrics_merchant_day_status, pay.metrics_merchant_day, pay.metrics_dirty,
         pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles,
         pay.merchant_permission_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    rails = new RailRegistry([
      new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
      new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      payoutDestinations: memoryPayoutDestinations(),
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
        p.railId === 'crypto-native'
          ? { ...p, successRate: '0.90' }
          : p.railId === 'card-sandbox'
            ? { ...p, successRate: '0.88' }
            : { ...p },
      ),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    trees = new SubMerchantService(sql);
    projector = new MetricsProjector(sql);
    fraudOpen = () => 0;
    clock = new Date();
    metrics = createMetricsRuntime({
      sql,
      pay,
      trees,
      rails,
      openFraudReviews: (m) => fraudOpen(m),
      now: () => clock,
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── service-driven seeding ────────────────────────────────────────────────

  async function merchant(userId = userOf(), feeBps = 250) {
    return pay.createMerchant({ userId, pricing: { feeBps }, status: 'active', kybStatus: 'approved' });
  }
  async function capturedPayment(merchantId: string, amount: string, assetId = 'USDT') {
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    return created.id;
  }
  async function cryptoCaptured(merchantId: string, amount: string, assetId = 'USDT') {
    const created = await pay.createPayment({ merchantId, amount: amt(amount), assetId, method: 'crypto', railAdapter: 'crypto-native' });
    const address = await chain.acceptanceAddress(created.id, assetId);
    chain.credit({ address, assetId, amount: amt(amount), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    return created.id;
  }
  const settle = (merchantId: string, window: string, assetId = 'USDT') =>
    pay.settleWindow({ merchantId, window, assetId, from: new Date(Date.now() - DAY_MS), to: new Date(Date.now() + DAY_MS) });

  /**
   * Two merchants and a third in another asset, with captures, refunds, a decline, a link payment and a settlement.
   *
   * Every call is a few real Postgres transactions, so run one after another this
   * was ~55 serial commits and the test's wall clock was commit latency times
   * 55; on a loaded CI runner that reached the 5 s default. The flows below
   * touch different payments, so they run concurrently (the pool has 8
   * connections), keeping only the real dependencies in order: merchants exist
   * before payments, a payment is captured before it is refunded, and every
   * capture and refund is in before a merchant is settled. The concurrent
   * writers also give the projection's dirty log real interleaving to absorb.
   */
  async function seedRun() {
    const [a, b, c] = await Promise.all([merchant(), merchant(), merchant()]);
    await Promise.all([
      (async () => {
        const a1 = await capturedPayment(a.id, '100');
        await pay.refund(a1, amt('30'));
      })(),
      capturedPayment(a.id, '40.5'),
      cryptoCaptured(a.id, '7.25'),
      (async () => {
        const declined = await pay.createPayment({
          merchantId: a.id,
          amount: amt('5'),
          assetId: 'USDT',
          method: 'card',
          railAdapter: 'card-sandbox',
          instrument: { kind: 'card', token: 'tok_decline' },
        });
        await pay.authorize(declined.id).catch(() => undefined);
      })(),
      capturedPayment(b.id, '1000'),
      capturedPayment(b.id, '12.000000000000000001'),
      cryptoCaptured(c.id, '3', 'BTC'),
      (async () => {
        // A link payment for B
        const link = await pay.createPaymentLink({ merchantId: b.id, label: 'Invoice', amount: amt('9'), currency: 'USDT' });
        await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });
        const [row] = await sql<Array<{ payment_id: string }>>`SELECT payment_id FROM pay.checkout_sessions WHERE merchant_id = ${b.id}`;
        const address = await chain.acceptanceAddress(row!.payment_id, 'USDT');
        chain.credit({ address, assetId: 'USDT', amount: amt('9'), from: '0xbuyer', confirmations: 12 });
        await pay.authorize(row!.payment_id);
        await pay.capture(row!.payment_id);
      })(),
    ]);
    await Promise.all([settle(a.id, 'w1'), settle(b.id, 'w1')]);
    return { a, b, c };
  }

  // ── raw seeding (backdated, fast) ─────────────────────────────────────────

  async function rawPayment(merchantId: string, currency: string, createdAt: Date, status = 'created'): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status, created_at)
      VALUES (${merchantId}, 1, ${currency}, 'card', 'card-sandbox', ${randomUUID()}, ${status}::pay.payment_status, ${createdAt})
      RETURNING id`;
    return row!.id;
  }
  const rawEvent = (paymentId: string, event: string, amount: string, ts: Date) =>
    sql`INSERT INTO pay.payment_events (payment_id, event, payload, ts) VALUES (${paymentId}, ${event}, ${sql.json({ amount })}, ${ts})`;
  const rawSettlement = (merchantId: string, asset: string, gross: string, fees: string, status: string, createdAt: Date) =>
    sql`INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status, created_at, payout_method, payout_ref)
        VALUES (${merchantId}, ${randomUUID()}, ${asset}, ${gross}::numeric, ${fees}::numeric, (${gross}::numeric - ${fees}::numeric),
                ${status}::pay.settlement_status, ${createdAt}, ${status === 'paid_out' ? 'ledger' : null}, ${status === 'paid_out' ? 'ref' : null})`;
  const daysAgo = (n: number, hour = 12) => new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() - n, hour));

  // ───────────────────────────────────────────────────────────────────────────

  describe('projection equals a recompute from source', () => {
    it('triggers mark the source transaction: a rolled-back write leaves no mark, a committed one leaves one', async () => {
      const m = await merchant();
      await projector.drain();
      expect((await projector.pending()).keys).toBe(0);
      await expect(
        sql.begin(async (tx) => {
          await tx`INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, status)
                   VALUES (${m.id}, 5, 'USDT', 'card', 'card-sandbox', 'created')`;
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await projector.pending()).keys).toBe(0);
      await rawPayment(m.id, 'USDT', new Date());
      expect((await projector.pending()).keys).toBe(1);
    });

    it('after a seeded multi-merchant service run, every projection total equals the recompute (zero tolerance)', async () => {
      await seedRun();
      expect((await projector.pending()).keys).toBeGreaterThan(0);
      const drained = await projector.drain();
      expect(drained.failed).toEqual([]);
      expect(drained.remaining).toBe(0);
      await expectProjectionEqualsSource(sql);

      const report = await projector.reconcile();
      expect(report.diffs).toEqual([]);
      expect(report.pendingKeys).toBe(0);
      expect(report.checkedKeys).toBeGreaterThan(0);

      // The oracle is not vacuous: real figures are in there.
      const projection = await readProjection(sql, await allKeys(sql));
      const usdt = projection.days.filter((r) => r.assetCode === 'USDT');
      expect(usdt.reduce((n, r) => n + r.captured, 0n)).toBe(
        amt('100') + amt('40.5') + amt('7.25') + amt('1000') + amt('12.000000000000000001') + amt('9'),
      );
      expect(projection.days.reduce((n, r) => n + r.refunded, 0n)).toBe(amt('30'));
      expect(projection.days.reduce((n, r) => n + r.settleCount, 0)).toBe(2);
      expect(projection.links.reduce((n, r) => n + r.payments, 0)).toBe(1);
    });

    it('stays equal while work continues: refresh half-way, write more, refresh again', async () => {
      const a = await merchant();
      await capturedPayment(a.id, '10');
      await projector.refreshPending({ maxKeys: 1 });
      const id = await capturedPayment(a.id, '20');
      await projector.drain();
      await expectProjectionEqualsSource(sql);
      await pay.refund(id, amt('5'));
      await projector.drain();
      await expectProjectionEqualsSource(sql);
    });

    it('a write that commits while a recompute is running is not lost: its own mark survives', async () => {
      const m = await merchant();
      const day = dayOf(new Date());
      await rawPayment(m.id, 'USDT', new Date());
      // An in-flight source transaction (uncommitted) holds its mark invisible to the refresher.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const ready = new Promise<void>((r) => (inserted = r));
      const writer = sql.begin(async (tx) => {
        await tx`INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, status)
                 VALUES (${m.id}, 5, 'USDT', 'card', 'card-sandbox', 'created')`;
        inserted();
        await gate;
      });
      await ready;
      await projector.drain(); // sees only the first payment
      release();
      await writer;
      expect((await projector.pending()).keys).toBe(1);
      const [mid] = await sql<Array<{ payments: number }>>`
        SELECT payments_created AS payments FROM pay.metrics_merchant_day WHERE merchant_id = ${m.id} AND day = ${day}::date`;
      expect(mid?.payments).toBe(1);
      await projector.drain();
      await expectProjectionEqualsSource(sql);
      const [done] = await sql<Array<{ payments: number }>>`
        SELECT payments_created AS payments FROM pay.metrics_merchant_day WHERE merchant_id = ${m.id} AND day = ${day}::date`;
      expect(done?.payments).toBe(2);
    });

    it('two refreshers racing on the same marks leave the projection correct', async () => {
      const a = await merchant();
      const b = await merchant();
      for (let i = 0; i < 6; i += 1) {
        await rawPayment(a.id, 'USDT', daysAgo(i));
        await rawPayment(b.id, 'BTC', daysAgo(i));
      }
      const other = new MetricsProjector(sql);
      await Promise.all([projector.drain(), other.drain(), projector.drain()]);
      expect((await projector.pending()).keys).toBe(0);
      await expectProjectionEqualsSource(sql);
    });
  });

  describe('rebuild and reconcile', () => {
    it('rebuild from empty reproduces identical rows', async () => {
      await seedRun();
      await projector.drain();
      const snapshot = async () => ({
        days: await sql`SELECT merchant_id, day::text, asset_code, payments_created, captured::text, captured_count, largest_captured::text, refunded::text, refunded_count, settle_gross::text, settle_fees::text, settle_net::text, settle_count, unsettled_net::text FROM pay.metrics_merchant_day ORDER BY 1, 2, 3`,
        status: await sql`SELECT merchant_id, day::text, status::text, payments FROM pay.metrics_merchant_day_status ORDER BY 1, 2, 3`,
        links: await sql`SELECT merchant_id, day::text, link_id, payments FROM pay.metrics_merchant_day_link ORDER BY 1, 2, 3`,
      });
      const before = JSON.parse(JSON.stringify(await snapshot()));
      expect(before.days.length).toBeGreaterThan(0);

      // Truly empty: no projection rows, no marks.
      await sql`TRUNCATE pay.metrics_merchant_day_link, pay.metrics_merchant_day_status, pay.metrics_merchant_day, pay.metrics_dirty`;
      expect((await snapshot()).days).toHaveLength(0);
      const rebuilt = await projector.rebuild();
      expect(rebuilt.failed).toEqual([]);
      expect(rebuilt.remaining).toBe(0);
      expect(JSON.parse(JSON.stringify(await snapshot()))).toEqual(before);

      // And the in-place variant with `clear`.
      const cleared = await projector.rebuild({ clear: true });
      expect(cleared.remaining).toBe(0);
      expect(JSON.parse(JSON.stringify(await snapshot()))).toEqual(before);
      expect((await projector.reconcile()).diffs).toEqual([]);
    });

    it('a cleared projection is not painted as fresh: lag is reported until the rebuild finishes', async () => {
      const m = await merchant();
      await capturedPayment(m.id, '10');
      await projector.drain();
      await sql.begin(async (tx) => {
        await tx`DELETE FROM pay.metrics_merchant_day_link`;
        await tx`DELETE FROM pay.metrics_merchant_day_status`;
        await tx`DELETE FROM pay.metrics_merchant_day`;
        await tx`INSERT INTO pay.metrics_dirty (merchant_id, day, marked_at) VALUES (${m.id}, ${dayOf(new Date())}::date, now() - interval '120 seconds')`;
      });
      const snap = await metrics.reader.merchantSnapshot(m.id, { kind: 'preset', preset: 'today' });
      expect(snap.freshness.lagSeconds).toBeGreaterThanOrEqual(119);
      expect(new Date(snap.freshness.asOf!).getTime()).toBeLessThan(Date.now() - 100_000);
      await projector.drain();
      const fresh = await metrics.reader.merchantSnapshot(m.id, { kind: 'preset', preset: 'today' });
      expect(fresh.freshness.lagSeconds).toBe(0);
    });

    it('reconcile returns a diff for every kind of corruption, then a rebuild fixes them all', async () => {
      const { a, b } = await seedRun();
      await projector.drain();
      await sql`UPDATE pay.metrics_merchant_day SET captured = captured + 1 WHERE merchant_id = ${a.id} AND asset_code = 'USDT'`;
      await sql`DELETE FROM pay.metrics_merchant_day_status WHERE merchant_id = ${b.id}`;
      await sql`INSERT INTO pay.metrics_merchant_day (merchant_id, day, asset_code, captured) VALUES (${a.id}, '2001-01-01', 'XYZ', 1)`;
      const report = await projector.reconcile();
      const kinds = new Set(report.diffs.map((d) => d.kind));
      expect(kinds).toEqual(new Set(['mismatch', 'missing', 'extra']));
      const mismatch = report.diffs.find((d) => d.kind === 'mismatch')!;
      expect(mismatch.merchantId).toBe(a.id);
      expect(mismatch.expected).not.toEqual(mismatch.actual);
      // Scoped to one merchant, the other merchant's damage is not reported.
      const onlyA = await projector.reconcile({ merchantId: a.id });
      expect(onlyA.diffs.every((d) => d.merchantId === a.id)).toBe(true);
      const fix = await projector.rebuild();
      expect(fix.remaining).toBe(0);
      expect((await projector.reconcile()).diffs).toEqual([]);
      await expectProjectionEqualsSource(sql);
    });

    it('reconcile does not call a key with unprocessed marks a diff; it counts it as pending', async () => {
      const m = await merchant();
      await projector.drain();
      await rawPayment(m.id, 'USDT', new Date());
      const report = await projector.reconcile();
      expect(report.diffs).toEqual([]);
      expect(report.pendingKeys).toBe(1);
    });

    it('computeFromSource on no keys is empty, and the rebuild CLI is wired to the same projector', () => {
      const cli = readFileSync(join(here, 'rebuild-cli.ts'), 'utf8');
      expect(cli).toContain('projector.rebuild');
      expect(cli).toContain('projector.reconcile');
      return expect(computeFromSource(sql, [])).resolves.toEqual({ days: [], statuses: [], links: [] });
    });
  });

  describe('merchant figures', () => {
    it('snapshot equals the source for the merchant, per asset, with exact bigint arithmetic', async () => {
      const { a, b } = await seedRun();
      await projector.drain();
      const sa = await metrics.reader.merchantSnapshot(a.id, { kind: 'preset', preset: 'today' });
      expect(sa.merchantId).toBe(a.id);
      expect(sa.freshness).toEqual({ asOf: expect.any(String), lagSeconds: 0 });
      expect(sa.captured).toEqual([{ assetCode: 'USDT', amount: formatAmount(amt('100') + amt('40.5') + amt('7.25')) }]);
      expect(sa.refunded).toEqual([{ assetCode: 'USDT', amount: '30' }]);
      expect(sa.net).toEqual([{ assetCode: 'USDT', amount: formatAmount(amt('147.75') - amt('30')) }]);
      expect(sa.largestPayment).toEqual([{ assetCode: 'USDT', amount: '100' }]);
      // floor(147.75 / 3) = 49.25 exactly
      expect(sa.averagePayment).toEqual([{ assetCode: 'USDT', amount: '49.25' }]);
      expect(sa.paymentCount).toBe(4);
      expect(sa.statusMix.find((s) => s.status === 'failed')!.count).toBe(1);
      expect(sa.statusMix.map((s) => s.status)).toEqual(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);
      expect(sa.settlements).toHaveLength(1);
      const settled = sa.settlements[0]!;
      expect(amt(settled.gross)).toBe(amt(settled.fees) + amt(settled.net));
      expect(sa.feeRevenue).toEqual([{ assetCode: 'USDT', amount: settled.fees }]);
      expect(sa.conversionVolume).toBeNull();
      expect(sa.linkUsage).toEqual({ linksUsed: 0, paymentsViaLinks: 0 });

      // Balances come from the ledger, not from a copy.
      const { merchantClearing, merchantProceeds } = await import('@intafaced/ledger-client');
      const bal = sa.balances.find((x) => x.assetCode === 'USDT')!;
      expect(bal.clearing).toBe(formatAmount((await ledger.balance(merchantClearing(a.id, 'USDT'))).amount));
      expect(bal.available).toBe(formatAmount((await ledger.balance(merchantProceeds(a.id, 'USDT'))).amount));

      const sb = await metrics.reader.merchantSnapshot(b.id, { kind: 'preset', preset: 'today' });
      expect(sb.linkUsage).toEqual({ linksUsed: 1, paymentsViaLinks: 1 });
      expect(sb.largestPayment).toEqual([{ assetCode: 'USDT', amount: '1000' }]);
      // A's snapshot carries nothing of B's.
      expect(JSON.stringify(sa)).not.toContain(b.id);
    });

    it('rolling windows are whole UTC day buckets; presets and ranges agree', async () => {
      const m = await merchant();
      const bucket = async (daysBack: number, amount: string, asset = 'USDT') => {
        const id = await rawPayment(m.id, asset, daysAgo(daysBack), 'captured');
        await rawEvent(id, 'captured', amount, daysAgo(daysBack, 13));
        return id;
      };
      await bucket(0, '1');
      await bucket(3, '10');
      await bucket(6, '100');
      await bucket(7, '1000'); // outside rolling_7d, inside 30d
      await bucket(29, '10000');
      await bucket(30, '100000'); // outside rolling_30d
      await projector.drain();
      const total = async (preset: 'today' | 'rolling_7d' | 'rolling_30d') =>
        (await metrics.reader.merchantSnapshot(m.id, { kind: 'preset', preset })).captured[0]?.amount;
      expect(await total('today')).toBe('1');
      expect(await total('rolling_7d')).toBe('111');
      expect(await total('rolling_30d')).toBe('11111');
      const from = `${dayOf(new Date(daysAgo(6)))}T00:00:00.000Z`;
      const to = `${dayOf(new Date(daysAgo(-1)))}T00:00:00.000Z`;
      const ranged = await metrics.reader.merchantSnapshot(m.id, { kind: 'range', from, to });
      expect(ranged.captured[0]?.amount).toBe('111');

      const series = await metrics.reader.merchantSeries({ merchantId: m.id, from, to });
      expect(series.points.map((p) => [p.day, p.volume])).toEqual([
        [dayOf(daysAgo(6)), '100'],
        [dayOf(daysAgo(3)), '10'],
        [dayOf(daysAgo(0)), '1'],
      ]);
    });

    it('refuses windows it cannot answer exactly instead of approximating', async () => {
      const m = await merchant();
      const ref = (from: string, to: string) => metrics.reader.merchantSnapshot(m.id, { kind: 'range', from, to });
      await expect(ref('2026-10-01T06:00:00Z', '2026-10-08T00:00:00Z')).rejects.toMatchObject({ code: 'pay.metrics_window_unaligned' });
      await expect(ref('2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z')).rejects.toMatchObject({ code: 'pay.metrics_window_invalid' });
      await expect(ref('2025-01-01T00:00:00Z', '2026-10-01T00:00:00Z')).rejects.toMatchObject({ code: 'pay.metrics_window_too_wide' });
    });

    it('amounts are exact to the last decimal, even near the column limit, and never pass through a JS number', async () => {
      const m = await merchant();
      const big = '99999999999999999999.999999999999999999';
      const id = await rawPayment(m.id, 'USDT', new Date(), 'captured');
      await rawEvent(id, 'captured', big, new Date());
      await projector.drain();
      const snap = await metrics.reader.merchantSnapshot(m.id, { kind: 'preset', preset: 'today' });
      expect(snap.captured).toEqual([{ assetCode: 'USDT', amount: big }]);
      expect(snap.largestPayment).toEqual([{ assetCode: 'USDT', amount: big }]);
      expect(snap.averagePayment).toEqual([{ assetCode: 'USDT', amount: big }]);
      for (const field of [snap.captured, snap.refunded, snap.net, snap.averagePayment, snap.largestPayment, snap.feeRevenue]) {
        for (const x of field) expect(typeof x.amount).toBe('string');
      }
      // The module's own source never converts an amount to a float.
      for (const file of ['compute.ts', 'reader.ts', 'projector.ts']) {
        const src = readFileSync(join(here, file), 'utf8');
        expect(src, file).not.toMatch(/parseFloat|toFixed|Math\.(round|floor|ceil)/);
        expect(src, file).not.toMatch(
          /Number\((?:[a-z_.]*)(?:captured|refunded|settle_gross|settle_fees|settle_net|largest|amount|unsettled)(?!_count)/,
        );
      }
    });
  });

  describe('global figures', () => {
    it('totals tie to the per-merchant figures and to source', async () => {
      const { a, b, c } = await seedRun();
      await projector.drain();
      fraudOpen = (m) => (m === undefined ? 3 : m === b.id ? 2 : 0);
      const g = await metrics.reader.globalMetrics({ kind: 'preset', preset: 'today' });
      const per = await Promise.all([a, b, c].map((m) => metrics.reader.merchantSnapshot(m.id, { kind: 'preset', preset: 'today' })));
      const sum = (rows: Array<{ assetCode: string; amount: string }>[], asset: string) =>
        rows
          .flat()
          .filter((x) => x.assetCode === asset)
          .reduce((n, x) => n + amt(x.amount), 0n);
      for (const asset of ['USDT', 'BTC']) {
        expect(g.volume.find((x) => x.assetCode === asset)?.amount).toBe(
          formatAmount(
            sum(
              per.map((p) => p.captured),
              asset,
            ),
          ),
        );
        expect(g.revenue.find((x) => x.assetCode === asset)?.amount ?? '0').toBe(
          formatAmount(
            sum(
              per.map((p) => p.feeRevenue),
              asset,
            ),
          ),
        );
      }
      expect(g.activeMerchants).toBe(3);
      expect(g.openFraudReviews).toBe(3);
      expect(g.pendingKyb).toBe(0);
      expect(g.onboardingFunnel).toContainEqual({ step: 'status.active', count: 3 });
      expect(g.onboardingFunnel).toContainEqual({ step: 'kyb.approved', count: 3 });
      expect(g.onboardingFunnel).toContainEqual({ step: 'status.pending', count: 0 });
      expect(g.railHealth.map((r) => r.railId).sort()).toEqual(['bank-payout', 'card-sandbox', 'crypto-native']);
      expect(g.railHealth.find((r) => r.railId === 'bank-payout')).toMatchObject({ ok: false });
      // pendingSettlement = captured and not yet settled, net of refunds: c's 3 BTC, plus anything A/B captured after their window.
      expect(g.pendingSettlement.find((x) => x.assetCode === 'BTC')?.amount).toBe('3');
      expect(g.freshness.lagSeconds).toBe(0);
    });

    it('lists merchants with lifetime volume, pages by cursor, filters, and refuses what it cannot answer', async () => {
      const { b } = await seedRun();
      await projector.drain();
      fraudOpen = (m) => (m === b.id ? 2 : 0);
      const first = await metrics.reader.merchantList({ limit: 2 });
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await metrics.reader.merchantList({ limit: 2, cursor: first.nextCursor! });
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const all = [...first.rows, ...second.rows];
      expect(new Set(all.map((r) => r.merchantId)).size).toBe(3);
      expect(all.find((r) => r.merchantId === b.id)).toMatchObject({ openFlags: 2, status: 'active', kybStatus: 'approved', tierId: null });
      expect(all.find((r) => r.merchantId === b.id)!.volume).toEqual([
        { assetCode: 'USDT', amount: formatAmount(amt('1000') + amt('12.000000000000000001') + amt('9')) },
      ]);
      expect((await metrics.reader.merchantList({ limit: 5, filter: { status: 'suspended' } })).rows).toEqual([]);
      await expect(metrics.reader.merchantList({ limit: 5, filter: { tierId: 'tier-a' } })).rejects.toMatchObject({
        code: 'pay.metrics_filter_unsupported',
      });
      await expect(metrics.reader.merchantList({ limit: 5, filter: { status: 'bogus' } })).rejects.toMatchObject({
        code: 'pay.metrics_filter_invalid',
      });
      await expect(metrics.reader.merchantList({ limit: 5, cursor: 'not-a-cursor' })).rejects.toMatchObject({
        code: 'pay.metrics_cursor_invalid',
      });
    });
  });

  describe('merchant names (W4b)', () => {
    it('reads a merchant name into the founder list, null where none was given, and can look up exactly one merchant', async () => {
      const named = await pay.createMerchant({
        userId: userOf(),
        pricing: { feeBps: 250 },
        status: 'active',
        displayName: 'Acme Shop',
        legalName: 'Acme Trading Ltd',
      });
      const unnamed = await merchant();
      const all = (await metrics.reader.merchantList({ limit: 10 })).rows;
      expect(all.find((r) => r.merchantId === named.id)?.displayName).toBe('Acme Shop');
      expect(all.find((r) => r.merchantId === unnamed.id)?.displayName).toBeNull();

      const one = await metrics.reader.merchantList({ limit: 1, filter: { merchantId: named.id } });
      expect(one.rows.map((r) => [r.merchantId, r.displayName])).toEqual([[named.id, 'Acme Shop']]);
      expect(one.nextCursor).toBeNull();
      expect((await metrics.reader.merchantList({ limit: 1, filter: { merchantId: randomUUID() } })).rows).toEqual([]);
    });
  });

  // ── isolation: M1, M2, M3, M5 through the real router ───────────────────────

  describe('isolation through the router', () => {
    const founderUser = userOf();
    const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
    const entitled = (status: string) =>
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ result: { data: { status, userId: founderUser, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );
    const mount = (fetcher: typeof fetch = entitled('enabled')) =>
      createPayNamespaces({ founderAuthority: createFounderAuthority({ ...identity, fetcher }), metrics });
    const today = { kind: 'preset', preset: 'today' } as const;
    type Caller = {
      merchantMetrics: {
        snapshot: (i: unknown) => Promise<{ merchantId: string; captured: unknown[] }>;
        series: (i: unknown) => Promise<{ points: unknown[] }>;
      };
    };
    const asCaller = (p: Principal): Caller => mount().createCaller(ctxOf(p)) as unknown as Caller;
    const failure = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { code: string; message: string; cause?: { code?: string } };
        return { code: err.code, message: err.message, cause: err.cause?.code };
      }
      throw new Error('expected a refusal');
    };

    it('M1: A (session and API key) asking for B gets exactly what it gets for an id that does not exist', async () => {
      const ua = userOf();
      const ub = userOf();
      const a = await merchant(ua);
      const b = await merchant(ub);
      await capturedPayment(a.id, '10');
      await capturedPayment(b.id, '99', 'BTC');
      await projector.drain();
      const session = principal(ua);
      const key = principal(ua, { kid: randomUUID(), mfa: false, scopes: ['pay:read'] });
      for (const p of [session, key]) {
        const caller = asCaller(p);
        const own = await caller.merchantMetrics.snapshot({ merchantId: a.id, window: today });
        expect(own.merchantId).toBe(a.id);
        const stranger = await failure(caller.merchantMetrics.snapshot({ merchantId: b.id, window: today }));
        const missing = await failure(caller.merchantMetrics.snapshot({ merchantId: randomUUID(), window: today }));
        expect(stranger).toEqual(missing);
        expect(stranger.code).toBe('NOT_FOUND');
        expect(JSON.stringify(stranger)).not.toContain(b.id);
        const range = { merchantId: b.id, from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' };
        const strangerSeries = await failure(caller.merchantMetrics.series(range));
        const missingSeries = await failure(caller.merchantMetrics.series({ ...range, merchantId: randomUUID() }));
        expect(strangerSeries).toEqual(missingSeries);
      }
    });

    it('M2: A sees only A rows in snapshot and series, whatever else is seeded', async () => {
      const ua = userOf();
      const a = await merchant(ua);
      const b = await merchant();
      await capturedPayment(a.id, '10');
      await cryptoCaptured(b.id, '5', 'BTC');
      await capturedPayment(b.id, '77');
      await projector.drain();
      const caller = asCaller(principal(ua));
      const snap = await caller.merchantMetrics.snapshot({ merchantId: a.id, window: today });
      expect(snap.captured).toEqual([{ assetCode: 'USDT', amount: '10' }]);
      const from = `${dayOf(new Date(Date.now() - 3 * DAY_MS))}T00:00:00.000Z`;
      const to = `${dayOf(new Date(Date.now() + DAY_MS))}T00:00:00.000Z`;
      const series = await caller.merchantMetrics.series({ merchantId: a.id, from, to, bucket: 'day' });
      expect(series.points).toEqual([{ day: dayOf(new Date()), assetCode: 'USDT', volume: '10', feeRevenue: '0' }]);
    });

    it('M2: the founder merchant list is founder-only and an API key / merchant session cannot reach it', async () => {
      await merchant();
      const router = mount(entitled('revoked'));
      await expect(router.createCaller(ctxOf(principal(userOf()))).founderAdmin.merchants.list({ limit: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const keyed = principal(founderUser, { kid: randomUUID(), scopes: ['admin:read', 'pay:read'] });
      const calls = entitled('enabled');
      await expect(mount(calls).createCaller(ctxOf(keyed)).founderAdmin.metrics.global({ window: today })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(calls).not.toHaveBeenCalled();
    });

    it('G1/G2 on the new founder procedures: the reader is never touched for a non-founder', async () => {
      const m = await merchant();
      const spies = [
        vi.spyOn(metrics.reader, 'merchantList'),
        vi.spyOn(metrics.reader, 'globalMetrics'),
        vi.spyOn(metrics.reader, 'merchantSnapshot'),
        vi.spyOn(metrics.reader, 'merchantSeries'),
      ];
      const series = { merchantId: m.id, from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' as const };
      const sessionCaller = mount(vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }))).createCaller(
        ctxOf(principal(userOf())),
      );
      const keyCaller = mount().createCaller(ctxOf(principal(founderUser, { kid: randomUUID(), scopes: ['admin:read'] })));
      for (const caller of [sessionCaller, keyCaller]) {
        await expect(caller.founderAdmin.metrics.global({ window: today })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(caller.founderAdmin.metrics.merchant({ merchantId: m.id, window: today })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(caller.founderAdmin.metrics.merchantSeries(series)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(caller.founderAdmin.merchants.list({ limit: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it('a live founder reads any merchant and the global panel; an unknown merchant is NOT_FOUND', async () => {
      const m = await merchant();
      await capturedPayment(m.id, '10');
      await projector.drain();
      const caller = mount().createCaller(ctxOf(principal(founderUser)));
      expect((await caller.founderAdmin.metrics.merchant({ merchantId: m.id, window: today })).captured).toEqual([
        { assetCode: 'USDT', amount: '10' },
      ]);
      expect((await caller.founderAdmin.metrics.global({ window: today })).volume).toEqual([{ assetCode: 'USDT', amount: '10' }]);
      expect((await caller.founderAdmin.merchants.list({ limit: 5 })).rows).toHaveLength(1);
      await expect(caller.founderAdmin.metrics.merchant({ merchantId: randomUUID(), window: today })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('serves the name through the strict founder contract and keeps the legal name off the list', async () => {
      const named = await pay.createMerchant({
        userId: userOf(),
        pricing: { feeBps: 250 },
        status: 'active',
        displayName: 'Acme Shop',
        legalName: 'Acme Trading Ltd',
      });
      const caller = mount().createCaller(ctxOf(principal(founderUser)));
      const list = await caller.founderAdmin.merchants.list({ limit: 5, filter: { merchantId: named.id } });
      expect(list.rows).toHaveLength(1);
      expect(list.rows[0]).toMatchObject({ merchantId: named.id, displayName: 'Acme Shop' });
      expect(JSON.stringify(list)).not.toContain('Acme Trading Ltd');
    });

    it('does not show merchant names to a merchant session or an API key', async () => {
      const ua = userOf();
      await pay.createMerchant({ userId: ua, pricing: { feeBps: 250 }, status: 'active', displayName: 'Acme Shop' });
      const router = mount(entitled('revoked'));
      await expect(router.createCaller(ctxOf(principal(ua))).founderAdmin.merchants.list({ limit: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // An API key (kid plus admin:read) is refused even for a founder's own user id and a live entitlement.
      const calls = entitled('enabled');
      const keyCaller = mount(calls).createCaller(ctxOf(principal(founderUser, { kid: randomUUID(), scopes: ['admin:read'] })));
      await expect(keyCaller.founderAdmin.merchants.list({ limit: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(keyCaller.founderAdmin.merchants.list({ limit: 1, filter: { merchantId: randomUUID() } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(calls).not.toHaveBeenCalled();
    });

    it('M3: a PayFac parent reads sub-merchants only within granted areas; nobody else in or out of the tree can', async () => {
      const ur = userOf();
      const up = userOf();
      const us = userOf();
      const ut = userOf();
      const uq = userOf();
      const root = await merchant(ur);
      const mid = await trees.createSubMerchant({
        actorMerchantId: root.id,
        parentMerchantId: root.id,
        userId: up,
        pricing: { feeBps: 100 },
        actorId: ur,
        actorScope: 'pay:write',
      });
      const leaf = await trees.createSubMerchant({
        actorMerchantId: mid.id,
        parentMerchantId: mid.id,
        userId: us,
        pricing: { feeBps: 100 },
        actorId: up,
        actorScope: 'pay:write',
      });
      const sibling = await trees.createSubMerchant({
        actorMerchantId: root.id,
        parentMerchantId: root.id,
        userId: ut,
        pricing: { feeBps: 100 },
        actorId: ur,
        actorScope: 'pay:write',
      });
      const stranger = await merchant(uq);
      // Sub-merchants start `pending`; they must be live to take payments.
      await sql`UPDATE pay.merchants SET status = 'active', kyb_status = 'approved' WHERE id = ANY(${sql.array([leaf.id, sibling.id])}::uuid[])`;
      await capturedPayment(leaf.id, '25');
      await capturedPayment(sibling.id, '8');
      await projector.drain();

      const read = (userId: string, merchantId: string) =>
        failure(asCaller(principal(userId)).merchantMetrics.snapshot({ merchantId, window: today })).then(
          (f) => f,
          () => 'ok' as const,
        );
      // The leaf reads itself.
      expect((await asCaller(principal(us)).merchantMetrics.snapshot({ merchantId: leaf.id, window: today })).captured).toEqual([
        { assetCode: 'USDT', amount: '25' },
      ]);
      // The middle node holds only the default (visibility) areas over the leaf: refused by name, no figures.
      const denied = await read(up, leaf.id);
      expect(denied).toMatchObject({ code: 'FORBIDDEN' });
      expect(JSON.stringify(denied)).toContain('submerchant_permission_denied');
      // One of the two areas is not enough.
      const grant = (area: string) =>
        trees.grantPermission({
          actorMerchantId: root.id,
          granteeMerchantId: mid.id,
          subjectMerchantId: leaf.id,
          area,
          reason: 'metrics test',
          actorId: ur,
          actorScope: 'pay:write',
        });
      await grant('payment');
      expect(await read(up, leaf.id)).toMatchObject({ code: 'FORBIDDEN' });
      await grant('settlement');
      expect(await read(up, leaf.id)).toBe('ok');
      // The tree root holds every area over its subtree.
      expect(await read(ur, leaf.id)).toBe('ok');
      expect(await read(ur, sibling.id)).toBe('ok');
      // The middle node's grant does not reach the sibling subtree: same answer as an unknown id.
      const missing = await read(up, randomUUID());
      expect(await read(up, sibling.id)).toEqual(missing);
      // Children cannot read up or sideways: same answer as an unknown id.
      expect(await read(us, mid.id)).toEqual(missing);
      expect(await read(us, root.id)).toEqual(missing);
      expect(await read(us, sibling.id)).toEqual(missing);
      expect(await read(ut, leaf.id)).toEqual(missing);
      // Another tree's owner sees nothing of this one, and this tree sees nothing of theirs.
      expect(await read(uq, leaf.id)).toEqual(missing);
      expect(await read(uq, root.id)).toEqual(missing);
      expect(await read(ur, stranger.id)).toEqual(missing);
      // Revoking removes access again.
      await trees.revokePermission({
        actorMerchantId: root.id,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'settlement',
        reason: 'metrics test',
        actorId: ur,
        actorScope: 'pay:write',
      });
      expect(await read(up, leaf.id)).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('M5: with A and B events randomly interleaved, A metrics always equal a recompute from A rows only', async () => {
      const a = await merchant();
      const b = await merchant();
      const mulberry = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const assets = ['USDT', 'BTC'];
      for (let seed = 1; seed <= 12; seed += 1) {
        const rnd = mulberry(seed);
        const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
        const open: Array<{ owner: string; id: string; captured: Amount; refunded: Amount }> = [];
        for (let step = 0; step < 30; step += 1) {
          const owner = rnd() < 0.5 ? a.id : b.id;
          const at = daysAgo(Math.floor(rnd() * 20), Math.floor(rnd() * 24));
          const roll = rnd();
          if (roll < 0.35 || open.length === 0) {
            const id = await rawPayment(owner, pick(assets), at, rnd() < 0.2 ? 'failed' : 'captured');
            const amount = `${Math.floor(rnd() * 1000)}.${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}`;
            if (rnd() < 0.8) {
              await rawEvent(id, 'captured', amount, at);
              open.push({ owner, id, captured: amt(amount), refunded: 0n });
            }
          } else if (roll < 0.55) {
            const p = pick(open);
            const room = p.captured - p.refunded;
            if (room > 0n) {
              const part = room / 3n + 1n;
              await rawEvent(p.id, 'refunded', formatAmount(part), at);
              p.refunded += part;
            }
          } else if (roll < 0.7) {
            await rawSettlement(owner, pick(assets), '100', '2.5', pick(['posted', 'paid_out', 'pending', 'failed']), at);
          } else {
            await projector.refreshPending({ maxKeys: 1 + Math.floor(rnd() * 3) }); // partial refresh mid-stream
          }
        }
        await projector.drain();
        await expectProjectionEqualsSource(sql);
        for (const [m, other] of [
          [a, b],
          [b, a],
        ] as const) {
          const snap = await metrics.reader.merchantSnapshot(m.id, {
            kind: 'range',
            from: `${dayOf(daysAgo(25))}T00:00:00.000Z`,
            to: `${dayOf(daysAgo(-1))}T00:00:00.000Z`,
          });
          const expected = await oracle(sql, m.id);
          expect(expected.days.every((r) => r.merchantId === m.id)).toBe(true);
          for (const asset of assets) {
            const rows = expected.days.filter((r) => r.assetCode === asset);
            const cap = rows.reduce((n, r) => n + r.captured, 0n);
            const ref = rows.reduce((n, r) => n + r.refunded, 0n);
            const got = snap.captured.find((x) => x.assetCode === asset);
            expect(got?.amount ?? '0').toBe(formatAmount(cap));
            expect(snap.refunded.find((x) => x.assetCode === asset)?.amount ?? '0').toBe(formatAmount(ref));
            expect(snap.net.find((x) => x.assetCode === asset)?.amount ?? '0').toBe(formatAmount(cap - ref));
          }
          expect(JSON.stringify(snap)).not.toContain(other.id);
        }
        await sql`TRUNCATE pay.metrics_merchant_day_link, pay.metrics_merchant_day_status, pay.metrics_merchant_day, pay.metrics_dirty`;
        await truncatePayForTest(
          sql,
          'pay',
          `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments RESTART IDENTITY CASCADE`,
        );
      }
    }, 120_000);
  });
});

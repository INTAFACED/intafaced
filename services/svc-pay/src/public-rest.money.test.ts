import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  MemoryLedger,
  formatAmount,
  merchantClearing,
  merchantProceeds,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { MemoryRestIdempotencyStore, type RestIdempotencyStore } from './rest-idempotency.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter, type CardSandboxOptions } from './rails/card-sandbox.js';
import type { RailAdapter } from './rails/rail-adapter.js';

/**
 * Test double with a live identity. The mock books stay in CardSandboxAdapter,
 * which cannot itself be live. This object is a different adapter: id
 * `card-acquirer`, mode `live`, so the HTTP money suite is not a sandbox key.
 */
function httpMoneyAcquirer(options: CardSandboxOptions): RailAdapter {
  const inner = new CardSandboxAdapter(options);
  return {
    id: 'card-acquirer',
    capabilities: inner.capabilities,
    mode: 'live',
    health: () => inner.health(),
    authorize: (payment) => inner.authorize(payment),
    capture: (ref) => inner.capture(ref),
    refund: (ref, amount) => inner.refund(ref, amount),
    payout: (instruction) => inner.payout(instruction),
    payoutIdempotencyKey: (instruction) => inner.payoutIdempotencyKey(instruction),
    queryPayout: (idempotencyKey) => inner.queryPayout(idempotencyKey),
    verifyWebhook: (req) => inner.verifyWebhook(req),
  };
}

/**
 * DOES THE PUBLIC WRITE SURFACE ACTUALLY MOVE MONEY, AND ONLY ONCE?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND PUBLIC-REST SUITE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `public-rest.test.ts` proves the surface is shaped correctly. It cannot prove
 * it is correct about money, because it reaches `PayService` the one way a
 * caller never can: through `stubPay()`, a fake whose `capture` and `refund`
 * return a literal and move nothing. Every money assertion in that file is
 * therefore on an HTTP status code or on a CALL COUNT.
 *
 * A call count is the wrong instrument for idempotency, and specifically the
 * wrong one here. `withIdempotency` journals the HTTP response, so "createPayment
 * was called once" only proves the JOURNAL deduped. It says nothing about the
 * key the LEDGER saw — and the ledger idempotency key is the only thing standing
 * between a retried capture and a merchant credited twice. This repo has fixed
 * an attempt-derived key three times; `close:${id}:${randomUUID()}` is the
 * version that drained a pot. A suite that counts calls would pass on every one
 * of them.
 *
 * So this file asserts on BALANCES and on the SET OF LEDGER IDEMPOTENCY KEYS,
 * over a real Postgres, a real `PayService`, a real `MemoryLedger`, and the real
 * mounted Fastify routes entered by HTTP `inject`. Nothing here constructs a
 * router or calls a service method directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE JOURNAL IS DELIBERATELY BYPASSED IN TWO TESTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `withIdempotency` ABANDONS its claim on 5xx so a retry may execute — that is
 * correct, and it means the journal is explicitly NOT the guard on the retry
 * path that matters. What guards it is the ledger key. Two tests below therefore
 * hand the surface a FRESH journal between attempts, which is what a merchant
 * retrying after a timeout, a journal expiry, or a second replica looks like.
 * That is the only construction under which the ledger key is load-bearing, and
 * it is the construction the stub suite cannot express.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS CAREFUL NOT TO CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That this is a card programme. The rail is a live-mode test acquirer
 * (`card-acquirer`) so these writes are not a sandbox credential. Sandbox keys
 * are proved in `sandbox-isolation.db.test.ts`. Nothing here is evidence of
 * KYB gating, or of a chargeback wire.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '0000_pay_init.sql',
  '0002_pay_payment_links.sql',
  '0003_pay_checkout_sessions.sql',
  '0005_pay_merchant_kyb.sql',
  // createMerchant reads parent_merchant_id, so every list that creates a merchant carries 0009.
  '0009_pay_submerchant_tree.sql',
  // GET /v1/payments reads the stored pricing row. The table is empty here.
  '0050_pay_control_tiers.sql',
  '0051_pay_control_pricing.sql',
  // createMerchant writes the name columns, so every list that creates a merchant carries 0071.
  '0071_pay_merchant_names.sql',
  '0073_pay_settlement_read.sql',
  // createPayment reads the business's category (RC-merchant-08). The table is empty here, so nothing is refused.
  '20261024084448_pay_business_categories.sql',
  '20261029051500_pay_business_category_standard.sql',
].map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const EDGE_SECRET = 'a-pay-public-rest-money-edge-secret-long-enough';
const RAIL_SECRET = 'svc-pay-money-rest-test-secret-32-characters-x';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OWNER,
    userId: OWNER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['pay:read', 'pay:write', 'pay:refund'],
    tier: 'basic',
    mfa: false,
    // A live key on `card-acquirer`. A sandbox key must not move this book;
    // that refusal is `sandbox-isolation.db.test.ts`.
    key_env: 'live',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay public-rest is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay public REST money (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

/**
 * 30 s per test, not vitest's 5 s default. Ten local runs of this file on an
 * idle throwaway Postgres finished the tests in 587 to 662 ms, 13 passed each
 * time. On CI the journal-lost partial refund alone has been 1254 ms, 1298 ms
 * and 2995 ms while the rest of the pay package shares one Postgres, so a 5 s
 * limit is a speed failure on a loaded runner. The customer-only run that went
 * red named this test; the body does not replan a second refund.
 *
 * vitest does not cancel a test body that has timed out. The body keeps
 * posting while the next test's beforeEach TRUNCATE takes ACCESS EXCLUSIVE
 * on the pay tables, and the two deadlock. The same budget is already on the
 * money PG-hard suite. It is a limit, not a retry.
 */
describe('svc-pay public REST money paths PG-hard', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let ledger: MemoryLedger;
  /** Every idempotency key the ledger was ever asked to post under. */
  let postedKeys: string[];
  let recording: LedgerClient;
  let pay: PayService;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations: MIGRATIONS });
  }, 120_000);

  beforeEach(async () => {
    if (!db) throw new Error('H8a: svc-pay public-rest PG was not opened');
    await db.truncateAll();
    ledger = new MemoryLedger();
    postedKeys = [];
    recording = {
      post: async (request: PostRequest) => {
        postedKeys.push(request.idempotencyKey);
        return ledger.post(request);
      },
      balance: (ref) => ledger.balance(ref),
      balances: (ownerType, ownerId) => ledger.balances(ownerType, ownerId),
      getTx: (txId) => ledger.getTx(txId),
      getTxByKey: (key) => ledger.getTxByKey(key),
    };
    pay = new PayService(db.sql, recording, new RailRegistry([httpMoneyAcquirer({ secret: RAIL_SECRET, toleranceSeconds: 300 })]));
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    await adminStop();
  }, 30_000);

  /**
   * The surface as `index.ts` mounts it, with a swappable journal so a test can
   * model journal loss. Webhooks are omitted: they move no value, and step 3 is
   * already covered against the stub.
   */
  async function build(idempotency: RestIdempotencyStore): Promise<FastifyInstance> {
    await app?.close();
    const built = Fastify({ logger: false });
    await registerPublicPayRest(built, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-pay',
      pay,
      idempotency,
    });
    await built.ready();
    app = built;
    return built;
  }

  const clearingOf = async (merchantId: string) => formatAmount((await ledger.balance(merchantClearing(merchantId, ASSET))).amount);
  const proceedsOf = async (merchantId: string) => formatAmount((await ledger.balance(merchantProceeds(merchantId, ASSET))).amount);
  const keysMatching = (prefix: string) => postedKeys.filter((k) => k.startsWith(prefix));

  /** Merchant with a zero fee: this suite is about movement and identity, not pricing. */
  async function merchant() {
    return pay.createMerchant({ userId: OWNER, pricing: { feeBps: 0 } });
  }

  /** Create + authorize over HTTP, so the row under test was made by a caller. */
  async function authorizedPayment(http: FastifyInstance, merchantId: string, amount = '100'): Promise<string> {
    const created = await http.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...signed(), 'idempotency-key': `create:${merchantId}:${amount}` },
      payload: {
        merchantId,
        amount,
        assetId: ASSET,
        method: 'card',
        railAdapter: 'card-acquirer',
        instrument: { kind: 'card', token: 'tok_ok' },
      },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const id = created.json().id as string;

    const authorized = await http.inject({
      method: 'POST',
      url: `/v1/payments/${id}/authorize`,
      headers: { ...signed(), 'idempotency-key': `authorize:${id}` },
      payload: {},
    });
    expect(authorized.statusCode, authorized.payload).toBe(200);
    return id;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1 · REACHABLE, AND IT MOVES REAL VALUE
  // ═══════════════════════════════════════════════════════════════════════════

  describe('the mounted write surface moves value through the ledger', () => {
    it('captures over HTTP and the merchant clearing balance is what moved', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await authorizedPayment(http, m.id, '100');

      // Authorize moves nothing. Asserted on the balance, not on a status code.
      expect(await clearingOf(m.id)).toBe('0');

      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/capture`,
        headers: { ...signed(), 'idempotency-key': `capture:${id}` },
        payload: {},
      });

      expect(await clearingOf(m.id)).toBe('100');
      expect(keysMatching(`payment.capture:${id}`)).toEqual([`payment.capture:${id}`]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2 · A REPLAYED WRITE ACTS ONCE — PROVEN ON KEYS AND BALANCES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('a replayed capture acts once', () => {
    it('same Idempotency-Key twice: one distinct ledger key, one movement', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await authorizedPayment(http, m.id, '100');
      const headers = { ...signed(), 'idempotency-key': `capture:${id}` };

      await http.inject({ method: 'POST', url: `/v1/payments/${id}/capture`, headers, payload: {} });
      await http.inject({ method: 'POST', url: `/v1/payments/${id}/capture`, headers, payload: {} });

      expect(await clearingOf(m.id)).toBe('100');
      expect(new Set(keysMatching('payment.capture:')).size).toBe(1);
    });

    /**
     * THE TEST THE STUB SUITE CANNOT WRITE.
     *
     * A fresh journal between attempts is a merchant retrying after a timeout,
     * a journal expiry, or a second replica. The HTTP journal cannot dedupe
     * here — by construction it has no record. If `payment.capture:<id>` were
     * derived per attempt, the merchant would be credited 200 for one 100
     * payment, and this is the assertion that says so.
     */
    it('capture retried with the journal LOST still moves exactly once', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await authorizedPayment(http, m.id, '100');
      const headers = { ...signed(), 'idempotency-key': `capture:${id}` };

      await http.inject({ method: 'POST', url: `/v1/payments/${id}/capture`, headers, payload: {} });
      // The journal forgets. The ledger key is now the only guard left.
      const retried = await build(new MemoryRestIdempotencyStore());
      await retried.inject({ method: 'POST', url: `/v1/payments/${id}/capture`, headers, payload: {} });

      expect(await clearingOf(m.id)).toBe('100');
      expect(new Set(keysMatching('payment.capture:')).size).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3 · A WRITE WITHOUT AUTHORITY MOVES NOTHING
  // ═══════════════════════════════════════════════════════════════════════════

  describe('authority is asserted before value moves, not after', () => {
    it('a stranger capturing another merchant’s payment is told it does not exist, BY CODE and moves nothing', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await authorizedPayment(http, m.id, '100');

      const res = await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/capture`,
        headers: { ...signed(principal({ sub: STRANGER, userId: STRANGER })), 'idempotency-key': `capture:${id}` },
        payload: {},
      });

      expect(res.json().error.code).toBe('pay.payment_not_found');
      expect(await clearingOf(m.id)).toBe('0');
      expect(keysMatching('payment.capture:')).toEqual([]);
    });

    it('a writer without pay:refund cannot move a refund out — by code, and nothing moves', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await authorizedPayment(http, m.id, '100');
      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/capture`,
        headers: { ...signed(), 'idempotency-key': `capture:${id}` },
        payload: {},
      });
      const before = await clearingOf(m.id);

      const res = await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers: {
          ...signed(principal({ scopes: ['pay:read', 'pay:write'] })),
          'idempotency-key': `refund:${id}`,
        },
        payload: { amount: '10' },
      });

      expect(res.json().error.code).toBe('pay.unauthorized');
      expect(await clearingOf(m.id)).toBe(before);
      expect(keysMatching('payment.refund:')).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4 · REFUND IDENTITY — THE OUTBOUND PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('a replayed refund acts once', () => {
    async function captured(http: FastifyInstance, merchantId: string) {
      const id = await authorizedPayment(http, merchantId, '100');
      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/capture`,
        headers: { ...signed(), 'idempotency-key': `capture:${id}` },
        payload: {},
      });
      return id;
    }

    it('same key twice through the journal refunds once', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await captured(http, m.id);
      const headers = { ...signed(), 'idempotency-key': `refund:${id}:partial` };

      await http.inject({ method: 'POST', url: `/v1/payments/${id}/refund`, headers, payload: { amount: '10' } });
      await http.inject({ method: 'POST', url: `/v1/payments/${id}/refund`, headers, payload: { amount: '10' } });

      expect(await clearingOf(m.id)).toBe('90');
      expect(new Set(keysMatching('payment.refund:')).size).toBe(1);
    });

    /**
     * THE HOLE THIS SUITE WAS WRITTEN TO FIND.
     *
     * `PayService.refund` defaults `refundId` to `${paymentId}:${sequence + 1}`
     * — an ATTEMPT ORDINAL. The REST surface passes the caller's
     * `Idempotency-Key` to the journal and nowhere else, so with the journal
     * lost, one business event retried becomes `…:1` and then `…:2`: two
     * distinct ledger keys, two real movements out of the merchant's clearing.
     *
     * A FULL refund is saved by `pay.refund_exceeds_captured` (refundable is
     * zero the second time). A PARTIAL refund is not, which is why this test is
     * partial. The fix is in `public-rest.ts`: the default refund identity is
     * derived from the caller's key plus the payment, so the ledger sees one key.
     */
    it('partial refund retried with the journal LOST refunds exactly once', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await captured(http, m.id);
      const headers = { ...signed(), 'idempotency-key': `refund:${id}:partial` };

      const first = await http.inject({ method: 'POST', url: `/v1/payments/${id}/refund`, headers, payload: { amount: '10' } });
      expect(first.statusCode, first.payload).toBe(200);
      const retried = await build(new MemoryRestIdempotencyStore());
      const second = await retried.inject({ method: 'POST', url: `/v1/payments/${id}/refund`, headers, payload: { amount: '10' } });
      expect(second.statusCode, second.payload).toBe(200);

      // 90, not 80. One business event, one movement.
      expect(await clearingOf(m.id)).toBe('90');
      expect(new Set(keysMatching('payment.refund:')).size).toBe(1);

      // AND the projection agrees with the book. A stable ledger key alone would
      // leave the balance right and `refundedAmount` doubled, because
      // `totalsFor` sums every `refunded` event — which is why the replay is
      // refused in `refundInner` rather than left to the ledger to absorb.
      expect(second.json().refundedAmount).toBe('10');
      const read = await retried.inject({ method: 'GET', url: `/v1/payments/${id}`, headers: signed() });
      expect(read.json().refundedAmount).toBe('10');
    });

    /**
     * The other half of deriving identity from the caller's key: a DIFFERENT
     * key is a different business event and must still be able to refund again.
     * Without this, the fix above would turn "stable identity" into "one refund
     * per payment, ever".
     */
    it('a DIFFERENT Idempotency-Key is a second, real partial refund', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await captured(http, m.id);

      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers: { ...signed(), 'idempotency-key': `refund:${id}:first` },
        payload: { amount: '10' },
      });
      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers: { ...signed(), 'idempotency-key': `refund:${id}:second` },
        payload: { amount: '10' },
      });

      expect(await clearingOf(m.id)).toBe('80');
      expect(new Set(keysMatching('payment.refund:')).size).toBe(2);
    });

    /**
     * An explicit `refundId` in the body is the merchant's own business key and
     * must keep winning over anything derived from the header.
     */
    it('an explicit body refundId still owns the ledger key', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await captured(http, m.id);

      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers: { ...signed(), 'idempotency-key': `refund:${id}:hdr` },
        payload: { amount: '10', refundId: 'merchant-refund-77' },
      });

      expect(await clearingOf(m.id)).toBe('90');
      expect(keysMatching('payment.refund:')).toEqual([`payment.refund:${id}:merchant-refund-77`]);
    });

    it('same body refundId with a different amount conflicts — no silent success', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await captured(http, m.id);

      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers: { ...signed(), 'idempotency-key': `refund:${id}:a1` },
        payload: { amount: '10', refundId: 'merchant-refund-bind' },
      });
      const conflict = await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers: { ...signed(), 'idempotency-key': `refund:${id}:a2` },
        payload: { amount: '50', refundId: 'merchant-refund-bind' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('pay.refund_id_conflict');
      expect(await clearingOf(m.id)).toBe('90');
      expect(new Set(keysMatching('payment.refund:')).size).toBe(1);
    });

    it('empty body refundId uses restRefundId — one stable ledger key', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await captured(http, m.id);
      const headers = { ...signed(), 'idempotency-key': `refund:${id}:blank` };

      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers,
        payload: { amount: '10', refundId: '' },
      });
      // Journal lost — same empty body + same key still once (not payment.refund: twice).
      const retried = await build(new MemoryRestIdempotencyStore());
      await retried.inject({
        method: 'POST',
        url: `/v1/payments/${id}/refund`,
        headers,
        payload: { amount: '10', refundId: '' },
      });
      expect(await clearingOf(m.id)).toBe('90');
      expect(new Set(keysMatching('payment.refund:')).size).toBe(1);
      const keys = keysMatching('payment.refund:');
      // Namespaced by paymentId first, then rest:<paymentId>:<digest>.
      expect(keys[0]).toMatch(new RegExp(`^payment\\.refund:${id}:rest:${id}:`));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5 · DOCTRINE §0.6 — THE SURFACE HOLDS NO BALANCE OF ITS OWN
  // ═══════════════════════════════════════════════════════════════════════════

  describe('doctrine §0.6 through the public surface', () => {
    it('the balances route answers from the ledger, matching what the ledger says', async () => {
      const http = await build(new MemoryRestIdempotencyStore());
      const m = await merchant();
      const id = await authorizedPayment(http, m.id, '100');
      await http.inject({
        method: 'POST',
        url: `/v1/payments/${id}/capture`,
        headers: { ...signed(), 'idempotency-key': `capture:${id}` },
        payload: {},
      });

      const res = await http.inject({
        method: 'GET',
        url: `/v1/balances?merchantId=${m.id}&assetId=${ASSET}`,
        headers: signed(),
      });

      expect(res.json().clearing).toBe(await clearingOf(m.id));
      expect(res.json().available).toBe(await proceedsOf(m.id));
    });
  });
});

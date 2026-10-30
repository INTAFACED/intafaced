import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes, stampPostAttempts, userAvailable, type LedgerClient } from '@intafaced/ledger-client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { payCustodyOpenItemsReplySchema, type Context } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkState } from '../../registries/policy.js';
import { UserMoneyService } from '../../user-money-service.js';
import { RailRegistry } from '../../rails/registry.js';
import { CryptoNativeAdapter } from '../../rails/crypto-native.js';
import { MemoryChain } from '../../rails/chain-port.js';
import { createFounderAuthority } from '../../founder-authority.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { CustodyDepositBook } from './book.js';

/**
 * `founderAdmin.depositOpenItems.list` (OPS-reconciliation-02, J-ops-console-27 #8) against a real Postgres: every row is made
 * by the real deposit book and the real engines, never written in by hand, and the founder check is the real one in front of
 * an identity that answers per caller. TEST figures only.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_deposit_open_items_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-custody-deposit-secret-at-least-32-chars';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const FOUNDER = randomUUID();
const STAFF = randomUUID();
const ALICE_ETH = '0x00000000000000000000000000000000000000a1';
const ALICE_EXTRA = '0x00000000000000000000000000000000000000a2';
const BOB_ETH = '0x00000000000000000000000000000000000000b1';
const BOB_BASE = '0x00000000000000000000000000000000000000b2';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const network = (networkId: string): NetworkState =>
  ({
    networkId,
    displayName: networkId,
    assetCodes: ['USDT'],
    confirmationsRequired: 12,
    enabled: true,
    feeEstimateSource: 'fixed',
    feeEstimateAmount: '1',
  }) as NetworkState;

const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const principalFor = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: randomUUID(),
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
  requestId: randomUUID(),
  forwardedPrincipal: principal ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});
/** Identity: the founder is enabled, the staff member is an operator whose founder entitlement is revoked, anyone else is not one. */
const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
  const { userId } = JSON.parse(String((init as RequestInit).body)) as { userId: string };
  const data =
    userId === FOUNDER
      ? { status: 'enabled', userId, version: '1', changedAt: '2026-10-10T00:00:00Z' }
      : userId === STAFF
        ? { status: 'revoked', userId, version: '2', changedAt: '2026-10-10T00:00:00Z' }
        : { status: 'not_operator', userId };
  return new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
});

describe('founderAdmin.depositOpenItems (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger!: MemoryLedger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: (principal: Principal | null, service?: string | null) => any;

  /** The memory ledger as the HTTP client presents it: a refused post carries how many attempts it took (one here). */
  const oneAttempt = (): LedgerClient =>
    new Proxy(ledger, {
      get(target, prop) {
        if (prop === 'post') {
          return async (request: Parameters<LedgerClient['post']>[0]) => {
            try {
              return await target.post(request);
            } catch (err) {
              stampPostAttempts(err, 1);
              throw err;
            }
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  const book = () => {
    const money = new UserMoneyService(
      db.sql,
      oneAttempt(),
      new RailRegistry([new CryptoNativeAdapter({ chain: new MemoryChain(), secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]),
      { operatorCreditRails: [] },
    );
    return new CustodyDepositBook({
      sql: db.sql,
      postDeposit: (input) => money.postCustodyDeposit(input),
      reverseDeposit: (input) => money.reverseCustodyDeposit(input),
      registries: { listRoutableNetworks: async () => [network('ethereum'), network('base')] },
    });
  };
  const seen = (address: string, n: number, amount: string, confirmations = 12) => ({
    address,
    txHash: tx(n),
    outputIndex: 0,
    assetId: 'USDT',
    amount: parseAmount(amount),
    confirmations,
  });
  const founder = () => api(principalFor(FOUNDER)).founderAdmin.depositOpenItems;
  const rows = async () =>
    (await db.sql`SELECT id, status, reason, credited_at FROM pay.custody_deposits ORDER BY id`).map((r) => ({ ...r }));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const router = createPayNamespaces({
      founderAuthority: createFounderAuthority({ ...identity, fetcher }),
      depositOpenItems: { sql: db.sql },
    });
    api = (principal, service = null) => router.createCaller(ctxOf(principal, service));
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);
  beforeEach(async () => {
    ledger = new MemoryLedger();
    fetcher.mockClear();
    await db.sql`TRUNCATE pay.custody_deposit_travel_rule_events, pay.custody_deposit_travel_rule, pay.travel_rule_inbound_rule_events, pay.custody_deposits, pay.custody_deposit_settings, pay.custody_deposit_addresses, pay.custody_deposit_reorgs`;
    for (const net of ['ethereum', 'base']) {
      await db.sql`
        INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, set_by)
        VALUES ('USDT', ${net}, ${net}, '10', 5, 'test-profile')`;
    }
    await db.sql`INSERT INTO pay.travel_rule_inbound_rule_events (asset_id, applies, threshold, fields, reason, set_by) VALUES ('USDT', false, NULL, '[]', 'TEST rule off', 'test-profile')`;
    await db.sql`
      INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at) VALUES
        (${ALICE}, 'USDT', 'ethereum', 0, ${ALICE_ETH}, NULL),
        (${ALICE}, 'USDT', 'ethereum', 1, ${ALICE_EXTRA}, now() - interval '1 hour'),
        (${BOB}, 'USDT', 'ethereum', 0, ${BOB_ETH}, NULL),
        (${BOB}, 'USDT', 'base', 0, ${BOB_BASE}, NULL)`;
  }, 30_000);

  /**
   * Alice: one credited 25 (not an item), one 5 under the minimum (held), one 25 to her expired extra address (held), and one
   * credited 30 the chain took back after she spent 20 of it (reversal_unfunded). Bob: 7 under the minimum on base (held) and
   * one still confirming on ethereum (not an item).
   */
  async function scene() {
    const b = book();
    expect(await b.receive(seen(ALICE_ETH, 1, '25'))).toMatchObject({ status: 'credited' });
    expect(await b.receive(seen(ALICE_ETH, 2, '5'))).toMatchObject({ status: 'below_minimum' });
    expect(await b.receive(seen(ALICE_EXTRA, 3, '25'))).toMatchObject({ status: 'held_for_release', reason: 'address_expired' });
    expect(await b.receive(seen(ALICE_ETH, 4, '30'))).toMatchObject({ status: 'credited' });
    await ledger.post(
      recipes.withdrawHold({
        userId: ALICE,
        assetId: 'USDT',
        amount: parseAmount('45'),
        rail: 'crypto-native',
        withdrawalId: 'test-spend',
      }),
    );
    expect(await b.reverse({ address: ALICE_ETH, txHash: tx(4), outputIndex: 0 })).toEqual({
      state: 'recorded',
      status: 'needs_review',
      reason: 'reversal_unfunded',
    });
    expect(await b.receive(seen(BOB_BASE, 5, '7'))).toMatchObject({ status: 'below_minimum' });
    expect(await b.receive(seen(BOB_ETH, 6, '40', 3))).toMatchObject({ status: 'confirming' });
    // The ledger booked the two credits only: the held ones posted nothing, the unfunded reversal posted nothing.
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(parseAmount('10'));
  }

  it('lists every open item across customers, positive when custody holds it and negative when the ledger does, with sums', async () => {
    await scene();
    const reply = await founder().list({});
    expect(payCustodyOpenItemsReplySchema.parse(reply)).toEqual(reply);
    expect(reply.total).toBe(4);
    expect(
      reply.items.map(
        (i: { txHash: string; kind: string; signedAmount: string; userId: string; status: string; reason: string | null }) => [
          i.txHash,
          i.kind,
          i.signedAmount,
          i.userId,
          i.status,
          i.reason,
        ],
      ),
    ).toEqual([
      [tx(2), 'held', '5', ALICE, 'below_minimum', 'below_minimum'],
      [tx(3), 'held', '25', ALICE, 'held_for_release', 'address_expired'],
      [tx(4), 'reversal_unfunded', '-30', ALICE, 'needs_review', 'reversal_unfunded'],
      [tx(5), 'held', '7', BOB, 'below_minimum', 'below_minimum'],
    ]);
    expect(reply.items.every((i: { amount: string; signedAmount: string }) => i.signedAmount.replace('-', '') === i.amount)).toBe(true);
    expect(reply.sums).toEqual([
      { networkId: 'base', assetId: 'USDT', held: '7', heldCount: 1, reversalUnfunded: '0', reversalUnfundedCount: 0, net: '7' },
      { networkId: 'ethereum', assetId: 'USDT', held: '30', heldCount: 2, reversalUnfunded: '30', reversalUnfundedCount: 1, net: '0' },
    ]);
  });

  it('filters by network and asset, and pages with a total and sums over every match, not only the page', async () => {
    await scene();
    const eth = await founder().list({ networkId: 'ethereum', limit: 1 });
    expect(eth.total).toBe(3);
    expect(eth.items).toHaveLength(1);
    expect(eth.items[0].txHash).toBe(tx(2));
    expect(eth.sums).toEqual([
      { networkId: 'ethereum', assetId: 'USDT', held: '30', heldCount: 2, reversalUnfunded: '30', reversalUnfundedCount: 1, net: '0' },
    ]);
    const next = await founder().list({ networkId: 'ethereum', limit: 2, offset: 1 });
    expect(next.items.map((i: { txHash: string }) => i.txHash)).toEqual([tx(3), tx(4)]);
    const none = await founder().list({ assetId: 'USDC' });
    expect(none).toEqual({ items: [], total: 0, sums: [] });
  });

  it('a negative net when only an unfunded reversal is open', async () => {
    const b = book();
    await b.receive(seen(ALICE_ETH, 4, '30'));
    await ledger.post(
      recipes.withdrawHold({
        userId: ALICE,
        assetId: 'USDT',
        amount: parseAmount('30'),
        rail: 'crypto-native',
        withdrawalId: 'test-spend',
      }),
    );
    await b.reverse({ address: ALICE_ETH, txHash: tx(4), outputIndex: 0 });
    expect((await founder().list({})).sums).toEqual([
      { networkId: 'ethereum', assetId: 'USDT', held: '0', heldCount: 0, reversalUnfunded: '30', reversalUnfundedCount: 1, net: '-30' },
    ]);
  });

  it('an item leaves the list when it is resolved: a covered reversal reverses once and is no longer open', async () => {
    const b = book();
    await b.receive(seen(ALICE_ETH, 4, '30'));
    await ledger.post(
      recipes.withdrawHold({
        userId: ALICE,
        assetId: 'USDT',
        amount: parseAmount('30'),
        rail: 'crypto-native',
        withdrawalId: 'test-spend',
      }),
    );
    await b.reverse({ address: ALICE_ETH, txHash: tx(4), outputIndex: 0 });
    expect((await founder().list({})).total).toBe(1);
    // Topped up (TEST), the next reorg delivery covers the reversal and posts it.
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('30'), rail: 'test', railRef: 'top-up' }));
    expect(await b.reverse({ address: ALICE_ETH, txHash: tx(4), outputIndex: 0 })).toMatchObject({ status: 'reversed' });
    expect(await founder().list({})).toEqual({ items: [], total: 0, sums: [] });
  });

  it('refuses a customer, a staff member who is not a live founder, an API key, a service and no session, with the typed code and no rows', async () => {
    await scene();
    const before = await rows();
    const refusals: Array<[string, Principal | null, string | null, string, string]> = [
      ['a customer', principalFor(ALICE), null, 'FORBIDDEN', 'operator.denied'],
      [
        'staff whose founder entitlement is revoked',
        principalFor(STAFF, { scopes: ['admin:read', 'admin:write', 'admin:compliance'] }),
        null,
        'FORBIDDEN',
        'operator.denied',
      ],
      ['the founder through an API key', principalFor(FOUNDER, { kid: randomUUID() }), null, 'FORBIDDEN', 'operator.denied'],
      ['the founder without MFA', principalFor(FOUNDER, { mfa: false }), null, 'FORBIDDEN', 'operator.denied'],
      ['a service', principalFor(FOUNDER), 'svc-bank', 'FORBIDDEN', 'operator.denied'],
    ];
    for (const [who, principal, service, code, message] of refusals) {
      const err = await api(principal, service)
        .founderAdmin.depositOpenItems.list({})
        .then(
          () => null,
          (e: { code: string; message: string }) => e,
        );
      expect(err, who).toMatchObject({ code, message });
    }
    const anonymous = await api(null)
      .founderAdmin.depositOpenItems.list({})
      .then(
        () => null,
        (e: { code: string }) => e,
      );
    expect(anonymous).toMatchObject({ code: 'UNAUTHORIZED' });
    // The refusal changed nothing, and a malformed input is refused only after the caller is (no shape learned first).
    expect(await rows()).toEqual(before);
    const shape = await api(principalFor(ALICE))
      .founderAdmin.depositOpenItems.list({ limit: 'all' })
      .then(
        () => null,
        (e: { code: string; message: string }) => e,
      );
    expect(shape).toMatchObject({ code: 'FORBIDDEN', message: 'operator.denied' });
    // The founder reads the same rows the refusals were kept from.
    expect((await founder().list({})).total).toBe(4);
  });
});

/**
 * Builder-fee versions (J-cex-spot-17 #1 #3), real Postgres via TEST_DATABASE_URL and the TEST venue simulator over
 * loopback HTTP: written by two operators through `admin.fees.set`, never above the venue's own cap, and an order
 * prepared through the user-venue door carries the version in force when it was prepared, which the venue keeps on the
 * order after a later version takes effect.
 */
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import { div, mul, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { isTestVenue, type PlaceUserOrderIntent, type PreparedVenueAction, type UserVenueAccount } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { MemoryApprovalBook, payloadHash } from '../admin/common.js';
import { TradeOpsAdmin, type VenueMarketsRead } from '../admin/service.js';
import { principalFor } from '../spot/testing.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { builderFeesAt } from './builder-fee-versions.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const a = parseAmount;
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const USER = '11111111-1111-4111-8111-1111111111b7';
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);
const reason = 'TEST builder-fee version';
const BUILDER = '0x7e57000000000000000000000000000000000b1d';
const customer = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333b7',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

/** TEST wallets with fixed keys derived from public names. */
function wallet(name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet builder-fee versions ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role: 'owner' as const, address },
    async sign(prepared: PreparedVenueAction) {
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

const schedule = (spotBps: string, perpBps = '1') => ({
  makerBps: '8',
  takerBps: '10',
  builderFees: {
    'test-venue-sim': { defaultGroup: 'spot', marketGroups: { 'BTC-PERP': 'perpetuals' }, groups: { spot: spotBps, perpetuals: perpBps } },
  },
});

describe('builder-fee versions (PG-hard, TEST venue over loopback)', () => {
  let db: TestDatabase;
  let server: http.Server;
  let sim: TestVenueSimulator;
  let venueUrl: string;
  let book: MemoryApprovalBook;
  let now: Date;
  let admin: TradeOpsAdmin;
  let doorOn: boolean;
  let door: UserVenueDoor;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
    ({ server, sim, url: venueUrl } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  }, 120_000);
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE trade.fee_schedule_versions, trade.operator_audit RESTART IDENTITY CASCADE`;
    book = new MemoryApprovalBook();
    now = new Date('2026-11-09T10:00:00.000Z');
    doorOn = true;
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: venueUrl, timeoutMs: 2000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { require: async () => ({ stepUpEventId: 'unused', consumedAt: null, replayed: false }) },
      // The boot owner value (LOCAL TEST): used only when no version in force names builder fees for the venue.
      builder: { address: BUILDER, feeBps: a('0.5') },
      builderFeesAt: async (at) => (await builderFeesAt(db.sql, at)).book,
      now: () => now,
    });
    const venueMarkets = async (): Promise<VenueMarketsRead | null> => {
      if (!doorOn) return null;
      const v = await door.venue();
      const m = await v.markets(null);
      return { venueId: v.venue.id, displayName: v.venue.displayName, test: isTestVenue(v.venue), markets: m.value, asOf: m.asOf };
    };
    admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger: null,
      reconcileOrder: async () => {
        throw new Error('unused');
      },
      cancelOrder: async () => undefined,
      venueMarkets,
      now: () => now,
    });
  });

  let approvals = 0;
  /** The approval the last `write` filed, so a test can show it is still unspent after a refusal. */
  let last: { approvalId: string; payloadHash: string; expectedVersion: string } | null = null;
  /** Two operators: one proposes `body`, a second approves it; the first writes it. */
  async function write(body: Record<string, unknown>, effectiveAt: string, expectedVersion: string) {
    const approvalId = `bf-${++approvals}`;
    const hash = payloadHash({ actionType: 'trade.fee_schedule_set', schedule: body, effectiveAt, expectedVersion, reason });
    last = { approvalId, payloadHash: hash, expectedVersion };
    book.put({
      approvalId,
      actionType: 'trade.fee_schedule_set',
      targetService: 'svc-trade',
      targetId: 'spot-fee-schedule',
      expectedVersion,
      payloadHash: hash,
      requesterId: OP,
      approverId: APPROVER,
      operationId: `op-${approvalId}`,
    });
    return admin.feeScheduleSet(writer(), {
      schedule: body,
      effectiveAt,
      expectedVersion,
      reason,
      approvalId,
      operationId: `op-${approvalId}`,
    });
  }

  it("reads the venue's own cap per market, as the venue publishes it", async () => {
    const caps = await admin.builderFeeCaps(writer());
    expect(caps).toMatchObject({ venueId: 'test-venue-sim', test: true });
    expect(caps.markets).toEqual([
      { symbol: 'BTC-USDC', kind: 'spot', capBps: '100' },
      { symbol: 'BTC-PERP', kind: 'perpetual', capBps: '10' },
    ]);
    doorOn = false;
    await expect(admin.builderFeeCaps(writer())).rejects.toMatchObject({ code: 'trade.user_venue_off' });
  });

  it("refuses a version above the venue's cap, or with the door off, before the approval is used; at the cap it is written", async () => {
    await expect(write(schedule('2', '10.5'), '2026-11-09T10:05:00.000Z', '0')).rejects.toMatchObject({
      code: 'trade.builder_fee_above_venue_cap',
    });
    await expect(write(schedule('100.0001'), '2026-11-09T10:05:00.000Z', '0')).rejects.toMatchObject({
      code: 'trade.builder_fee_above_venue_cap',
    });
    // The refused approval is still unspent: the cap is checked before the approval is used.
    const refused = last!;
    expect(
      await book.consume({
        approvalId: refused.approvalId,
        actionType: 'trade.fee_schedule_set',
        targetId: 'spot-fee-schedule',
        expectedVersion: refused.expectedVersion,
        payloadHash: refused.payloadHash,
        operationId: `op-${refused.approvalId}`,
      }),
    ).toMatchObject({ ok: true });
    doorOn = false;
    await expect(write(schedule('2'), '2026-11-09T10:05:00.000Z', '0')).rejects.toMatchObject({ code: 'trade.builder_fee_venue_unknown' });
    await expect(write(schedule(''), '2026-11-09T10:05:00.000Z', '0')).rejects.toMatchObject({ code: 'trade.builder_fee_blank' });
    expect(await db.sql`SELECT version FROM trade.fee_schedule_versions`).toHaveLength(0);
    doorOn = true;
    expect(await write(schedule('100', '10'), '2026-11-09T10:05:00.000Z', '0')).toMatchObject({ version: '1' });
  });

  it('an order carries the version in force when it is prepared; one still open keeps it after a new version takes effect', async () => {
    const trader = wallet('trader');
    const maker = wallet('maker');
    const account: UserVenueAccount = { venueId: 'test-venue-sim', owner: trader.address, subAccount: null };
    sim.deposit(account, 'BTC', a('1'), `chain:bf-versions:${Date.now()}`);
    sim.deposit({ ...account, owner: maker.address }, 'USDC', a('100000'), `chain:bf-versions-maker:${Date.now()}`);

    // v1: 2 bps on spot from 10:01; v2: 3 bps from 10:10.
    expect(await write(schedule('2'), '2026-11-09T10:01:00.000Z', '0')).toMatchObject({ version: '1' });
    expect(await write(schedule('3'), '2026-11-09T10:10:00.000Z', '1')).toMatchObject({ version: '2' });

    // Before v1 is in force, the boot owner value applies.
    const early = await door.preview(customer, trader.address, sell(1));
    expect(early.value.builderFee).toEqual({ known: true, value: { asset: 'USDC', amount: fee('60005', '0.01', '0.5') } });

    const approve = await door.prepare(customer, {
      owner: trader.address,
      signer: trader.signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') },
      actionKey: `approve-builder:${trader.address}:1`,
    });
    expect((await door.submit(customer, approve.actionKey, await trader.sign(approve.prepared))).outcome).toMatchObject({ accepted: true });

    // 10:05: v1 is in force. The order prepared now carries 2 bps, and the venue rests it.
    now = new Date('2026-11-09T10:05:00.000Z');
    const placed = await door.prepare(customer, { owner: trader.address, signer: trader.signer, intent: sell(1) });
    expect(placed.prepared.builderFee).toEqual({ builder: BUILDER, feeBps: a('2') });
    const sent = await door.submit(customer, placed.actionKey, await trader.sign(placed.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    const venueOrderId = sent.outcome.definite && sent.outcome.accepted ? sent.outcome.venueRef : null;
    expect(venueOrderId).toMatch(/^sim-/);

    // 10:11: v2 is in force. A new order carries 3 bps; the stored order keeps its 2 bps, never re-prepared at 3.
    now = new Date('2026-11-09T10:11:00.000Z');
    const next = await door.prepare(customer, { owner: trader.address, signer: trader.signer, intent: sell(2) });
    expect(next.prepared.builderFee).toEqual({ builder: BUILDER, feeBps: a('3') });
    await expect(door.prepare(customer, { owner: trader.address, signer: trader.signer, intent: sell(1) })).rejects.toMatchObject({
      code: 'trade.venue_builder_fee_changed',
    });

    // The order placed under v1 fills now, after v2 took effect, and the venue charges it the 2 bps it was signed with.
    const buy = await sim.prepare({ ...account, owner: maker.address }, maker.signer, {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: a('0.01'),
      price: a('60005'),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: 'order:bf-versions-maker:1',
      builderFee: null,
    });
    expect(await sim.submit(buy, await maker.sign(buy))).toMatchObject({ accepted: true });
    const fills = (await sim.fills(account, new Date(0))).value.filter((f) => f.venueClientOrderId === placed.prepared.venueClientOrderId);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ role: 'maker', builderFee: fee('60005', '0.01', '2'), feeAsset: 'USDC' });
  });
});

/** An ALO sell of 0.01 BTC at 60005: inside the TEST ladder's spread, so it rests until bought. */
function sell(n: number): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'sell',
    type: 'limit',
    amount: parseAmount('0.01'),
    price: parseAmount('60005'),
    timeInForce: 'ALO',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:bf-versions:${n}`,
    builderFee: null,
  };
}

/** The builder fee the venue charges on a fill: the notional times the bps, rounded up (venue-sim's own rule). */
function fee(price: string, amount: string, bps: string): Amount {
  return div(mul(mul(parseAmount(price), parseAmount(amount), 'ceil'), parseAmount(bps), 'ceil'), parseAmount('10000'), 'ceil');
}

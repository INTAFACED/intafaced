import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { venueClientOrderId, type PlaceUserOrderIntent, type UserVenue } from '@intafaced/venue-contracts';
import { HttpUserVenue } from '../venue/http-user-venue.js';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { TradeOpsError, type AuditWrite } from './common.js';
import { readVenueOrder, rejectOf, venueOrderReadWire } from './venue-order-read.js';

// J-cex-spot-18 #1 #2 #5: the support desk reads a customer's routed order from the venue by the customer's own address,
// and every read that found it writes one audit row naming the operator and the customer.
const CUSTOMER = '22222222-2222-4222-8222-2222222222a1';
const OTHER = '22222222-2222-4222-8222-2222222222b2';
const AGENT = { userId: 'operator-b', sid: 's-op', scopes: ['admin:read'] } as Principal;
const NOBODY = { userId: 'customer-x', sid: 's-c', scopes: ['trade:read'] } as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade operator venue order read')));
const owner = key.address.toLowerCase();

let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
let venue: UserVenue;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));

/** An audit writer that keeps each row the read writes. */
function auditSql() {
  const rows: AuditWrite[] = [];
  const audit = async (row: AuditWrite) => {
    rows.push(row);
    return `audit-${rows.length}`;
  };
  return { audit, rows };
}

/** The customer places one order from their own venue account through our door's store: prepared, signed, sent. */
async function placeThroughDoor(store: InMemoryPreparedActionStore, userId: string, intent: PlaceUserOrderIntent) {
  const account = { venueId: sim.venue.id, owner, subAccount: null };
  const prepared = await venue.prepare(account, { role: 'owner', address: owner }, intent);
  const t = prepared.typedData as TestVenueTypedData;
  const signature = { digest: prepared.digest, signature: await key.signTypedData({ ...t }), signedBy: owner };
  await store.insertOnce(userId, intent.clientOrderKey, prepared, new Date());
  await store.signOnce(userId, intent.clientOrderKey, signature, new Date());
  const outcome = await venue.submit(prepared, signature);
  await store.recordOutcome(userId, intent.clientOrderKey, outcome);
  return { cloid: venueClientOrderId(sim.venue.id, intent.clientOrderKey), outcome };
}

const bid = (clientOrderKey: string, price: string, amount = '0.001'): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'limit',
  amount: parseAmount(amount),
  price: parseAmount(price),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey,
  builderFee: null,
});

describe('readVenueOrder (J-cex-spot-18 #1)', () => {
  it("reads the customer's resting order from the venue by their own address, and audits the lookup once", async () => {
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', parseAmount('1000'), 'chain:j18-read:1');
    const store = new InMemoryPreparedActionStore();
    const { cloid } = await placeThroughDoor(store, CUSTOMER, bid(`order:${owner}:BTC-USDC:j18-rest`, '50000'));
    const { audit, rows } = auditSql();
    const read = await readVenueOrder({ audit, venue: async () => venue, store, now: () => new Date() }, AGENT, {
      accountId: CUSTOMER,
      venueClientOrderId: cloid.toUpperCase().replace('0X', '0x'),
    });
    expect(read).toMatchObject({ accountId: CUSTOMER, owner, venueClientOrderId: cloid, sent: 'accepted', reject: null });
    expect(read.order).toMatchObject({ venueClientOrderId: cloid, status: 'open', symbol: 'BTC-USDC' });
    expect(read.fills).toEqual([]);
    // One audit row: kind, the operator, the customer, the order.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'venue_orders.get', operatorId: 'operator-b', accountId: CUSTOMER, objectId: cloid });
    // On the wire every amount is a decimal string.
    expect(venueOrderReadWire(read)).toMatchObject({ order: { price: '50000', amount: '0.001' } });
  });

  it("another person's order under the same id is never this customer's; a wrong id or no account refuses by name", async () => {
    const store = new InMemoryPreparedActionStore();
    const { cloid } = await placeThroughDoor(store, CUSTOMER, bid(`order:${owner}:BTC-USDC:j18-theirs`, '50001'));
    const { audit, rows } = auditSql();
    const deps = { audit, venue: async () => venue, store, now: () => new Date() };
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'answered',
        (e: unknown) => (e instanceof TradeOpsError ? e.code : String(e)),
      );
    expect(await code(readVenueOrder(deps, AGENT, { accountId: OTHER, venueClientOrderId: cloid }))).toBe('venue_order_not_found');
    expect(await code(readVenueOrder(deps, AGENT, { accountId: CUSTOMER, venueClientOrderId: '0x12' }))).toBe('venue_order_id_invalid');
    expect(await code(readVenueOrder(deps, AGENT, { accountId: ' ', venueClientOrderId: cloid }))).toBe('venue_order_account_required');
    // Nothing was read, so nothing was audited.
    expect(rows).toHaveLength(0);
    // A customer's own session is not an operator.
    await expect(readVenueOrder(deps, NOBODY, { accountId: CUSTOMER, venueClientOrderId: cloid })).rejects.toThrow();
  });

  it('with the door off the read refuses trade.user_venue_off: the blocker, never an empty order', async () => {
    const { audit, rows } = auditSql();
    await expect(
      readVenueOrder({ audit, venue: null, store: new InMemoryPreparedActionStore(), now: () => new Date() }, AGENT, {
        accountId: CUSTOMER,
        venueClientOrderId: `0x${'a'.repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: 'trade.user_venue_off' });
    expect(rows).toHaveLength(0);
  });

  it("a send the venue refused has no venue order, and its reject reason is the venue's own refusal", async () => {
    const store = new InMemoryPreparedActionStore();
    // More than the account holds: the venue refuses the order.
    const { cloid, outcome } = await placeThroughDoor(store, CUSTOMER, bid(`order:${owner}:BTC-USDC:j18-refused`, '60000', '1000'));
    expect(outcome).toMatchObject({ definite: true, accepted: false });
    const { audit } = auditSql();
    const read = await readVenueOrder({ audit, venue: async () => venue, store, now: () => new Date() }, AGENT, {
      accountId: CUSTOMER,
      venueClientOrderId: cloid,
    });
    expect(read.sent).toBe('refused');
    expect(read.order).toBeNull();
    expect(read.reject).toMatchObject({ source: 'venue_refusal', code: (outcome as { refusal: { code: string } }).refusal.code });
  });
});

describe('rejectOf', () => {
  it('names none when nothing is recorded', () => {
    expect(rejectOf(null, null)).toBeNull();
  });
});

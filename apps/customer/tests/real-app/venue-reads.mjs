import { keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { api, toUnits, tool } from './stack.mjs';

// The person's venue account, read from the stack's LOCAL TEST venue (packages/venue-sim) itself, never our ledger,
// engine or door. svc-trade's door is off unless LOCAL_STACK_USER_VENUE=on: `venueOn` and `venueOff` switch it. All TEST.

/** The LOCAL TEST venue's own loopback address (local-test-stack.mjs PORTS['test-venue']). */
export const TEST_VENUE = 'http://127.0.0.1:14560';

/** The venue's markets for the venue journeys (local-test-venue.mjs: BTC-USDC cash spot, BTC-PERP isolated only). */
export const VENUE_SPOT = 'BTC-USDC';
export const VENUE_PERP = 'BTC-PERP';

/** Trade restarted with LOCAL_STACK_USER_VENUE set to `value`, or unset. */
function restartTrade(value) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  if (value === null) delete process.env.LOCAL_STACK_USER_VENUE;
  else process.env.LOCAL_STACK_USER_VENUE = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}

/** Trade restarted with the user-venue door on, pointed at the LOCAL TEST venue (which the restart starts). */
export function venueOn() {
  restartTrade('on');
}

/** Trade restarted with the door off again, as every other journey expects it. */
export function venueOff() {
  restartTrade(null);
}

/** The person's API session: `who.client` when the step signed in with its second factor, or a fresh sign-in. */
const clientOf = (who) => who.client ?? api(who);

/** The door's status for this person: on, the venue up, and a TEST venue, labelled TEST. */
export async function venueStatus(who) {
  const { status, body } = await (await clientOf(who)).get('/api/v1/venue/status');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body, 'the user-venue door is on and the TEST venue answers').toMatchObject({
    enabled: true,
    available: true,
    test: true,
    label: 'TEST',
  });
  return body;
}

/** The TEST venue's own route for each read, on loopback: never svc-trade's door, which the desk uses. */
const SIM_READS = {
  balances: '/balances',
  'orders/open': '/open-orders',
  'orders/by-client-id': '/order-by-client-id',
  fills: '/fills',
  positions: '/positions',
};

/** One read of `owner`'s venue account from the TEST venue itself, so a door that misreports one shows. */
export async function venueRead(who, route, owner, query = {}) {
  // `withdrawals/<nonce>` reads one withdrawal by the venue nonce it was signed with.
  const nonce = route.startsWith('withdrawals/') ? decodeURIComponent(route.slice('withdrawals/'.length)) : undefined;
  const path = nonce ? '/withdrawal' : SIM_READS[route];
  expect(path, `${route} is a venue read`).toBeTruthy();
  const account = { venueId: await testVenueId(), owner: owner.trim().toLowerCase(), subAccount: null };
  const extra = {
    ...(nonce === undefined ? {} : { nonce }),
    ...(query.clientOrderId === undefined ? {} : { venueClientOrderId: query.clientOrderId }),
    ...(query.since === undefined ? {} : { since: query.since }),
  };
  const { status, body } = await testVenue(path, { account, ...extra });
  expect(status, `${route}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  expect(typeof body.asOf, `${route} carries the venue's as-of time`).toBe('string');
  expect(Number.isNaN(Date.parse(body.asOf)), body.asOf).toBe(false);
  return body;
}

/** The venue's balance of `asset` for `owner`'s venue account, as decimal strings, with the read's as-of time. */
export async function venueBalance(who, owner, asset) {
  const read = await venueRead(who, 'balances', owner);
  const row = read.value.find((b) => b.asset === asset) ?? { asset, free: '0', locked: '0', total: '0' };
  return { ...row, asOf: read.asOf };
}

/** The venue's open orders for `owner`. */
export async function venueOpenOrders(who, owner) {
  return (await venueRead(who, 'orders/open', owner)).value;
}

/** The venue's own record of the order the client id names, or null. */
export async function venueOrder(who, owner, clientOrderId) {
  return (await venueRead(who, 'orders/by-client-id', owner, { clientOrderId })).value;
}

/** The venue's fills for `owner` since `since`. */
export async function venueFills(who, owner, since) {
  return (await venueRead(who, 'fills', owner, { since: since.toISOString() })).value;
}

/** The venue's positions for `owner`. */
export async function venuePositions(who, owner) {
  return (await venueRead(who, 'positions', owner)).value;
}

/** One of the LOCAL TEST venue's own routes (its reads and its TEST controls), straight on loopback. */
export async function testVenue(route, body = {}) {
  const res = await fetch(`${TEST_VENUE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** The venue's id, as the venue names itself. */
export async function testVenueId() {
  const res = await fetch(`${TEST_VENUE}/venue`, { signal: AbortSignal.timeout(10_000) });
  expect(res.status).toBe(200);
  return (await res.json()).venue.id;
}

/** Another TEST trader, sending its own signed orders straight to the venue. */
export async function otherVenueTrader(funds) {
  const key = privateKeyToAccount(generatePrivateKey());
  const owner = key.address.toLowerCase();
  const venueId = await testVenueId();
  const account = { venueId, owner, subAccount: null };
  for (const [asset, amount] of Object.entries(funds)) {
    const { status, body } = await testVenue('/test/deposit', { account, asset, amount, depositRef: `test-trader:${owner}:${asset}` });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.credited).toBe(true);
  }
  return {
    owner,
    account,
    /** One signed limit order of this TEST trader on the venue; returns the venue's definite answer. */
    async place({ symbol, side, amount, price, timeInForce = 'GTC', key: clientOrderKey }) {
      const intent = {
        kind: 'place_order',
        symbol,
        side,
        type: 'limit',
        amount,
        price,
        timeInForce,
        reduceOnly: false,
        clientOrderKey,
        builderFee: null,
      };
      const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: owner }, intent });
      expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
      const signature = await key.signTypedData(prepared.body.typedData);
      const sent = await testVenue('/submit', {
        prepared: prepared.body,
        signature: { digest: prepared.body.digest, signature, signedBy: owner },
      });
      expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
      expect(sent.body, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
      return sent.body;
    },
  };
}

/** The venue's own best bid and ask on `symbol`, never our engine's book. */
export async function venueBook(symbol) {
  const venueId = await testVenueId();
  const makers = ['bid', 'ask'].map((name) =>
    privateKeyToAccount(keccak256(toHex(`intafaced TEST venue maker ${name}`))).address.toLowerCase(),
  );
  const orders = [];
  for (const owner of makers) {
    const { status, body } = await testVenue('/open-orders', { account: { venueId, owner, subAccount: null } });
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    orders.push(...body.value.filter((o) => o.symbol === symbol));
  }
  const bids = orders.filter((o) => o.side === 'buy').map((o) => toUnits(o.price));
  const asks = orders.filter((o) => o.side === 'sell').map((o) => toUnits(o.price));
  expect(bids.length > 0 && asks.length > 0, `the TEST venue has a two-sided book on ${symbol}`).toBe(true);
  return { bid: bids.reduce((a, b) => (b > a ? b : a)), ask: asks.reduce((a, b) => (b < a ? b : a)) };
}

import { expect } from '@playwright/test';
import { approverSessions, makeContext, refusalText } from '../../../../tooling/scripts/local-test-gates.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, bestPrices, toUnits } from './stack.mjs';

// The copy journeys' other actors: the operator who lists a leader (the stack's TEST founder, through svc-trade's own
// operator door, as the founder console would), and the leader's own orders on the real book.

/** The user id behind a TEST account, from its own sign-in. */
export async function userIdOf(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });
  const userId = (await res.json())?.result?.data?.userId;
  if (!userId) throw new Error(`sign-in for ${who.email} refused: ${res.status}`);
  return userId;
}

/** Lists `who` as a copy leader in `marketMode`, as the TEST founder. Returns the public leader ref. */
export async function listLeader(who, displayName, { marketMode = 'spot', tenureStart, assets = ['BTC/USDT'] } = {}) {
  const ctx = await makeContext({ log: () => {} });
  const founders = await approverSessions(ctx);
  const res = await ctx.edge.mutate(
    'trade',
    'copy.ops.upsertListing',
    {
      clientRequestId: `journey-list:${displayName}`,
      leaderUserId: await userIdOf(who),
      displayName,
      marketMode,
      recordKind: 'self_reported',
      state: 'listed',
      assets,
      ...(tenureStart ? { tenureStart } : {}),
    },
    founders.a.token,
  );
  const ref = res.json?.result?.data?.leaderRef;
  if (!ref) throw new Error(`listing ${displayName} refused: ${refusalText(res)}`);
  return ref;
}

/**
 * One IOC order of `who` that fills in full at once against the TEST market maker, at the best price only, so it is a
 * single fill (the copy driver copies each lead fill on its own). It waits until the best level holds the whole amount.
 * An IOC that met nothing because the maker requoted between the read and the order is sent again under a new key; a
 * refused order or a part fill throws, since either would change the trades the journey reads.
 */
export async function takeBest(who, side, amount, clientOrderId, symbol = 'BTC/USDT') {
  const client = await api(who);
  for (let attempt = 0; ; attempt += 1) {
    let level;
    await expect
      .poll(
        async () => {
          const { body } = await bestPrices(symbol);
          level = (side === 'buy' ? body.asks : body.bids)[0];
          return toUnits(level[1]) >= toUnits(amount);
        },
        { timeout: 15_000, message: `the best ${side === 'buy' ? 'ask' : 'bid'} on ${symbol} never held ${amount}` },
      )
      .toBe(true);
    const res = await client.post('/api/v1/orders', {
      symbol,
      type: 'limit',
      side,
      amount,
      price: level[0],
      timeInForce: 'IOC',
      clientOrderId: attempt === 0 ? clientOrderId : `${clientOrderId}-r${attempt}`,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
    let order = res.body;
    expect(order.id, `the order reply has no id: ${JSON.stringify(order).slice(0, 300)}`).toBeTruthy();
    await expect
      .poll(
        async () => {
          const read = await client.get(`/api/v1/orders/${order.id}?symbol=${encodeURIComponent(symbol)}`);
          if (read.status === 200) order = read.body;
          return order.status;
        },
        { timeout: 15_000, message: `${side} ${amount} ${symbol} stayed open` },
      )
      .not.toBe('open');
    const filled = toUnits(order.filled ?? '0');
    if (filled === toUnits(amount)) return order;
    if (filled > 0n || order.status === 'rejected' || attempt === 2)
      throw new Error(`${side} ${amount} ${symbol} at ${level[0]} filled ${order.filled ?? '0'}: ${JSON.stringify(order).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

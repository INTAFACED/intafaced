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
 * One IOC order of `who` that fills in full at once against the TEST market maker. Its limit reaches as deep into the
 * book as twice the amount, so a requote between the depth read and the order still leaves enough to take; it fills at
 * the resting prices. An IOC that met nothing (the maker pulled every level first) is sent again under a new key; a
 * part fill throws, since a split would change the trades the journey reads.
 */
export async function takeBest(who, side, amount, clientOrderId, symbol = 'BTC/USDT') {
  const client = await api(who);
  for (let attempt = 0; ; attempt += 1) {
    const { body: book } = await bestPrices(symbol);
    const levels = side === 'buy' ? book.asks : book.bids;
    let depth = 0n;
    let price = levels[0][0];
    for (const [p, size] of levels) {
      price = p;
      depth += toUnits(size);
      if (depth >= 2n * toUnits(amount)) break;
    }
    const res = await client.post('/api/v1/orders', {
      symbol,
      type: 'limit',
      side,
      amount,
      price,
      timeInForce: 'IOC',
      clientOrderId: attempt === 0 ? clientOrderId : `${clientOrderId}-r${attempt}`,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
    let order = res.body;
    await expect
      .poll(
        async () => {
          const read = await client.get(`/api/v1/orders/${order.id}?symbol=${encodeURIComponent(symbol)}`);
          if (read.status === 200) order = read.body;
          return order.status;
        },
        { timeout: 15_000 },
      )
      .not.toBe('open');
    const filled = toUnits(order.filled ?? '0');
    if (filled === toUnits(amount)) return order;
    if (filled > 0n) throw new Error(`${side} ${amount} ${symbol} filled only ${order.filled}: ${JSON.stringify(order).slice(0, 300)}`);
    if (attempt === 2) throw new Error(`${side} ${amount} ${symbol} met no resting order in 3 tries`);
  }
}

import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { approverSessions, makeContext, refusalText } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, ORIGIN, api, bestPrices } from './stack.mjs';

// The copy journeys' other actors: the operator who lists a leader (the stack's TEST founder, through svc-trade's own
// operator door, as the founder console would), and the leader's own orders on the real book.

/** The user id behind a TEST account, from its own sign-in. */
export async function userIdOf(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: who.email, password: who.password }),
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
      clientRequestId: `journey-list:${randomUUID()}`,
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

/** One IOC order of `who` that takes the best price on the book, so it fills at once against the TEST market maker. */
export async function takeBest(who, side, amount, clientOrderId, symbol = 'BTC/USDT') {
  const { bid, ask } = await bestPrices(symbol);
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol,
    type: 'limit',
    side,
    amount,
    price: side === 'buy' ? ask : bid,
    timeInForce: 'IOC',
    clientOrderId,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  return res.body;
}

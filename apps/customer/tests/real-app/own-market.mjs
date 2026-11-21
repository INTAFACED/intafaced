import { createHash, randomBytes } from 'node:crypto';
import { expect } from './journey.mjs';
import { testVenue, venueInfo } from './venue.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';

// A journey step that prices off a book owns that book. On a shared market (BTC-USDC) whatever another journey left
// resting decides what this step's order meets: J-cex-spot-02 #7 priced a maker buy one tick over the venue maker's bid,
// and a 1 BTC bid J-bank-13 had left above it filled the second trader's sell at once (issue #8546, fixed by #8549 with
// the helper below, which lived in J-cex-spot-02 until it moved here). A fresh market has an empty book that only this
// step trades. garden/no-shared-market-on-book (tooling/lint/oxlint-plugin-garden/shared-market-rule.js) names this file.

let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const hashOf = (body) => `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/**
 * Two operators change one venue market's listing through svc-trade's own two-person door; `journey` names who asked in
 * the reason. The listing's version moves by exactly one.
 */
export async function venueListingWrite(journey, symbol, action, procedure, fields, expectedVersion) {
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const reason = `LOCAL TEST ${journey}: ${procedure} ${symbol}`;
  const ids = await twoPerson(ctx, sessions, {
    actionType: action,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion,
    payloadHash: hashOf({ actionType: action, venueId, symbol, ...fields, expectedVersion, reason }),
    policyVersion: 'trade-venue-markets-v1',
  });
  const res = await ctx.edge.mutate(
    'trade',
    `admin.venueMarkets.${procedure}`,
    { symbol, ...fields, expectedVersion, reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(Number(expectedVersion) + 1);
}

/**
 * A fresh TEST spot market on the TEST venue, listed by two operators and open: no other file trades it, so its book is
 * empty and holds only what this step puts there. `prefix` (letters, such as `JS2`) and `tag` (one letter per use in the
 * file) make the base asset readable in a run's log. Returns `{ symbol, base }`.
 */
export async function ownSpotMarket(journey, prefix, tag) {
  const base = `${prefix}${tag}${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: null,
    maxOrderNotional: null,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  await venueListingWrite(
    journey,
    symbol,
    'trade.venue_listing_set',
    'listingSet',
    { opensAt: new Date(Date.now() - 60_000).toISOString() },
    '0',
  );
  return { symbol, base };
}

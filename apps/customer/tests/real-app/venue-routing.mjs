import { createHash } from 'node:crypto';
import { expect } from './journey.mjs';
import { venueInfo } from './venue.mjs';

// Our routing state for one of the TEST venue's markets, set by two operators through svc-trade's own two-person door
// (services/svc-trade/src/admin/venue-markets.ts routingSet), as J-cex-spot-16 sets it in the console.

const ROUTING_SET = 'trade.venue_routing_set';

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/**
 * Sets our routing for `symbol` to `routing` (show, close_only or stop) and returns the listing as written; nothing is
 * written when it already reads so. `ops` is the journey fixture's `founders.ops()`.
 */
export async function setVenueRouting(ops, symbol, routing, reason) {
  const { gates, ctx, sessions } = await ops;
  const venueId = (await venueInfo()).id;
  const list = await ctx.edge.query('trade', 'admin.venueMarkets.list', undefined, await sessions.a.tradeOpsToken());
  const listing = trpcData(list)?.markets.find((m) => m.symbol === symbol)?.listing;
  expect(listing, list.text.slice(0, 300)).toBeTruthy();
  if (listing.routing === routing) return listing;
  const expectedVersion = String(listing.version);
  const body = { actionType: ROUTING_SET, venueId, symbol, routing, expectedVersion, reason };
  const ids = await gates.twoPerson(ctx, sessions, {
    actionType: ROUTING_SET,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion,
    payloadHash: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`,
    policyVersion: 'trade-venue-markets-v1',
  });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.routingSet',
    { symbol, routing, expectedVersion, reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  const written = trpcData(res)?.listing;
  expect(written?.routing, res.text.slice(0, 300)).toBe(routing);
  return written;
}

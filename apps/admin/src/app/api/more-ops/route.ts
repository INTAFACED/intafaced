import { deskGet, deskPost } from '@/lib/ops-desk/route';

/**
 * More-modules ops desk. GET reads agents, quant and market as the signed-in founder. POST runs one step of a
 * two-founder request to approve, reject or suspend a market vendor (svc-market `vet`: market:ops, a second factor and
 * an identity approval a different founder signed), or to take down one listing (svc-market `ops.takedownListing`, same rules), or to record one venue cost note (svc-ops `recordVenueCost`: ops:write, a second factor and an approval a different founder signed).
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'more');
export const POST = (request: Request) =>
  deskPost(request, 'more', ['market.vendor.vet', 'market.listing.takedown', 'ops.venue_cost.record']);

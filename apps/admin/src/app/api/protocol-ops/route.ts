import { deskGet, deskPost } from '@/lib/ops-desk/route';

/**
 * Protocol ops desk. GET reads svc-protocol, svc-indexer, svc-dex and svc-ops as the signed-in founder. POST runs one step of a
 * two-founder request to hide or restore a pool, or delist or relist a market (svc-ops `protocolListing`: admin:write, a second
 * factor and an identity approval a different founder signed). A hide is a listing decision; nothing on chain changes.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'protocol');
export const POST = (request: Request) =>
  deskPost(request, 'protocol', ['protocol.pool.hide', 'protocol.pool.restore', 'protocol.market.delist', 'protocol.market.restore']);

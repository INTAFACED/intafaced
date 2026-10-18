import { deskDirectPost, deskGet } from '@/lib/ops-desk/route';

/**
 * p2p ops desk. GET reads the owning service's operator reads as the signed-in founder. POST has one action: a moderator
 * escalating an open dispute (svc-p2p `disputes.escalate`). svc-p2p asks for no second person on it and no money moves.
 * There is no ruling here: releasing or refunding escrow has no console path.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'p2p');
export const POST = (request: Request) => deskDirectPost(request, 'p2p');

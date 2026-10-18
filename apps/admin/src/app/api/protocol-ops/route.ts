import { deskGet } from '@/lib/ops-desk/route';

/**
 * Protocol ops desk. GET reads svc-protocol, svc-indexer and svc-dex as the signed-in founder. There is no POST: the desk
 * cannot change anything.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'protocol');

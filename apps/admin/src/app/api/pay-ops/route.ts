import { deskGet } from '@/lib/ops-desk/route';

/**
 * Personal Pay ops desk. GET reads svc-bank's operator reads on personal transfers as the signed-in founder. There is no POST:
 * svc-bank has no operator action on a personal transfer, so this desk cannot change anything.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'pay');

import { deskGet } from '@/lib/ops-desk/route';

/** bank ops desk (read-only): the owning service's operator reads, as the signed-in founder. There is no POST. */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'bank');

import { payPageGet } from '@/lib/ops-desk/route';

/**
 * The next page of a Personal Pay list whose service gives a page marker (rejected standing orders, failed bills), read on request
 * as the signed-in founder. Read-only: no POST.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => payPageGet(request);

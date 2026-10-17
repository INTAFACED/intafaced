import { payTransferGet } from '@/lib/ops-desk/route';

/**
 * One transfer's full record (svc-bank `ops.transferDetail`, admin:compliance), read on request as the signed-in founder.
 * Read-only: no POST. svc-bank writes a log line with the reader and the id for every record it hands out.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => payTransferGet(request);

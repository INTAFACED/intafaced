import { accountSearchGet } from '@/lib/account-search/route';

/** Identity's operator account search (`accountDirectory.search`, admin:compliance), a page at a time. Read-only: no POST. */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => accountSearchGet(request);

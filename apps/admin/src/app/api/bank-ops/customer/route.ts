import { bankCustomerGet } from '@/lib/ops-desk/route';

/**
 * One customer's balances, or with `asset` the entries behind one coin's balance, for the finance-treasury desk (svc-bank
 * `ops.customerBalances` and `ops.customerBalanceEntries`, admin:treasury), read on request as the signed-in founder. Read-only:
 * no POST. svc-bank writes a log line with the operator and the customer before it reads any figure.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => bankCustomerGet(request);

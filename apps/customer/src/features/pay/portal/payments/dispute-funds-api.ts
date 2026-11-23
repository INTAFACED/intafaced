// hand-declared-ok: svc-pay's merchantOps.disputes.funds answer is declared in the service (merchant-ops/router.ts, readDisputeFunds), and packages/contracts has no browser-safe schema for it.
import { z } from 'zod';
import type { PortalTools } from '../api-tools';
import { disputeFundsSchema } from '@intafaced/contracts/pay-call-schemas';
import { PAY_MERCHANT_OPS_DISPUTES_FUNDS } from '@intafaced/contracts/pay-merchant-ops-procedures';

export type DisputeFunds = z.infer<typeof disputeFundsSchema>;

/** The funds read could not reach the ledger: the card says so and shows no figure. */
export const DISPUTE_FUNDS_UNAVAILABLE = 'pay.dispute_funds_unavailable';

export const disputeFundsApi = ({ queryRecord }: PortalTools) => ({
  disputeFunds: (disputeId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_DISPUTES_FUNDS, { disputeId }, signal),
});
export { disputeFundsSchema };

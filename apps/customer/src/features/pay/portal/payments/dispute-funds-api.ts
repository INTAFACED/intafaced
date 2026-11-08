import { z } from 'zod';
import { amount, asset } from '../../schemas';
import type { PortalTools } from '../api-tools';

/**
 * svc-pay `merchantOps.disputes.funds` (M-disp-01): where a dispute's money is, from the chargeback posts svc-pay booked
 * under the dispute's keys as the acquiring partner reported each step. Read only. Money stays a decimal string, and a
 * shortfall with no opening to measure against is `null` ("not recorded"), never a zero.
 */
export const disputeFundsSchema = z.object({
  disputeId: z.string(),
  assetId: asset,
  status: z.enum(['open', 'contested', 'accepted', 'won', 'lost']),
  disputed: amount,
  takenAtOpening: amount,
  openingBooked: z.boolean(),
  notYetTaken: amount,
  returned: amount,
  shortfall: amount.nullable(),
  shortfallRecovered: amount,
});
export type DisputeFunds = z.infer<typeof disputeFundsSchema>;

/** The funds read could not reach the ledger: the card says so and shows no figure. */
export const DISPUTE_FUNDS_UNAVAILABLE = 'pay.dispute_funds_unavailable';

export const disputeFundsApi = ({ query }: PortalTools) => ({
  disputeFunds: (disputeId: string, signal?: AbortSignal) => query('merchantOps.disputes.funds', { disputeId }, disputeFundsSchema, signal),
});

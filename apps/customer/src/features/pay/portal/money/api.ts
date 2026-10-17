import * as p from '../schemas';
import { listed } from '../../schemas';
import { type PortalTools } from '../api-tools';

export const moneyApi = ({ query, mutate }: PortalTools) => ({
  settlements: async (merchantId: string, status: string, limit: number, signal?: AbortSignal) => {
    const page = await query('settlement.list', { merchantId, limit, ...(status ? { status } : {}) }, p.page(p.settlementSchema), signal);
    return page.ok ? { ok: true as const, data: page.data.items } : page;
  },
  settlement: (settlementId: string, signal?: AbortSignal) => query('settlement.get', { settlementId }, p.settlementSchema, signal),
  control: (merchantId: string, signal?: AbortSignal) => query('merchantControl.get', { merchantId }, p.controlProfileSchema, signal),
  usage: (merchantId: string, signal?: AbortSignal) => query('merchantControl.usage', { merchantId }, p.usageSchema, signal),
  pricingPreview: (input: { merchantId: string; assetCode: string; amount: string; monthlyVolume?: string; conversion?: boolean }) =>
    query('merchantControl.pricing.preview', input, p.quoteSchema),
  approvals: (merchantId: string, status: string, signal?: AbortSignal) =>
    query(
      'merchantControl.approvals.list',
      { merchantId, limit: 200, ...(status ? { status } : {}) },
      p.page(p.approvalSchema),
      signal,
    ).then(listed),
  decideApproval: (input: { approvalId: string; decision: 'approve' | 'reject'; expectedPayloadHash: string; reason: string }) =>
    mutate('merchantControl.approvals.decide', input, p.approvalSchema),
  cancelApproval: (input: { approvalId: string; reason: string }) => mutate('merchantControl.approvals.cancel', input, p.approvalSchema),
});

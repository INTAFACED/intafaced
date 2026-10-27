import { describe, expect, it } from 'vitest';
import { fraudOpenDisputePayloadHash } from './approval-bindings.js';

// tooling/scripts/local-test-world.mjs (populate) proposes pay.fraud_open_dispute for the LOCAL TEST merchant with its own
// copy of the hasher. Compute both on the same inputs so the next field svc-pay binds turns this red instead of drifting.
const populatePath = new URL('../../../tooling/scripts/local-test-world.mjs', import.meta.url).href;

describe('populate dispute approval hash matches svc-pay', () => {
  it('is equal for every reason and flag shape svc-pay accepts', async () => {
    const populate = (await import(/* @vite-ignore */ populatePath)) as {
      openDisputePayloadHash: (input: Record<string, unknown>) => string;
    };
    const base = { disputeId: 'd-1', paymentId: 'p-1', merchantId: 'm-1', amount: '12', assetId: 'USDT' };
    const cases = [
      { reasonCode: 'LOCAL-TEST product_not_received', markPaymentDisputed: true },
      { reasonCode: '  padded reason  ', markPaymentDisputed: false },
      { reasonCode: null, markPaymentDisputed: null },
      {},
    ];
    for (const extra of cases) {
      expect(populate.openDisputePayloadHash({ ...base, ...extra })).toBe(fraudOpenDisputePayloadHash({ ...base, ...extra }));
    }
  });
});

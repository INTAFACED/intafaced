'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { COST_CATEGORIES, CATEGORY_LABEL, entryProblem, isCategory, normaliseCostAmount } from '@/lib/venue-economics/model';
import '../desk.css';

/**
 * Enter one cost for the month. It is a two-founder request like a freeze: the form makes a packet, a different founder approves it
 * at identity, and svc-ops stores it once. A new figure for a line that already has one is the next version; the old one stays in the
 * history. The source note is signed by the approver along with the figure.
 */
export function VenueCostEntry({ period, userId }: { period: string; userId: string }) {
  const router = useRouter();
  const [category, setCategory] = useState<string>(COST_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('USD');
  const problem = entryProblem({ period, category, amount, asset });
  const action: ControlAction = {
    heading: `Enter a cost for ${period}`,
    submitLabel: 'Ask a second founder to approve this cost',
    needsReason: true,
    reasonLabel: 'Source note: where this figure comes from, for example an invoice number (12 to 500 characters)',
    build: (reason) => ({
      kind: 'ops.venue_cost.record',
      period,
      category: isCategory(category) ? category : COST_CATEGORIES[0],
      amount: normaliseCostAmount(amount.trim()),
      asset: asset.trim(),
      reason,
    }),
  };
  return (
    <section className="dk-stack" aria-label="Enter a cost" data-testid="venue-cost-entry">
      <h3>Enter a cost</h3>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="vc-category">Cost line</label>
          <select id="vc-category" className="adm-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {COST_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="vc-amount">Amount for the month</label>
          <input
            id="vc-amount"
            className="adm-input"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="vc-asset">Currency or asset</label>
          <input
            id="vc-asset"
            className="adm-input"
            autoComplete="off"
            value={asset}
            onChange={(e) => setAsset(e.target.value.toUpperCase())}
          />
        </div>
      </div>
      <ControlDesk
        endpoint="/api/more-ops"
        userId={userId}
        blockedReason={null}
        formHold={problem}
        action={action}
        consequence="The figure becomes the one the report uses for this line and month. An earlier figure stays in the history. No money moves. Two different founders must agree, and svc-ops needs the operator write permission (admin:write) and a verified second factor on your session; it refuses in words if either is missing."
        blockedButtonLabel="Entry unavailable"
        onChanged={() => router.refresh()}
      />
    </section>
  );
}

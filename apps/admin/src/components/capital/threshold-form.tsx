'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { OPS_CAPITAL_ASSET, OPS_CAPITAL_CONTACT_MAX, OPS_CAPITAL_MINIMUM } from '@intafaced/contracts/ops-capital';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import '../desk.css';

/** Why the request cannot be made yet, or null. A blank minimum clears the threshold and then names no contact. */
export function thresholdProblem(assetId: string, minimum: string, contact: string): string | null {
  if (!OPS_CAPITAL_ASSET.test(assetId)) return 'Enter the asset as an upper-case code, such as USDT.';
  if (minimum !== '' && !OPS_CAPITAL_MINIMUM.test(minimum))
    return 'Enter the minimum as a plain decimal such as 2500 or 2500.50, or leave it blank to clear it.';
  if (minimum !== '' && contact === '') return 'Name the contact a breach is escalated to.';
  if (contact.length > OPS_CAPITAL_CONTACT_MAX) return `The contact is at most ${OPS_CAPITAL_CONTACT_MAX} characters.`;
  if (minimum === '' && contact !== '') return 'Clearing a threshold names no contact: leave the contact blank.';
  return null;
}

/**
 * Set or clear one asset's minimum buffer. A two-founder request: the form makes a packet, a different founder approves it at
 * identity, and svc-ops stores it once as the asset's next version. Nothing here moves money.
 */
export function CapitalThresholdForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [assetId, setAssetId] = useState('');
  const [minimum, setMinimum] = useState('');
  const [contact, setContact] = useState('');
  const a = assetId.trim();
  const m = minimum.trim();
  const c = contact.trim();
  const action: ControlAction = {
    heading: m === '' ? `Clear the minimum buffer for ${a || 'an asset'}` : `Set the minimum buffer for ${a || 'an asset'}`,
    submitLabel: 'Ask a second founder to approve this threshold',
    needsReason: true,
    reasonLabel: 'Why this threshold (12 to 500 characters)',
    build: (reason) => ({ kind: 'ops.capital.threshold.set', assetId: a, minimum: m, contact: m === '' ? '' : c, reason }),
  };
  return (
    <section className="dk-stack" aria-label="Set a buffer threshold" data-testid="capital-threshold-entry">
      <h3>Set a buffer threshold</h3>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="cap-asset">Asset</label>
          <input
            id="cap-asset"
            className="adm-input"
            autoComplete="off"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value.toUpperCase())}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="cap-minimum">Minimum buffer (blank clears it)</label>
          <input
            id="cap-minimum"
            className="adm-input"
            inputMode="decimal"
            autoComplete="off"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="cap-contact">Escalate a breach to</label>
          <input id="cap-contact" className="adm-input" autoComplete="off" value={contact} onChange={(e) => setContact(e.target.value)} />
        </div>
      </div>
      <ControlDesk
        endpoint="/api/more-ops"
        userId={userId}
        blockedReason={null}
        formHold={thresholdProblem(a, m, c)}
        action={action}
        consequence="The minimum becomes the one the monitor judges this asset by; an earlier one stays in the history. While INTAFACED’s own funds in the asset are below it, one breach alert opens per day, escalated to the named contact. No money moves. Two different founders must agree, and svc-ops needs the operator write permission (admin:write) and a verified second factor on your session; it refuses in words if either is missing."
        blockedButtonLabel="Threshold unavailable"
        onChanged={() => router.refresh()}
      />
    </section>
  );
}

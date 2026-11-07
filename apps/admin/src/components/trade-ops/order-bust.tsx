'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@intafaced/ui';
import type { ActionApproval } from '@intafaced/contracts';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { OutcomeNotice } from './outcome-notice';

const REASON_MIN = 12;
const REASON_MAX = 500;

/**
 * A trade bust (J-cex-spot-18 #4). This operator proposes it with a reason; a second operator approves exactly that
 * request in Freezes & approvals; then it is carried out here. svc-trade reverses a fill only through a ledger-client
 * recipe, and none exists yet, so today it answers with its own typed blocker (trade_bust_recipe_missing) and nothing
 * moves. The answer is shown as it came.
 */
export function OrderBust({ orderId, fillCount }: { orderId: string; fillCount: number }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<ActionApproval | null>(null);
  const [outcome, setOutcome] = useState<Outcome<unknown> | null>(null);
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;

  async function propose() {
    setBusy(true);
    setOutcome(null);
    const result = await tradeOpsAction<ActionApproval>('orders', {
      action: 'bust_propose',
      orderId,
      expectedVersion: String(fillCount),
      reason: trimmed,
    });
    setBusy(false);
    if (result.kind === 'ok') setProposal(result.data);
    else setOutcome(result);
  }

  async function carryOut() {
    if (!proposal) return;
    setBusy(true);
    setOutcome(await tradeOpsAction('orders', { action: 'bust', orderId, approvalId: proposal.approvalId, reason: trimmed }));
    setBusy(false);
  }

  return (
    <section aria-label="Trade bust" className="flex max-w-2xl flex-col gap-3 border border-line p-3">
      <h2 className="text-sm font-medium">Trade bust</h2>
      <p className="text-sm text-fg-2">
        Reverses this order&apos;s fills. It needs a second operator&apos;s approval, and the reversal goes through a ledger recipe.
      </p>
      {fillCount === 0 ? (
        <p className="text-sm text-fg-2">Nothing has filled, so there is no trade to bust.</p>
      ) : (
        <>
          <Field label="Reason (kept in the audit)" hint={`${REASON_MIN} to ${REASON_MAX} characters.`} density="dense">
            <Input value={reason} onValueChange={setReason} density="dense" autoComplete="off" disabled={proposal !== null} />
          </Field>
          {proposal ? (
            <div
              data-bust-proposal=""
              data-approval-id={proposal.approvalId}
              data-payload-hash={proposal.payloadHash}
              className="flex flex-col gap-1 text-sm"
            >
              <p>Waiting for a second operator to approve request {proposal.approvalId} in Freezes &amp; approvals.</p>
              <p className="if-num break-all text-xs text-fg-3">Payload hash: {proposal.payloadHash}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {proposal ? (
              <Button size={28} variant="sell" shape="rounded" loading={busy} onClick={carryOut}>
                Carry out the approved bust
              </Button>
            ) : (
              <Button size={28} variant="secondary" shape="rounded" loading={busy} disabled={!reasonOk} onClick={propose}>
                Propose a trade bust
              </Button>
            )}
          </div>
        </>
      )}
      {outcome ? <OutcomeNotice outcome={outcome} /> : null}
    </section>
  );
}

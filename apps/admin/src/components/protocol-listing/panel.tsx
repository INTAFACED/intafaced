'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import {
  LISTING_MOVES,
  MOVE_LABEL,
  listingProblem,
  listingRequest,
  moveIsPool,
  moveNeedsReason,
  type ListingMove,
} from '@/lib/protocol-listing/model';
import '../desk.css';

/**
 * Hide or restore a pool, delist or relist a market. A two-founder request like a freeze: the form makes a packet, a different
 * founder approves it at identity, and svc-ops stores the decision once. A hide is a listing decision, not an on-chain pause.
 */
export function ProtocolListingPanel({ userId, reasonCodes }: { userId: string; reasonCodes: readonly string[] | null }) {
  const router = useRouter();
  const [move, setMove] = useState<ListingMove>('hide_pool');
  const [chainId, setChainId] = useState('');
  const [poolAddress, setPoolAddress] = useState('');
  const [symbol, setSymbol] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const form = { move, chainId, poolAddress, symbol, reasonCode };
  const needsReason = moveNeedsReason(move);
  const action: ControlAction = {
    heading: MOVE_LABEL[move],
    submitLabel: 'Ask a second founder to approve this',
    needsReason,
    reasonLabel: 'Reason: what the second founder reads and signs (12 to 500 characters)',
    build: (reason) => listingRequest(form, reason),
    danger: needsReason,
  };
  return (
    <section className="dk-stack" aria-label="Pool and market control" data-testid="protocol-listing-panel">
      <h3>Pool and market control</h3>
      <p className="dk-muted">
        A hide takes a pool or market out of INTAFACED’s routing and default list and shows “Hidden by INTAFACED”. It is a listing decision
        only: pools have no admin and no pause, and a hidden pool stays usable by a direct call.
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="pl-move">What to do</label>
          <select id="pl-move" className="adm-input" value={move} onChange={(e) => setMove(e.target.value as ListingMove)}>
            {LISTING_MOVES.map((m) => (
              <option key={m} value={m}>
                {MOVE_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        {moveIsPool(move) ? (
          <>
            <div className="adm-field">
              <label htmlFor="pl-chain">Chain id</label>
              <input
                id="pl-chain"
                className="adm-input"
                inputMode="numeric"
                autoComplete="off"
                value={chainId}
                onChange={(e) => setChainId(e.target.value)}
              />
            </div>
            <div className="adm-field">
              <label htmlFor="pl-pool">Pool address</label>
              <input
                id="pl-pool"
                className="adm-input"
                autoComplete="off"
                value={poolAddress}
                onChange={(e) => setPoolAddress(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div className="adm-field">
            <label htmlFor="pl-symbol">Market symbol</label>
            <input id="pl-symbol" className="adm-input" autoComplete="off" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
        )}
        {needsReason && (
          <div className="adm-field">
            <label htmlFor="pl-code">Reason code</label>
            {reasonCodes ? (
              <select id="pl-code" className="adm-input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                <option value="">Choose a reason code</option>
                {reasonCodes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="pl-code"
                className="adm-input"
                autoComplete="off"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
              />
            )}
          </div>
        )}
      </div>
      <ControlDesk
        endpoint="/api/protocol-ops"
        userId={userId}
        blockedReason={null}
        formHold={listingProblem(form)}
        action={action}
        consequence="Two different founders must agree, and svc-ops needs the operator write permission (admin:write) and a verified second factor on your session; it refuses in words if either is missing. A hide also needs a reason code from the list in force; svc-ops refuses any other."
        blockedButtonLabel="Control unavailable"
        onChanged={() => router.refresh()}
      />
    </section>
  );
}

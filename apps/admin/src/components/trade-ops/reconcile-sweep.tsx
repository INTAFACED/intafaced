'use client';

import { useRef, useState } from 'react';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { parseSweepResult, sweepLine, type SweepResult } from '@/lib/trade-ops/order-read';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ConfirmAction } from './confirm-action';

/**
 * The operator reconcile sweep (J-cex-spot-18 #3). Each press is one run under its own request id; the service looks at
 * plain resting orders that hold funds, leaves every order the book still has, and releases once the hold of an order the
 * book no longer has, only when its fills prove it never filled. Each run's counts are listed as the service gave them.
 */
export function ReconcileSweep() {
  const [runs, setRuns] = useState<SweepResult[]>([]);
  // One press is one request id. While its answer is unknown (the connection ended), a resend carries the same id, so the
  // service answers with the run it already made instead of starting a second sweep (as account-controls.tsx does).
  const pending = useRef<string | null>(null);
  return (
    <section aria-label="Reconcile sweep" className="flex flex-col gap-2 border border-line p-3">
      <h2 className="text-sm font-medium">Reconcile sweep</h2>
      <p className="text-sm text-fg-2">
        Checks resting orders that hold funds against the book. An order the book still has is left alone; a hold whose order the book no
        longer has is released once, and only when the order never filled.
      </p>
      <div>
        <ConfirmAction
          trigger="Start reconcile sweep"
          title="Start a reconcile sweep"
          confirmLabel="Start reconcile sweep"
          doneText="Swept"
          consequence={
            <>
              svc-trade checks each resting order that holds funds. Orphaned holds are released to their owners, once each. The reason is
              written to the audit.
            </>
          }
          run={async (reason) => {
            const clientRequestId = pending.current ?? `sweep:${crypto.randomUUID()}`;
            pending.current = clientRequestId;
            const outcome: Outcome<unknown> = await tradeOpsAction('orders', { action: 'sweep', clientRequestId, reason });
            if (outcome.kind !== 'unknown') pending.current = null;
            if (outcome.kind === 'ok') {
              const result = parseSweepResult(outcome.data);
              if (result) setRuns((prev) => [...prev, result]);
            }
            return outcome;
          }}
        />
      </div>
      {runs.length === 0 ? (
        <p className="text-xs text-fg-3">No sweep has run from this page.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm">
          {runs.map((run) => (
            <li
              key={run.ranAt}
              data-sweep-result=""
              data-checked={run.checked}
              data-released={run.released}
              data-released-orders={run.releasedOrderIds.join(',')}
            >
              <span className="if-num">{run.ranAt.slice(11, 19)} UTC</span> · {sweepLine(run)}
              {run.firstSightedOrderIds.length > 0
                ? ` · ${run.firstSightedOrderIds.length} missing from the book, seen for the first time: a later sweep may release them`
                : ''}
              {run.waitingOrderIds.length > 0 ? ` · ${run.waitingOrderIds.length} waiting for a second look` : ''}
              {run.failedClosedOrderIds.length > 0 ? ` · ${run.failedClosedOrderIds.length} kept: fills could not prove no fill` : ''}
              {run.terminalizedNoHoldOrderIds.length > 0 ? ` · ${run.terminalizedNoHoldOrderIds.length} ended with no hold left` : ''}
              {run.otherActionOrderIds.length > 0 ? ` · ${run.otherActionOrderIds.length} other repairs, named in the audit` : ''}
              {run.unreadableOrderIds.length > 0 ? ` · ${run.unreadableOrderIds.length} not read: nothing done to them` : ''}
              {run.erroredAfterActingOrderIds.length > 0 ? (
                <strong data-sweep-errored={run.erroredAfterActingOrderIds.join(',')}>
                  {` · ${run.erroredAfterActingOrderIds.length} failed after acting: read each order before anything else (${run.erroredAfterActingOrderIds.join(', ')})`}
                </strong>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

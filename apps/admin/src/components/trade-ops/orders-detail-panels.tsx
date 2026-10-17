'use client';

import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';

/**
 * The three panels of an order that need services we do not have: fills, history, and the operator controls
 * (cancel, start reconcile). All are fully built and send a real request to /api/trade-ops/orders; each answers with a
 * typed refusal naming the owner and requirement id, which is shown as it came. Nothing here ever claims success.
 */

function ReadPanel({ title, action, orderId, what }: { title: string; action: 'fills' | 'history'; orderId: string; what: string }) {
  const [result, setResult] = useState<Outcome<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label={title} className="flex flex-col gap-2 border border-line p-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-sm text-fg-2">{what}</p>
      <div>
        <Button
          size={28}
          variant="secondary"
          shape="rounded"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setResult(await tradeOpsAction('orders', { action, orderId }));
            setBusy(false);
          }}
        >
          Load {action}
        </Button>
      </div>
      {result ? (
        <OutcomeNotice outcome={result} />
      ) : (
        <p className="text-xs text-fg-3">Not loaded. No rows are shown until the service answers.</p>
      )}
    </section>
  );
}

export function OrderDetailPanels({ orderId, cancellable }: { orderId: string; cancellable: boolean }) {
  const [result, setResult] = useState<Outcome<unknown> | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ReadPanel
        title="Fills"
        action="fills"
        orderId={orderId}
        what="Each execution against this order: time, price, quantity, fee, counterparty side."
      />
      <ReadPanel
        title="History"
        action="history"
        orderId={orderId}
        what="State changes of this order: received, open, partially filled, held, cancelled, filled."
      />
      <section aria-label="Operator controls" className="flex flex-col gap-2 border border-line p-3 lg:col-span-2">
        <h2 className="text-sm font-medium">Operator controls</h2>
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmAction
            trigger="Cancel this order"
            title="Cancel this order as operator"
            tone="danger"
            confirmLabel="Cancel order"
            disabled={!cancellable}
            disabledReason="Only an open order can be cancelled."
            consequence={
              <>
                The order leaves the book and its reserved funds are released to the owner. The reason is written to the audit. This cannot
                be undone.
              </>
            }
            run={(reason) => tradeOpsAction('orders', { action: 'cancel', orderId, reason })}
            onDone={setResult}
          />
          <ConfirmAction
            trigger="Start reconcile"
            title="Start reconcile for this order"
            confirmLabel="Start reconcile"
            reasonMin={0}
            consequence={
              <>
                Asks svc-trade to check this order against the engine journal now, instead of waiting for the sweep. Funds stay reserved
                until it decides.
              </>
            }
            run={() => tradeOpsAction('orders', { action: 'reconcile', orderId })}
            onDone={setResult}
          />
        </div>
        {result && result.kind !== 'ok' ? <OutcomeNotice outcome={result} /> : null}
        <p className="text-xs text-fg-3">
          Both controls are built and send a real request; the service answer is shown above and nothing changes on the book while it
          refuses.
        </p>
      </section>
    </div>
  );
}

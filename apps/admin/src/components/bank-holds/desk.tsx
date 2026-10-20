import Link from 'next/link';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { HOLD_STATE_LABEL } from '@/lib/bank-holds/model';
import type { HoldControls, HoldDesk } from '@/lib/bank-holds/read';
import type { Part } from '@/lib/desk/part';
import { HoldRowActions, PlaceHold } from './actions';
import '../desk.css';

/**
 * The global-send holds desk. Every part is svc-bank's own answer; a part that failed says why and shows no rows, so a down
 * service never reads as an empty queue. A setting the owner has not published is shown as not set, never as a default.
 */

function Failed({ part, testId }: { part: Extract<Part<unknown>, { kind: 'failed' }>; testId: string }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid={testId}>
      <strong>{part.forbidden ? 'Access refused' : 'This part could not be read'}</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

const bytes = (n: number | null): string => (n === null ? 'Not set' : `${n} bytes`);

function Controls({ c }: { c: HoldControls }) {
  return (
    <dl className="dk-dl" data-testid="hold-controls">
      <dt>Payee block list</dt>
      <dd>
        {c.payeeControls.state === 'unset'
          ? 'Not set: every send refuses until the owner publishes it.'
          : `Published, ${c.payeeControls.blockedCount} blocked ${c.payeeControls.blockedCount === 1 ? 'account' : 'accounts'}.`}
      </dd>
      <dt>Crypto-exchange allowance</dt>
      <dd>
        {c.exchangeAllowance.state === 'unset'
          ? 'Not set: a send refuses until the owner publishes it.'
          : `Published: a ${c.exchangeAllowance.windowDays ?? '?'}-day rolling window across ${c.exchangeAllowance.exchangeCount} listed ${c.exchangeAllowance.exchangeCount === 1 ? 'exchange' : 'exchanges'}.`}
      </dd>
      <dt>Customer file limits</dt>
      <dd>
        {c.proofLimits.state === 'unset'
          ? 'Not set: customers cannot upload a file until the owner publishes the limits.'
          : `Types ${c.proofLimits.allowedTypes.join(', ')}; up to ${bytes(c.proofLimits.maxBytes)}.`}
      </dd>
    </dl>
  );
}

export function HoldsDesk({ desk, operatorId }: { desk: HoldDesk; operatorId: string }) {
  const rows = desk.queue.kind === 'ok' ? desk.queue.data : [];
  return (
    <div className="dk-stack" data-testid="holds-desk">
      <p>
        <Link href="/bank-ops">Bank ops</Link>
      </p>
      <h2>Global send holds</h2>
      <p className="dk-muted">
        Sends that are on hold before they were debited, as svc-bank reports them. Release needs a second operator. As of{' '}
        {formatAsOf(desk.asOf)}.
      </p>
      <h3>Owner settings</h3>
      {desk.controls.kind === 'failed' ? <Failed part={desk.controls} testId="controls-failed" /> : <Controls c={desk.controls.data} />}
      <h3>Queue</h3>
      {desk.queue.kind === 'failed' ? (
        <Failed part={desk.queue} testId="queue-failed" />
      ) : rows.length === 0 ? (
        <p className="dk-muted" data-testid="queue-empty">
          svc-bank reports no open hold.
        </p>
      ) : (
        <ul className="dk-stack" data-testid="hold-queue">
          {rows.map((h) => (
            <li key={h.id} className="dk-stack" data-testid="hold-row">
              <dl className="dk-dl">
                <dt>Send</dt>
                <dd>{h.sendId}</dd>
                <dt>Customer</dt>
                <dd>{h.send.userId}</dd>
                <dt>Amount</dt>
                <dd>
                  {h.send.amount} {h.send.assetId} to {h.send.toCurrency} ({h.send.country}, {h.send.deliveryMethod})
                </dd>
                <dt>State</dt>
                <dd>{HOLD_STATE_LABEL[h.state]}</dd>
                <dt>Reason</dt>
                <dd>{h.reason}</dd>
                <dt>Placed by</dt>
                <dd>{h.heldBy}</dd>
                <dt>Placed</dt>
                <dd>{formatWhen(h.createdAt)}</dd>
                <dt>Asked of the customer</dt>
                <dd>{h.infoRequest ?? 'Nothing asked'}</dd>
                <dt>Customer file</dt>
                <dd>
                  {h.proof
                    ? `${h.proof.name} (${h.proof.type}, ${h.proof.size} bytes, uploaded ${formatWhen(h.proof.uploadedAt)})`
                    : 'None uploaded'}
                </dd>
              </dl>
              <HoldRowActions sendId={h.sendId} canRelease={h.heldBy !== operatorId} hasProof={h.proof !== null} />
            </li>
          ))}
        </ul>
      )}
      <PlaceHold />
    </div>
  );
}

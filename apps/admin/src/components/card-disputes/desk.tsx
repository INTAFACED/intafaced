import Link from 'next/link';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import {
  DISPUTE_STATES,
  EVENT_LABEL,
  OUTCOME_LABEL,
  STATE_LABEL,
  creditWords,
  lossWords,
  type DisputeCase,
  type DisputeState,
  type DisputeSummary,
} from '@/lib/card-disputes/model';
import type { Part } from '@/lib/desk/part';
import { DisputeActions } from './actions';
import '../desk.css';

/**
 * The card disputes desk (J-bank-27). Every part is svc-bank's own answer; a part that failed says why and shows no rows, so
 * a down service never reads as an empty queue. A provisional credit is the card partner's money, shown with the partner's
 * reference; who bears a fraud loss is the partner's terms or "not known", never assumed.
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

const TestMark = ({ test }: { test: boolean }) => (test ? <span className="dk-badge">TEST</span> : null);

export function DisputeQueue({
  asOf,
  queue,
  state,
}: {
  asOf: string;
  queue: Part<{ rows: DisputeSummary[]; more: boolean }>;
  state: DisputeState | null;
}) {
  const rows = queue.kind === 'ok' ? queue.data.rows : [];
  const more = queue.kind === 'ok' && queue.data.more;
  return (
    <div className="dk-stack" data-testid="dispute-desk">
      <p>
        <Link href="/bank-ops">Bank ops</Link>
      </p>
      <h2>Card disputes</h2>
      <p className="dk-muted">
        Cardholders’ disputes of settled card payments, as svc-bank records them. A provisional credit is the card partner’s money, under
        its terms; nothing here posts to the ledger. As of {formatAsOf(asOf)}.
      </p>
      <form className="dk-row" method="get" action="/bank-ops/cards/disputes" data-testid="dispute-filter">
        <div className="adm-field">
          <label htmlFor="dispute-state">State</label>
          <select id="dispute-state" name="state" className="adm-input" defaultValue={state ?? ''}>
            <option value="">Every state</option>
            {DISPUTE_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="adm-btn">
          Filter
        </button>
      </form>
      {more && (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="dispute-queue-more">
          svc-bank has more cases than this list shows; the oldest are not listed. Filter by state to see them.
        </div>
      )}
      {queue.kind === 'failed' ? (
        <Failed part={queue} testId="dispute-queue-failed" />
      ) : rows.length === 0 ? (
        <p className="dk-muted" data-testid="dispute-queue-empty">
          svc-bank reports no dispute{state ? ` in the state ${STATE_LABEL[state]}` : ''}.
        </p>
      ) : (
        <div className="dk-table-wrap">
          <table className="adm-table" data-testid="dispute-queue">
            <thead>
              <tr>
                <th>Case</th>
                <th>State</th>
                <th>Amount</th>
                <th>Card payment</th>
                <th>Provisional credit</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} data-testid="dispute-row" data-dispute-id={d.id}>
                  <td>
                    <Link href={`/bank-ops/cards/disputes/${d.id}`}>Open case {d.id.slice(0, 8)}</Link> <TestMark test={d.test} />
                  </td>
                  <td>{STATE_LABEL[d.state]}</td>
                  <td>
                    {d.amount} {d.assetId}
                  </td>
                  <td>{d.authorizationRef}</td>
                  <td>{creditWords(d)}</td>
                  <td>{formatWhen(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="dk-kv-row" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function DisputeCaseView({ asOf, dispute }: { asOf: string; dispute: Part<DisputeCase> }) {
  return (
    <div className="dk-stack" data-testid="dispute-case-desk">
      <p>
        <Link href="/bank-ops/cards/disputes">Card disputes</Link>
      </p>
      {dispute.kind === 'failed' ? <Failed part={dispute} testId="dispute-case-failed" /> : <CaseBody d={dispute.data} asOf={asOf} />}
    </div>
  );
}

function CaseBody({ d, asOf }: { d: DisputeCase; asOf: string }) {
  return (
    <>
      <h2>
        Dispute {d.id.slice(0, 8)} <TestMark test={d.test} />
      </h2>
      <p className="dk-muted">As of {formatAsOf(asOf)}.</p>
      <dl className="dk-kv" data-testid="dispute-case">
        <Fact label="State" testId="dispute-state-fact">
          {STATE_LABEL[d.state]}
        </Fact>
        <Fact label="Amount">
          {d.amount} {d.assetId}
        </Fact>
        <Fact label="Card payment">{d.authorizationRef}</Fact>
        <Fact label="Cardholder">{d.userId}</Fact>
        <Fact label="Reason">{d.reason}</Fact>
        <Fact label="Provisional credit" testId="dispute-credit">
          {creditWords(d)}
        </Fact>
        <Fact label="Partner’s reference" testId="dispute-credit-ref">
          {d.credit.partnerRef ?? 'None'}
        </Fact>
        <Fact label="Dispute cap" testId="dispute-cap">
          {d.cap === null
            ? 'Not set: a credit or a decision for the cardholder refuses until the owner publishes it.'
            : `${d.cap} ${d.assetId}${d.test ? ' (TEST)' : ''}`}
        </Fact>
        {d.decision && (
          <>
            <Fact label="Decision" testId="dispute-outcome">
              {OUTCOME_LABEL[d.decision.outcome]}
            </Fact>
            <Fact label="Who bears the fraud loss" testId="dispute-loss">
              {lossWords(d.decision)}
            </Fact>
            <Fact label="The partner’s provisional credit" testId="dispute-credit-settlement">
              {d.decision.creditSettlement === null
                ? 'None was given'
                : `${d.decision.creditSettlement === 'final' ? 'Final' : 'Reversed by the partner'}, reference ${d.decision.creditSettlementPartnerRef ?? 'none'}`}
            </Fact>
            <Fact label="Closed">{formatWhen(d.decision.closedAt)}</Fact>
          </>
        )}
      </dl>
      <h3>Timeline</h3>
      <div className="dk-table-wrap">
        <table className="adm-table" data-testid="dispute-timeline">
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>From</th>
              <th>To</th>
              <th>By</th>
              <th>When</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {d.events.map((e) => (
              <tr key={e.sequence} data-testid="dispute-event" data-kind={e.kind}>
                <td>{e.sequence}</td>
                <td>
                  {EVENT_LABEL[e.kind]}
                  {e.afterSubmission ? ' (after submission)' : ''}
                </td>
                <td>{e.fromState ? STATE_LABEL[e.fromState] : 'None'}</td>
                <td>{STATE_LABEL[e.toState]}</td>
                <td>{e.actor}</td>
                <td>
                  <time dateTime={e.at}>{formatWhen(e.at)}</time>
                </td>
                <td>{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.state !== 'closed' && <DisputeActions disputeId={d.id} state={d.state} credited={d.credit.state === 'credited'} />}
    </>
  );
}

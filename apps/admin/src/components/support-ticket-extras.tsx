import type { SupportCaseFile } from '@intafaced/contracts';
import { Chip } from '@/components/chip';
import { shortId } from '@/lib/desk/desk-model';
import { ESCALATION_REASONS } from '@/lib/support/model';
import type { SupportRating, TicketExtrasView } from '@/lib/support/types';
import { Failed } from './support-action-parts';

/**
 * The two operator-only reads on a ticket: the CASE FILE an escalation was made against, and the customer's RATING.
 * Each is its own part. A refusal is shown as that part's refusal; it is never drawn as "no case file" or "no rating".
 */

export function reasonLabel(id: string): string {
  return ESCALATION_REASONS.find((r) => r.id === id)?.label ?? id;
}

function CaseFileBody({ file }: { file: SupportCaseFile }) {
  const g = file.grounding;
  return (
    <>
      <dl className="dk-kv">
        <dt>Why it left the desk</dt>
        <dd>{reasonLabel(file.reason)}</dd>
        <dt>Escalated by</dt>
        <dd className="dk-packet">{shortId(file.escalatedBy)}</dd>
        <dt>Filed</dt>
        <dd>{file.createdAt}</dd>
        <dt>Account state</dt>
        <dd>
          {g.status === 'read'
            ? `Read ${g.readAt}: account ${g.state.status}, verification tier ${String(g.state.kycTier)}`
            : g.reason === 'plane_dark'
              ? 'Not read: identity could not be reached when this was filed.'
              : 'Not read: the escalation was filed without reading it.'}
        </dd>
      </dl>
      <div className="adm-callout">
        <strong>What the operator concluded</strong>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.summary}</p>
      </div>
      <div className="dk-table-wrap" role="region" aria-label="Case file citations" tabIndex={0}>
        <table className="adm-table">
          <thead>
            <tr>
              <th>Read</th>
              <th>Reference</th>
              <th>Fingerprint</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {file.citations.map((c, i) => (
              <tr key={`${c.kind}:${c.ref}:${i}`}>
                <td>{c.kind === 'kb_article' ? 'Help article' : c.kind === 'account_state' ? 'Account state' : 'Customer comment'}</td>
                <td className="dk-packet">{c.kind === 'kb_article' ? c.ref : shortId(c.ref)}</td>
                <td className="dk-packet">{c.digest.slice(0, 12)}</td>
                <td>{c.readAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dk-muted">The fingerprint proves what was read at that moment without keeping a copy of it.</p>
    </>
  );
}

function RatingBody({ rating }: { rating: SupportRating }) {
  return (
    <>
      <div className="dk-row">
        <Chip tone={rating.score >= 4 ? 'live' : rating.score === 3 ? 'warn' : 'danger'}>{rating.score} out of 5</Chip>
        <span className="dk-muted">Rated {rating.createdAt}</span>
      </div>
      {rating.note ? (
        <div className="adm-callout">
          <strong>What the customer added</strong>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{rating.note}</p>
        </div>
      ) : (
        <p className="dk-muted">The customer left no note.</p>
      )}
    </>
  );
}

export function TicketExtras({ extras, loading }: { extras: TicketExtrasView | null; loading: boolean }) {
  return (
    <section className="dk-stack" aria-label="Case file and rating" data-testid="ticket-extras">
      <h4>Customer rating</h4>
      {!extras ? (
        <p className="dk-muted">{loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : extras.rating.kind === 'failed' ? (
        <Failed name="Rating" part={extras.rating} />
      ) : extras.rating.data === null ? (
        <p className="dk-muted" data-testid="rating-none">
          svc-support says the customer has not rated this ticket. A customer can rate once it is resolved or closed.
        </p>
      ) : (
        <RatingBody rating={extras.rating.data} />
      )}

      <h4>Case file</h4>
      {!extras ? (
        <p className="dk-muted">{loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : extras.caseFile.kind === 'failed' ? (
        <Failed name="Case file" part={extras.caseFile} />
      ) : extras.caseFile.data === null ? (
        <p className="dk-muted" data-testid="casefile-none">
          svc-support says this ticket was never escalated, so there is no case file.
        </p>
      ) : (
        <CaseFileBody file={extras.caseFile.data} />
      )}
      {extras && <span className="dk-asof">As of {extras.asOf}</span>}
    </section>
  );
}

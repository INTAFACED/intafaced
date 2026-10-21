import Link from 'next/link';
import type { ComplianceCase } from '@intafaced/contracts';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { REVIEW_LABEL, STATUS_LABEL, TYPE_LABEL, dueText, roomHref, type RoomQuery } from '@/lib/compliance-cases/model';
import type { CaseRoom } from '@/lib/compliance-cases/read';
import type { Part } from '@/lib/desk/part';
import { DefineQueue, FavouriteButton } from './actions';
import '../desk.css';

/**
 * The case room. Every part is the service's own answer; a part that failed says why and shows no rows, so a down service never
 * reads as an empty inbox. Empty is only ever shown when svc-ops said so.
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

function keep(q: RoomQuery, extra: Record<string, string | null | undefined>): Record<string, string | null | undefined> {
  return { inbox: q.inboxId, limit: q.limit !== null ? String(q.limit) : null, ...extra };
}

export function Preview({ c }: { c: ComplianceCase }) {
  return (
    <section className="dk-stack" aria-label="Case preview" data-testid="case-preview">
      <h3>{c.name}</h3>
      <dl className="dk-dl">
        <dt>Case id</dt>
        <dd>{c.id}</dd>
        <dt>Status</dt>
        <dd>{STATUS_LABEL[c.status]}</dd>
        <dt>Review level</dt>
        <dd>{REVIEW_LABEL[c.reviewLevel ?? 'unset']}</dd>
        <dt>Type</dt>
        <dd>{TYPE_LABEL[c.type]}</dd>
        <dt>Subject</dt>
        <dd>
          {c.entityType} {c.subjectId}
        </dd>
        <dt>Assignee</dt>
        <dd>{c.assignee ?? 'Unassigned'}</dd>
        <dt>Tags</dt>
        <dd>{c.tags.length ? c.tags.join(', ') : 'None'}</dd>
        <dt>Due</dt>
        <dd>{c.dueAt === null ? 'Not set' : formatWhen(c.dueAt)}</dd>
        <dt>Snoozed until</dt>
        <dd>{c.snoozedUntil === null ? 'Not snoozed' : formatWhen(c.snoozedUntil)}</dd>
        <dt>Created</dt>
        <dd>{formatWhen(c.createdAt)}</dd>
      </dl>
    </section>
  );
}

export function CasesRoom({ room, q }: { room: CaseRoom; q: RoomQuery }) {
  const inboxes = room.inboxes.kind === 'ok' ? room.inboxes.data : [];
  const selected = inboxes.find((e) => e.inbox.id === q.inboxId) ?? null;
  return (
    <div className="dk-stack" data-testid="cases-room">
      <h2>Compliance cases</h2>
      <p className="dk-muted">
        Cases are stored by svc-ops and survive a restart. You see the inboxes you belong to. As of {formatAsOf(room.asOf)}.
      </p>

      <div className="dk-row">
        <form method="get" className="dk-row" data-testid="jump-form">
          <div className="adm-field">
            <label htmlFor="cc-jump">Jump to a case by id</label>
            <input id="cc-jump" name="case" className="adm-input" autoComplete="off" />
          </div>
          {q.inboxId && <input type="hidden" name="inbox" value={q.inboxId} />}
          {q.limit !== null && <input type="hidden" name="limit" value={q.limit} />}
          <button type="submit" className="adm-btn">
            Open case
          </button>
        </form>
        {q.inboxId && (
          <form method="get" data-testid="next-form">
            <input type="hidden" name="inbox" value={q.inboxId} />
            <input type="hidden" name="next" value="1" />
            {q.limit !== null && <input type="hidden" name="limit" value={q.limit} />}
            <button type="submit" className="adm-btn">
              Next unassigned case
            </button>
          </form>
        )}
      </div>

      <div className="dk-row" style={{ alignItems: 'flex-start' }}>
        <nav aria-label="Inboxes" data-testid="inbox-rail">
          <h3>Inboxes</h3>
          {room.inboxes.kind === 'failed' ? (
            <Failed part={room.inboxes} testId="inboxes-failed" />
          ) : inboxes.length === 0 ? (
            <p className="dk-muted" data-testid="inboxes-empty">
              You are not a member of any inbox yet. Define a queue below, or ask an inbox owner to add you.
            </p>
          ) : (
            <ul>
              {inboxes.map((e) => (
                <li key={e.inbox.id} data-testid="inbox-item">
                  <FavouriteButton inboxId={e.inbox.id} favourite={e.favourite} />{' '}
                  <Link href={roomHref(keep(q, { inbox: e.inbox.id }))} aria-current={e.inbox.id === q.inboxId ? 'page' : undefined}>
                    {e.inbox.name} v{e.inbox.version}
                  </Link>{' '}
                  <span className="dk-muted">{e.openCount === null ? '' : `${e.openCount} open`}</span>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="dk-stack" style={{ flex: 1 }}>
          {!q.inboxId ? (
            <p className="dk-muted" data-testid="pick-inbox">
              Pick an inbox to see its cases.
            </p>
          ) : room.access && room.access.kind === 'ok' ? (
            <div className="adm-callout" data-tone="warn" role="status" data-testid="access-panel">
              <strong>Ask an admin for access</strong>
              <p>
                You are not a member of {room.access.data.name}. Its owner is {room.access.data.owner}. No cases or counts are shown.
              </p>
            </div>
          ) : room.list === null ? null : room.list.kind === 'failed' ? (
            <>
              <Failed part={room.list} testId="list-failed" />
              {room.list.code === 'compliance.cases_list_limit_unset' && (
                <form method="get" className="dk-row" data-testid="limit-form">
                  <input type="hidden" name="inbox" value={q.inboxId} />
                  <div className="adm-field">
                    <label htmlFor="cc-limit">Cases per page</label>
                    <input id="cc-limit" name="limit" className="adm-input" inputMode="numeric" autoComplete="off" />
                  </div>
                  <button type="submit" className="adm-btn">
                    Show cases
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <form method="get" className="dk-row" data-testid="filter-bar">
                <input type="hidden" name="inbox" value={q.inboxId} />
                {q.limit !== null && <input type="hidden" name="limit" value={q.limit} />}
                <div className="adm-field">
                  <label htmlFor="cc-level">Review level</label>
                  <select id="cc-level" name="level" className="adm-input" defaultValue={q.filter.reviewLevels?.[0] ?? ''}>
                    <option value="">Any</option>
                    <option value="green">Green</option>
                    <option value="yellow">Yellow</option>
                    <option value="red">Red</option>
                  </select>
                </div>
                <div className="adm-field">
                  <label htmlFor="cc-assignee">Assignee id</label>
                  <input id="cc-assignee" name="assignee" className="adm-input" defaultValue={q.filter.assignee ?? ''} />
                </div>
                <div className="adm-field">
                  <label htmlFor="cc-tags">Tags</label>
                  <input id="cc-tags" name="tags" className="adm-input" defaultValue={q.filter.tags?.join(',') ?? ''} />
                </div>
                <div className="adm-field">
                  <label htmlFor="cc-from">Created from</label>
                  <input
                    id="cc-from"
                    name="from"
                    type="date"
                    className="adm-input"
                    defaultValue={q.filter.createdFrom?.slice(0, 10) ?? ''}
                  />
                </div>
                <div className="adm-field">
                  <label htmlFor="cc-to">Created to</label>
                  <input id="cc-to" name="to" type="date" className="adm-input" defaultValue={q.filter.createdTo?.slice(0, 10) ?? ''} />
                </div>
                <label>
                  <input type="checkbox" name="unassigned" value="1" defaultChecked={q.filter.unassignedOnly === true} /> Unassigned only
                </label>
                <label>
                  <input type="checkbox" name="closed" value="1" defaultChecked={q.filter.closedOnly === true} /> Closed only
                </label>
                <label>
                  <input type="checkbox" name="snoozed" value="1" defaultChecked={q.filter.includeSnoozed === true} /> Include snoozed
                </label>
                <label>
                  <input type="checkbox" name="group" value="1" defaultChecked={q.group} /> Group by review level
                </label>
                <button type="submit" className="adm-btn">
                  Apply filters
                </button>
              </form>
              <p data-testid="cases-total">
                {room.list.data.total} {room.list.data.total === 1 ? 'case' : 'cases'}
                {selected ? ` in ${selected.inbox.name}` : ''}, counted by svc-ops.
              </p>
              {room.list.data.groups && (
                <ul data-testid="cases-groups">
                  {(['green', 'yellow', 'red', 'unset'] as const).map((k) => (
                    <li key={k}>
                      {REVIEW_LABEL[k]}: {room.list!.kind === 'ok' ? room.list!.data.groups![k] : 0}
                    </li>
                  ))}
                </ul>
              )}
              {room.list.data.rows.length === 0 ? (
                <p className="dk-muted" data-testid="cases-empty">
                  svc-ops reports no cases here for these filters.
                </p>
              ) : (
                <div className="dk-table-wrap" role="region" aria-label="Cases" tabIndex={0}>
                  <table className="adm-table" data-testid="cases-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Status</th>
                        <th scope="col">Review</th>
                        <th scope="col">Assignee</th>
                        <th scope="col">Tags</th>
                        <th scope="col">Type</th>
                        <th scope="col">Due</th>
                        <th scope="col">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {room.list.data.rows.map((c) => (
                        <tr key={c.id} data-testid="case-row">
                          <td>
                            <Link href={roomHref(keep(q, { case: c.id }))}>{c.name}</Link>
                          </td>
                          <td>{STATUS_LABEL[c.status]}</td>
                          <td>{REVIEW_LABEL[c.reviewLevel ?? 'unset']}</td>
                          <td>{c.assignee ?? 'Unassigned'}</td>
                          <td>{c.tags.join(', ')}</td>
                          <td>{TYPE_LABEL[c.type]}</td>
                          <td>{dueText(c) === 'Not set' ? 'Not set' : formatWhen(c.dueAt!)}</td>
                          <td>{formatWhen(c.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {room.list.data.nextCursor && (
                <p>
                  <Link href={roomHref({ ...keep(q, {}), cursor: room.list.data.nextCursor })} data-testid="cases-more">
                    Next page
                  </Link>
                </p>
              )}
            </>
          )}

          {room.nextEmpty && (
            <p className="dk-muted" data-testid="next-empty">
              Every open case in this inbox is assigned or snoozed. That is svc-ops’s answer.
            </p>
          )}
          {room.preview &&
            (room.preview.kind === 'ok' ? <Preview c={room.preview.data} /> : <Failed part={room.preview} testId="preview-failed" />)}
        </div>
      </div>

      <DefineQueue />
    </div>
  );
}

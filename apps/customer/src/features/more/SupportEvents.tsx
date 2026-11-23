import { useId, useState } from 'react';
import { SUPPORT_EVENTS } from '@intafaced/contracts/support-customer-procedures';
import type { SupportTicketEvent } from '@intafaced/contracts/support';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { supportEventsCopy } from './support-events-copy';
import { EmptyNote, FailureNote, Waiting } from './volt-parts';

export type SupportEvent = SupportTicketEvent;

/**
 * What this page believes of the history it is sent, over the record's reply: no more rows than asked for, each on this
 * ticket and, when a customer acted, by its owner; each once, in rising order; and a status on a row only when it is a
 * real status change. An answer that breaks any of these reads as unverified and nothing of it is shown.
 */
export const supportEventsAccepted =
  (ticketId: string, limit: number, ownerId: string) =>
  (rows: readonly SupportTicketEvent[]): boolean =>
    rows.length <= limit &&
    rows.every((row) => row.ticketId === ticketId && (row.actorRole !== 'user' || row.actorId === ownerId)) &&
    new Set(rows.map((row) => row.id)).size === rows.length &&
    rows.every((row, index) => index === 0 || row.sequence > rows[index - 1]!.sequence) &&
    rows.every((row) =>
      row.kind === 'status_changed'
        ? row.fromStatus !== null && row.toStatus !== null && row.fromStatus !== row.toStatus
        : row.fromStatus === null && row.toStatus === null,
    );

export function hasSupportEventGap(rows: SupportEvent[]) {
  return rows.some((row, index) => row.sequence !== (index === 0 ? 1 : rows[index - 1]!.sequence + 1));
}

// The parent mounts this only inside a verified exact-owner ticket read. The
// events handler performs its own owner check; the wire ticket ID is verified
// again here before any event content is rendered.
export function SupportEvents({ ticketId, ticketUpdatedAt }: { ticketId: string; ticketUpdatedAt: string }) {
  const { api, userId } = useSession();
  const { t, Copy, requestedLocale, languageFor } = supportEventsCopy.useCopy();
  const headingId = useId();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: t('signIn') };
    return api.call(SUPPORT_EVENTS, { ticketId, limit }, { signal, accept: supportEventsAccepted(ticketId, limit, userId) });
  }, `support-events:${userId}:${ticketId}:${ticketUpdatedAt}:${limit}`);

  return (
    <section className="lt-stack" aria-labelledby={headingId} lang={languageFor('history')}>
      <header className="lt-toolbar">
        <h3 id={headingId}>
          <Copy k="history" />
        </h3>
        <Button tone="secondary" onClick={reload} disabled={resource.status === 'loading'}>
          <Copy k="refresh" />
        </Button>
      </header>
      <p className="lt-hint">
        <Copy k="description" />
      </p>
      {resource.status === 'loading' ? (
        <Waiting label={t('loading')} />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <FailureNote result={resource.failure} retry={reload} />
        </div>
      ) : (
        <>
          {resource.data.length === 0 ? (
            <EmptyNote title={t('empty')}>
              <Copy k="emptyDetail" />
            </EmptyNote>
          ) : (
            <>
              {hasSupportEventGap(resource.data) && (
                <p role="status">
                  <Copy k="gap" />
                </p>
              )}
              <ol className="lt-stack" aria-label={t('history')}>
                {resource.data.map((event) => (
                  <li className="lt-toolbar" key={event.id}>
                    <span className="lt-mono" aria-label={t('sequence')}>
                      {event.sequence}
                    </span>
                    <div className="lt-stack">
                      <h4>
                        <Copy k={event.kind} />
                      </h4>
                      <p className="lt-hint">
                        <Copy k={event.actorRole === 'operator' ? 'operator' : event.actorId === userId ? 'you' : 'user'} />
                        {' · '}
                        <time dateTime={event.occurredAt} lang={requestedLocale}>
                          {new Date(event.occurredAt).toLocaleString(requestedLocale)}
                        </time>
                      </p>
                      {event.kind === 'status_changed' && event.fromStatus && event.toStatus && (
                        <p>{t('transition', { from: t(event.fromStatus), to: t(event.toStatus) })}</p>
                      )}
                      {event.note !== null && (
                        <p className="lt-pre-wrap" lang="und">
                          {event.note}
                        </p>
                      )}
                      <details>
                        <summary>
                          <Copy k="showReference" params={{ sequence: event.sequence }} />
                        </summary>
                        <dl className="lt-kv">
                          <div>
                            <dt>
                              <Copy k="eventReference" />
                            </dt>
                            <dd lang="zxx">{event.id}</dd>
                          </div>
                          <div>
                            <dt>
                              <Copy k="actorReference" />
                            </dt>
                            <dd lang="zxx">{event.actorId}</dd>
                          </div>
                          <div>
                            <dt>
                              <Copy k="recordedAt" />
                            </dt>
                            <dd lang="zxx">{event.occurredAt}</dd>
                          </div>
                        </dl>
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
          <div className="lt-stack">
            <p>
              <Copy k="returned" params={{ count: resource.data.length, limit }} />
            </p>
            {resource.data.length >= limit &&
              (limit < 500 ? (
                <>
                  <p>
                    <Copy k="more" />
                  </p>
                  <Button tone="secondary" onClick={() => setLimit(Math.min(500, limit + 50))}>
                    <Copy k="loadMore" params={{ limit: Math.min(500, limit + 50) }} />
                  </Button>
                </>
              ) : (
                <p>
                  <Copy k="cap" />
                </p>
              ))}
          </div>
        </>
      )}
    </section>
  );
}

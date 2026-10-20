import { useId, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { supportEventsCopy } from './support-events-copy';
import './support-events.css';

const statusSchema = z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']);
// Local browser schema matches the mounted support.events output. No server
// contract import, delivery state, or operator-only case-file read is needed.
const eventSchema = z
  .object({
    id: z.string().uuid(),
    ticketId: z.string().uuid(),
    sequence: z.number().int().positive(),
    kind: z.enum(['opened', 'assigned', 'status_changed', 'grounding_read', 'escalated']),
    actorId: z.string().uuid(),
    actorRole: z.enum(['user', 'operator']),
    fromStatus: statusSchema.nullable(),
    toStatus: statusSchema.nullable(),
    note: z.string().max(500).nullable(),
    occurredAt: z.string().datetime(),
  })
  .refine(
    (event) =>
      event.kind === 'status_changed'
        ? event.fromStatus !== null && event.toStatus !== null && event.fromStatus !== event.toStatus
        : event.fromStatus === null && event.toStatus === null,
    () => ({ message: supportEventsCopy.t('invalidTransition') }),
  );
export type SupportEvent = z.infer<typeof eventSchema>;

export function supportEventsSchema(ticketId: string, limit: number, ownerId: string) {
  return z
    .array(eventSchema)
    .max(limit)
    .refine(
      (rows) => rows.every((row) => row.ticketId === ticketId && (row.actorRole !== 'user' || row.actorId === ownerId)),
      supportEventsCopy.t('ownership'),
    )
    .refine(
      (rows) =>
        new Set(rows.map((row) => row.id)).size === rows.length &&
        rows.every((row, index) => index === 0 || row.sequence > rows[index - 1]!.sequence),
      supportEventsCopy.t('invalidOrder'),
    );
}

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
    return api.query('support', 'events', { ticketId, limit }, supportEventsSchema(ticketId, limit, userId), { signal });
  }, `support-events:${userId}:${ticketId}:${ticketUpdatedAt}:${limit}`);

  return (
    <section className="support-history" aria-labelledby={headingId} lang={languageFor('history')}>
      <header className="support-history-heading">
        <h3 id={headingId}>
          <Copy k="history" />
        </h3>
        <Button variant="secondary" onClick={reload} disabled={resource.status === 'loading'}>
          <Copy k="refresh" />
        </Button>
      </header>
      <p className="support-history-description">
        <Copy k="description" />
      </p>
      {resource.status === 'loading' ? (
        <Loading label={t('loading')} />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <Failure result={resource.failure} retry={reload} />
        </div>
      ) : (
        <>
          {resource.data.length === 0 ? (
            <EmptyState title={t('empty')}>
              <Copy k="emptyDetail" />
            </EmptyState>
          ) : (
            <>
              {hasSupportEventGap(resource.data) && (
                <p className="notice" role="status">
                  <Copy k="gap" />
                </p>
              )}
              <ol className="support-event-list" aria-label={t('history')}>
                {resource.data.map((event) => (
                  <li className="support-event" key={event.id}>
                    <span className="support-event-sequence" aria-label={t('sequence')}>
                      {event.sequence}
                    </span>
                    <div className="support-event-body">
                      <h4>
                        <Copy k={event.kind} />
                      </h4>
                      <p className="support-event-meta">
                        <Copy k={event.actorRole === 'operator' ? 'operator' : event.actorId === userId ? 'you' : 'user'} />
                        {' · '}
                        <time dateTime={event.occurredAt} lang={requestedLocale}>
                          {new Date(event.occurredAt).toLocaleString(requestedLocale)}
                        </time>
                      </p>
                      {event.kind === 'status_changed' && event.fromStatus && event.toStatus && (
                        <p className="support-event-transition">{t('transition', { from: t(event.fromStatus), to: t(event.toStatus) })}</p>
                      )}
                      {event.note !== null && (
                        <p className="support-event-note" lang="und">
                          {event.note}
                        </p>
                      )}
                      <details className="support-event-reference">
                        <summary>
                          <Copy k="showReference" params={{ sequence: event.sequence }} />
                        </summary>
                        <dl>
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
          <div className="support-history-coverage">
            <p>
              <Copy k="returned" params={{ count: resource.data.length, limit }} />
            </p>
            {resource.data.length >= limit &&
              (limit < 500 ? (
                <>
                  <p>
                    <Copy k="more" />
                  </p>
                  <Button variant="secondary" onClick={() => setLimit(Math.min(500, limit + 50))}>
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

import { useId, useState } from 'react';
import { z } from 'zod';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, EmptyState } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { useApi, useSession } from '../session/session';
import { t as copyText, Text } from './copy';
import { Details, Limit, Read, type useAction } from './common';
import { SupportEvents } from './SupportEvents';
import { supportEventsCopy } from './support-events-copy';
import { deskCopy } from './support-desk-copy';
import {
  canFollowUp,
  canReply,
  customerStatus,
  replyReopens,
  SUPPORT_TICKETS_HREF,
  ticketReference,
  type TicketStatus,
} from './support-desk';
import { SupportRequestActions } from './SupportRequestActions';
import { commentSchema, myTicketPropertiesSchema, ticketSchema, type MyTicketProperties, type Ticket } from './support-schemas';
import { plainSupportResult } from './support-refusal';

const STATUS_KEY = {
  open: 'statusOpen',
  pending: 'statusPending',
  on_hold: 'statusOnHold',
  resolved: 'statusResolved',
  closed: 'statusClosed',
} as const;
const STATUS_HELP_KEY = {
  open: 'statusOpenHelp',
  pending: 'statusPendingHelp',
  on_hold: 'statusOnHoldHelp',
  resolved: 'statusResolvedHelp',
  closed: 'statusClosedHelp',
} as const;

export function StatusBadge({ status }: { status: TicketStatus }) {
  const copy = deskCopy.useCopy();
  return <span className={`support-status support-status--${status}`}>{copy.t(STATUS_KEY[status])}</span>;
}

/** The service's answer for a request that is not the caller's or does not exist: the same answer for both. */
export function isTicketNotFound(failure: { code?: string; status?: number }): boolean {
  return failure.code === 'support.not_found' || (failure.status === 404 && failure.code === 'NOT_FOUND');
}

const CUSTOMER_KEY = { awaiting_reply: 'customerAwaiting', open: 'customerOpen', solved: 'customerSolved' } as const;
const CUSTOMER_TONE = { awaiting_reply: 'pending', open: 'open', solved: 'resolved' } as const;

/** What the customer reads as the request's status: Awaiting your reply, Open or Solved (SP-tickets-01). */
export function CustomerStatusBadge({ row }: { row: Pick<Ticket, 'status' | 'customerStatus'> }) {
  const copy = deskCopy.useCopy();
  const shown = customerStatus(row);
  return <span className={`support-status support-status--${CUSTOMER_TONE[shown]}`}>{copy.t(CUSTOMER_KEY[shown])}</span>;
}

/** An address under /support/tickets/ that names no request: it reads the same as somebody else's request. */
export function RequestNotFound() {
  const copy = deskCopy.useCopy();
  return (
    <EmptyState
      title={copy.t('badRequestTitle')}
      action={
        <a className="button button--secondary" href={SUPPORT_TICKETS_HREF}>
          {copy.t('openMyRequests')}
        </a>
      }
    >
      {copy.t('badRequestBody')}
    </EmptyState>
  );
}

/** An address under /support/ that is none of the desk's own: it says so instead of opening the help articles. */
export function SupportAddressUnknown() {
  const copy = deskCopy.useCopy();
  return (
    <EmptyState
      title={copy.t('unknownAddressTitle')}
      action={
        <a className="button button--secondary" href="/support">
          {copy.t('openSupport')}
        </a>
      }
    >
      {copy.t('unknownAddressBody')}
    </EmptyState>
  );
}

/** One request: what was asked, every reply, the history, and the controls to reply, close, rate and attach a file. */
/**
 * The desk's priority and type as rows on the customer's request: only those the owner shows, each "None set" until the
 * desk sets it. While the owner has not chosen, or the read fails, one row says so instead of leaving the place empty.
 */
export function propertyRows(
  props: MyTicketProperties | null,
  t: ReturnType<typeof deskCopy.useCopy>['t'],
  failed = false,
): [string, string][] {
  if (failed) return [[t('propertiesRow'), t('propertiesUnread')]];
  if (!props) return [];
  if (props.status !== 'ok') return [[t('propertiesRow'), t('propertiesUnset')]];
  const rows: [string, string][] = [];
  if (props.priority) rows.push([t('priorityRow'), props.priority.value ? t(`priority_${props.priority.value}`) : t('propertyNone')]);
  if (props.ticketType) rows.push([t('typeRow'), props.ticketType.value ? t(`type_${props.ticketType.value}`) : t('propertyNone')]);
  return rows;
}

export function SupportRequest({
  id,
  action,
  onUpdated,
  onBack,
  onFollowUp,
}: {
  id: string;
  action: ReturnType<typeof useAction>;
  onUpdated: () => void;
  onBack: () => void;
  onFollowUp: (ticket: Ticket) => void;
}) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession(),
    { timeZone } = usePreferences();
  const [limit, setLimit] = useState(50),
    [reply, setReply] = useState('');
  const detail = useResource(
      (signal) =>
        api.query(
          'support',
          'get',
          { ticketId: id },
          ticketSchema.refine(
            (row) => row.id === id && row.userId === userId,
            copyText('support.ticket.identity.does.not.match.this.account'),
          ),
          { signal },
        ),
      `support-detail:${userId}:${id}`,
    ),
    // The desk's priority and type, where the owner lets the customer read them (SP-tickets-04).
    properties = useResource(
      (signal) => api.query('support', 'myTicketProperties', { ticketId: id }, myTicketPropertiesSchema, { signal }),
      `support-properties:${userId}:${id}`,
    ),
    comments = useResource(
      (signal) =>
        api.query(
          'support',
          'listComments',
          { ticketId: id, limit },
          z
            .array(commentSchema)
            .refine((rows) => rows.every((row) => row.ticketId === id), copyText('support.comments.belong.to.another.ticket')),
          { signal },
        ),
      `support-comments:${userId}:${id}:${limit}`,
    );
  const replyId = useId();
  return (
    <section className="support-detail" aria-label={copy.t('conversation')}>
      <div className="support-detail__bar">
        <Button variant="ghost" onClick={onBack}>
          ← {copy.t('back')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            detail.reload();
            comments.reload();
          }}
        >
          {copy.t('refresh')}
        </Button>
      </div>
      {detail.resource.status === 'failed' && isTicketNotFound(detail.resource.failure) ? (
        <RequestNotFound />
      ) : (
        <Read resource={detail.resource} retry={detail.reload}>
          {(ticket) => (
            <>
              <header className="support-detail__head">
                <h2 lang="und">{ticket.subject}</h2>
                <div className="support-detail__meta">
                  <CustomerStatusBadge row={ticket} />
                  <span className="muted">
                    {copy.t('reference')} <span lang="zxx">{ticketReference(ticket.id)}</span>
                  </span>
                </div>
                <p className="muted">{copy.t(STATUS_HELP_KEY[ticket.status])}</p>
                <Details
                  items={[
                    [copy.t('topic'), copyText(`support.category.${ticket.category}` as 'support.category.account')],
                    [copy.t('started'), <span lang="zxx">{stamp(ticket.createdAt, timeZone)}</span>],
                    [copy.t('lastActivity'), <span lang="zxx">{stamp(ticket.updatedAt, timeZone)}</span>],
                    ...propertyRows(
                      properties.resource.status === 'ready' ? properties.resource.data : null,
                      copy.t,
                      properties.resource.status === 'failed',
                    ),
                  ]}
                />
              </header>
              <div className="support-thread">
                <div className="support-bubble support-bubble--you">
                  <small>
                    <strong>{copy.t('fromYou')}</strong> · <span lang="zxx">{stamp(ticket.createdAt, timeZone)}</span>
                  </small>
                  <p lang="und">{ticket.body}</p>
                </div>
              </div>
              <Read resource={comments.resource} retry={comments.reload}>
                {(rows) => (
                  <>
                    {rows.length === 0 ? (
                      <p className="muted">{copy.t('noRepliesYet')}</p>
                    ) : (
                      <ol className="support-thread">
                        {rows.map((row) => (
                          <li key={row.id} className={`support-bubble support-bubble--${row.authorRole === 'user' ? 'you' : 'team'}`}>
                            <small>
                              <strong>{copy.t(row.authorRole === 'user' ? 'fromYou' : 'fromTeam')}</strong> ·{' '}
                              <span lang="zxx">{stamp(row.createdAt, timeZone)}</span>
                            </small>
                            <p lang="und">{row.body}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                    <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
                  </>
                )}
              </Read>
              <SupportEvents ticketId={ticket.id} ticketUpdatedAt={ticket.updatedAt} />
              {canReply(ticket.status) ? (
                <div className="support-reply">
                  <label className="field" htmlFor={replyId}>
                    <span>{copy.t('replyLabel')}</span>
                    <textarea
                      id={replyId}
                      lang="und"
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      maxLength={10000}
                      rows={4}
                    />
                    <small>{copy.t('replyHint')}</small>
                  </label>
                  {replyReopens(ticket.status) && (
                    <p className="muted">
                      <Text k="support.resolved.reply.reopens.same.request" />
                    </p>
                  )}
                  <Button
                    disabled={action.disabled || !reply.trim()}
                    onClick={() =>
                      action.stage({
                        title: () => copyText('support.review.reply'),
                        reference: id,
                        confirm: () => copyText('support.send.reply'),
                        success: () => copyText('support.reply.posted'),
                        content: () => (
                          <Details
                            items={[
                              [supportEventsCopy.t('originalRequest'), <span lang="zxx">{ticketReference(id)}</span>],
                              [copyText('support.status'), deskCopy.t(STATUS_KEY[ticket.status])],
                              [copyText('support.subject'), <span lang="und">{ticket.subject}</span>],
                              [copyText('support.reply'), <span lang="und">{reply}</span>],
                            ]}
                          />
                        ),
                        run: async () =>
                          plainSupportResult(
                            await api.mutate(
                              'support',
                              'comment',
                              // The reply to the request as it stood when it was read: sent again after a lost answer it is
                              // the same reply, and the service keeps one. Any change to the request gives the next reply its own.
                              { ticketId: id, body: reply.trim(), clientRequestId: `reply:${id}:${ticket.updatedAt}` },
                              commentSchema.refine(
                                (row) =>
                                  row.ticketId === id && row.authorId === userId && row.authorRole === 'user' && row.body === reply.trim(),
                                copyText('support.posted.comment.does.not.match.this.account'),
                              ),
                            ),
                            // The reply key was used for other words: the request moved on since this page read it.
                            { 'support.idempotency_conflict': 'refuseReplyChanged' },
                          ),
                        done: () => {
                          setReply('');
                          comments.reload();
                          detail.reload();
                          onUpdated();
                        },
                      })
                    }
                  >
                    {copy.t('reviewReply')}
                  </Button>
                </div>
              ) : (
                <>
                  <p className="muted">{copy.t('closedNote')}</p>
                  {canFollowUp(ticket.status) && (
                    <Button variant="secondary" onClick={() => onFollowUp(ticket)}>
                      {copy.t('askFollowUp')}
                    </Button>
                  )}
                </>
              )}
              <SupportRequestActions
                ticket={ticket}
                action={action}
                onChanged={() => {
                  detail.reload();
                  comments.reload();
                  onUpdated();
                }}
              />
            </>
          )}
        </Read>
      )}
    </section>
  );
}

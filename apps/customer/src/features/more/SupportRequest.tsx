import { useState } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { TextAreaField } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { stamp } from '../../screens/money/time';
import { useApi, useSession } from '../session';
import { t as copyText } from './copy';
import { KitDetails, type KitAction } from './volt-action';
import { EmptyNote, KitLimit, KitRead } from './volt-parts';
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
import { SupportReadAccess } from './SupportReadAccess';
import { type MyTicketProperties, type Ticket } from './support-schemas';
import {
  SUPPORT_COMMENT,
  SUPPORT_GET,
  SUPPORT_LIST_COMMENTS,
  SUPPORT_MY_TICKET_PROPERTIES,
} from '@intafaced/contracts/support-customer-procedures';
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

/** The desk's own status tone: open waits on the desk, pending and on hold wait on someone, resolved and closed are done. */
const STATUS_TONE = { open: 'neutral', pending: 'accent', on_hold: 'accent', resolved: 'up', closed: 'neutral' } as const;

export function StatusBadge({ status }: { status: TicketStatus }) {
  const copy = deskCopy.useCopy();
  return (
    <Tag tone={STATUS_TONE[status]} data-testid="support-status" data-status={status}>
      {copy.t(STATUS_KEY[status])}
    </Tag>
  );
}

/** The service's answer for a request that is not the caller's or does not exist: the same answer for both. */
export function isTicketNotFound(failure: { code?: string; status?: number }): boolean {
  return failure.code === 'support.not_found' || (failure.status === 404 && failure.code === 'NOT_FOUND');
}

const CUSTOMER_KEY = { awaiting_reply: 'customerAwaiting', open: 'customerOpen', solved: 'customerSolved' } as const;
/** Waiting on the customer reads accent, solved reads up, the rest neutral; the words say which. */
const CUSTOMER_TONE = { awaiting_reply: 'accent', open: 'neutral', solved: 'up' } as const;

/** What the customer reads as the request's status: Awaiting your reply, Open or Solved (SP-tickets-01). */
export function CustomerStatusBadge({ row }: { row: Pick<Ticket, 'status' | 'customerStatus'> }) {
  const copy = deskCopy.useCopy();
  const shown = customerStatus(row);
  return (
    <Tag tone={CUSTOMER_TONE[shown]} data-testid="support-status" data-status={shown}>
      {copy.t(CUSTOMER_KEY[shown])}
    </Tag>
  );
}

/** An address under /support/tickets/ that names no request: it reads the same as somebody else's request. */
export function RequestNotFound() {
  const copy = deskCopy.useCopy();
  return (
    <EmptyNote
      title={copy.t('badRequestTitle')}
      action={
        <a className="lt-button lt-button-secondary" href={SUPPORT_TICKETS_HREF}>
          {copy.t('openMyRequests')}
        </a>
      }
    >
      {copy.t('badRequestBody')}
    </EmptyNote>
  );
}

/** An address under /support/ that is none of the desk's own: it says so instead of opening the help articles. */
export function SupportAddressUnknown() {
  const copy = deskCopy.useCopy();
  return (
    <EmptyNote
      title={copy.t('unknownAddressTitle')}
      action={
        <a className="lt-button lt-button-secondary" href="/support">
          {copy.t('openSupport')}
        </a>
      }
    >
      {copy.t('unknownAddressBody')}
    </EmptyNote>
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
  action: KitAction;
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
      (signal) => api.call(SUPPORT_GET, { ticketId: id }, { signal, accept: (row) => row.id === id && row.userId === userId }),
      `support-detail:${userId}:${id}`,
    ),
    // The desk's priority and type, where the owner lets the customer read them (SP-tickets-04).
    properties = useResource(
      (signal) => api.call(SUPPORT_MY_TICKET_PROPERTIES, { ticketId: id }, { signal }),
      `support-properties:${userId}:${id}`,
    ),
    comments = useResource(
      (signal) =>
        api.call(SUPPORT_LIST_COMMENTS, { ticketId: id, limit }, { signal, accept: (rows) => rows.every((row) => row.ticketId === id) }),
      `support-comments:${userId}:${id}:${limit}`,
    );
  return (
    <section className="lt-stack" aria-label={copy.t('conversation')}>
      <div className="lt-actions">
        <Button tone="quiet" onClick={onBack}>
          <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {copy.t('back')}
        </Button>
        <Button
          tone="secondary"
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
        <KitRead resource={detail.resource} retry={detail.reload}>
          {(ticket) => (
            <>
              <header className="lt-stack" data-testid="support-detail-head">
                <h2 className="lt-wrap" lang="und">
                  {ticket.subject}
                </h2>
                <div className="lt-actions">
                  <CustomerStatusBadge row={ticket} />
                  <span className="lt-hint">
                    {copy.t('reference')} <span lang="zxx">{ticketReference(ticket.id)}</span>
                  </span>
                </div>
                <p className="lt-hint">{copy.t(STATUS_HELP_KEY[ticket.status])}</p>
                <KitDetails
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
              <div className="lt-stack" data-author="you">
                <small>
                  <strong>{copy.t('fromYou')}</strong> · <span lang="zxx">{stamp(ticket.createdAt, timeZone)}</span>
                </small>
                <p className="lt-pre-wrap" lang="und">
                  {ticket.body}
                </p>
              </div>
              <KitRead resource={comments.resource} retry={comments.reload}>
                {(rows) => (
                  <>
                    {rows.length === 0 ? (
                      <p className="lt-hint">{copy.t('noRepliesYet')}</p>
                    ) : (
                      <ol className="lt-stack">
                        {rows.map((row) => (
                          <li key={row.id} className="lt-stack" data-author={row.authorRole === 'user' ? 'you' : 'team'}>
                            <small>
                              <strong>{copy.t(row.authorRole === 'user' ? 'fromYou' : 'fromTeam')}</strong> ·{' '}
                              <span lang="zxx">{stamp(row.createdAt, timeZone)}</span>
                            </small>
                            <p className="lt-pre-wrap" lang="und">
                              {row.body}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                    <KitLimit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
                  </>
                )}
              </KitRead>
              <SupportEvents ticketId={ticket.id} ticketUpdatedAt={ticket.updatedAt} />
              <SupportReadAccess ticket={ticket} action={action} />
              {canReply(ticket.status) ? (
                <div className="lt-stack">
                  <TextAreaField
                    label={copy.t('replyLabel')}
                    lang="und"
                    value={reply}
                    onChange={setReply}
                    maxLength={10000}
                    rows={4}
                    hint={copy.t('replyHint')}
                  />
                  {replyReopens(ticket.status) && <p className="lt-hint">{copyText('support.resolved.reply.reopens.same.request')}</p>}
                  <Button
                    tone="primary"
                    disabled={action.disabled || !reply.trim()}
                    onClick={() =>
                      action.stage({
                        title: () => copyText('support.review.reply'),
                        reference: id,
                        confirm: () => copyText('support.send.reply'),
                        success: () => copyText('support.reply.posted'),
                        content: () => (
                          <KitDetails
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
                            await api.call(
                              SUPPORT_COMMENT,
                              // The reply to the request as it stood when it was read: sent again after a lost answer it is
                              // the same reply, and the service keeps one. Any change to the request gives the next reply its own.
                              { ticketId: id, body: reply.trim(), clientRequestId: `reply:${id}:${ticket.updatedAt}` },
                              {
                                accept: (row) =>
                                  row.ticketId === id && row.authorId === userId && row.authorRole === 'user' && row.body === reply.trim(),
                              },
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
                  <p className="lt-hint">{copy.t('closedNote')}</p>
                  {canFollowUp(ticket.status) && (
                    <Button tone="secondary" onClick={() => onFollowUp(ticket)}>
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
        </KitRead>
      )}
    </section>
  );
}

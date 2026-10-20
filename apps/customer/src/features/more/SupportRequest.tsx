import { useId, useState } from 'react';
import { z } from 'zod';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { useApi, useSession } from '../session/session';
import { t as copyText, Text } from './copy';
import { Details, Limit, Read, type useAction } from './common';
import { SupportEvents } from './SupportEvents';
import { supportEventsCopy } from './support-events-copy';
import { deskCopy } from './support-desk-copy';
import { canReply, replyReopens, ticketReference, type TicketStatus } from './support-desk';
import { SupportRequestActions } from './SupportRequestActions';
import { commentSchema, ticketSchema } from './support-schemas';

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

/** One request: what was asked, every reply, the history, and the controls to reply, close, rate and attach a file. */
export function SupportRequest({
  id,
  action,
  onUpdated,
  onBack,
}: {
  id: string;
  action: ReturnType<typeof useAction>;
  onUpdated: () => void;
  onBack: () => void;
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
      <Read resource={detail.resource} retry={detail.reload}>
        {(ticket) => (
          <>
            <header className="support-detail__head">
              <h2 lang="und">{ticket.subject}</h2>
              <div className="support-detail__meta">
                <StatusBadge status={ticket.status} />
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
                      run: () =>
                        api.mutate(
                          'support',
                          'comment',
                          { ticketId: id, body: reply.trim() },
                          commentSchema.refine(
                            (row) =>
                              row.ticketId === id && row.authorId === userId && row.authorRole === 'user' && row.body === reply.trim(),
                            copyText('support.posted.comment.does.not.match.this.account'),
                          ),
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
              <p className="muted">{copy.t('closedNote')}</p>
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
    </section>
  );
}

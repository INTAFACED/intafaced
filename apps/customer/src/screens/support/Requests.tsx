import { useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  hasSupportEventGap,
  Note,
  refusalCopy,
  Row,
  Rows,
  StateBlock,
  stamp,
  StatusTag,
  supportEventsSchema,
  TextField,
  useResource,
  usePreferences,
  useSession,
  type Resource,
  type SupportEvent,
} from './deps';
import { supportScreenCopy } from './copy';
import { getTicket, listComments, listMine, postComment, type Comment, type Ticket, type TicketStatus } from './support-api';
import { canReply, paragraphs } from './support-view';

type Copy = ReturnType<typeof supportScreenCopy.useCopy>['t'];
const tag = { open: 'working', pending: 'pending', resolved: 'filled', closed: 'cancelled' } as const;
const word = (t: Copy, status: TicketStatus) =>
  status === 'open' ? t('Open') : status === 'pending' ? t('Waiting') : status === 'resolved' ? t('Resolved') : t('Closed');

/** Your requests, and the conversation for the one you open. `refreshKey` changes when a new message was just sent. */
export function Requests({ refreshKey }: { refreshKey: number }) {
  const { t } = supportScreenCopy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string | null>(null);
  const { resource, reload } = useResource(
    (signal) => listMine(api, userId, limit, signal),
    `support-mine:${userId}:${limit}:${refreshKey}`,
  );
  return (
    <>
      <Card
        title={t('Your requests')}
        action={
          <Button variant="secondary" size={32} onClick={reload}>
            {t('Refresh')}
          </Button>
        }
      >
        {resource.status === 'loading' ? (
          <StateBlock kind="loading" rows={3} rowHeight={64} label={t('Your requests')} />
        ) : resource.status === 'failed' ? (
          <StateBlock kind="error" title={t('Could not load')} onRetry={reload} retryLabel={t('Try again')} />
        ) : resource.data.length === 0 ? (
          <StateBlock kind="empty" title={t('No requests')} body={t('No requests body')} />
        ) : (
          <>
            <Rows label={t('Your requests')}>
              {resource.data.map((row) => (
                <Row
                  key={row.id}
                  title={<span className="sup-subject">{row.subject}</span>}
                  chip={<StatusTag status={tag[row.status]} label={word(t, row.status)} />}
                  line={t('Updated', { time: stamp(row.updatedAt, timeZone) })}
                  action={
                    <Button
                      variant={selected === row.id ? 'primary' : 'secondary'}
                      size={32}
                      aria-pressed={selected === row.id}
                      aria-label={`${t('Conversation')}: ${row.subject}`}
                      onClick={() => setSelected(selected === row.id ? null : row.id)}
                    >
                      {selected === row.id ? t('Close conversation') : t('Conversation')}
                    </Button>
                  }
                />
              ))}
            </Rows>
            {resource.data.length >= limit && limit < 500 ? (
              <div>
                <Button variant="secondary" size={32} onClick={() => setLimit((value) => Math.min(500, value + 50))}>
                  {t('Show more')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
      {selected ? <Conversation key={selected} id={selected} onChanged={reload} /> : null}
    </>
  );
}

function Conversation({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t } = supportScreenCopy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [revision, setRevision] = useState(0);
  const detail = useResource((signal) => getTicket(api, userId, id, signal), `support-detail:${userId}:${id}:${revision}`);
  const comments = useResource((signal) => listComments(api, id, 100, signal), `support-comments:${userId}:${id}:${revision}`);
  const events = useResource(
    (signal) =>
      userId
        ? api.query('support', 'events', { ticketId: id, limit: 50 }, supportEventsSchema(id, 50, userId), { signal })
        : Promise.resolve({ ok: true as const, data: [] as SupportEvent[] }),
    `support-events:${userId}:${id}:${revision}`,
  );
  const again = () => setRevision((value) => value + 1);
  // "Your reply was sent" lives here, not in the thread, because the thread is redrawn while it is read again.
  const [sent, setSent] = useState(false);
  return (
    <Card
      title={t('Conversation')}
      action={
        <Button variant="secondary" size={32} onClick={again}>
          {t('Refresh')}
        </Button>
      }
    >
      {detail.resource.status === 'loading' ? (
        <StateBlock kind="loading" rows={3} rowHeight={64} label={t('Conversation')} />
      ) : detail.resource.status === 'failed' ? (
        <StateBlock kind="error" title={t('Could not load')} onRetry={again} retryLabel={t('Try again')} />
      ) : (
        <Thread
          ticket={detail.resource.data}
          comments={comments.resource}
          events={events.resource}
          timeZone={timeZone}
          sent={sent}
          onSending={() => setSent(false)}
          onPosted={() => {
            setSent(true);
            again();
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function Thread({
  ticket,
  comments,
  events,
  timeZone,
  sent,
  onSending,
  onPosted,
}: {
  ticket: Ticket;
  comments: Resource<Comment[]>;
  events: Resource<SupportEvent[]>;
  timeZone: ReturnType<typeof usePreferences>['timeZone'];
  sent: boolean;
  onSending: () => void;
  onPosted: () => void;
}) {
  const { t } = supportScreenCopy.useCopy();
  const { api, userId } = useSession();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'none' | 'unknown' | { failed: string }>('none');
  async function send(event: FormEvent) {
    event.preventDefault();
    const clean = reply.trim();
    if (!clean || busy || !userId || !api.canWrite() || !canReply(ticket.status)) return;
    setBusy(true);
    setState('none');
    onSending();
    const answer = await postComment(api, userId, ticket.id, clean);
    setBusy(false);
    if (answer.ok) {
      setReply('');
      onPosted();
    } else if (answer.reason === 'uncertain') setState('unknown');
    else {
      const words = answer.code ? refusalCopy(answer.code) : null;
      setState({ failed: words ? `${words.title}. ${words.body}` : t('Send failed') });
    }
  }
  return (
    <div className="sup-thread">
      <div className="sup-thread__head">
        <h3 className="sk-h3 sup-subject">{ticket.subject}</h3>
        <StatusTag status={tag[ticket.status]} label={word(t, ticket.status)} />
      </div>
      <ol className="sup-msgs" aria-label={t('Conversation')}>
        <li className="sup-msg" data-mine="">
          <span className="sup-msg__who">
            {t('You')} · {stamp(ticket.createdAt, timeZone)}
          </span>
          {paragraphs(ticket.body).map((part, i) => (
            <p key={i} className="sup-p">
              {part}
            </p>
          ))}
        </li>
        {comments.status === 'ready'
          ? comments.data.map((row) => (
              <li key={row.id} className="sup-msg" data-mine={row.authorRole === 'user' ? '' : undefined}>
                <span className="sup-msg__who">
                  {row.authorRole === 'user' ? t('You') : t('Support')} · {stamp(row.createdAt, timeZone)}
                </span>
                {paragraphs(row.body).map((part, i) => (
                  <p key={i} className="sup-p">
                    {part}
                  </p>
                ))}
              </li>
            ))
          : null}
      </ol>
      {comments.status === 'ready' && comments.data.length === 0 ? <p className="sk-small">{t('No replies')}</p> : null}
      {comments.status === 'failed' ? <p className="sk-small">{t('Could not load')}</p> : null}

      {ticket.status === 'resolved' ? (
        <Note>
          <p>{t('Resolved note')}</p>
        </Note>
      ) : null}
      {ticket.status === 'closed' ? (
        <Note>
          <p>{t('Closed note')}</p>
        </Note>
      ) : (
        <form className="sup-form" onSubmit={(event) => void send(event)}>
          <TextField
            label={t('Reply')}
            name="support-reply"
            multiline
            required
            maxLength={10000}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
          />
          <div>
            <Button type="submit" variant="primary" size={40} loading={busy} disabled={!reply.trim()}>
              {t('Send reply')}
            </Button>
          </div>
        </form>
      )}
      {sent ? (
        <Note tone="good" role="status">
          <p>{t('Reply sent')}</p>
        </Note>
      ) : state === 'unknown' ? (
        <Note tone="warn" role="alert">
          <p>{t('Send unknown')}</p>
        </Note>
      ) : typeof state === 'object' ? (
        <Note tone="error" role="alert">
          <p>{state.failed}</p>
        </Note>
      ) : null}

      <History events={events} timeZone={timeZone} />
    </div>
  );
}

function History({ events, timeZone }: { events: Resource<SupportEvent[]>; timeZone: ReturnType<typeof usePreferences>['timeZone'] }) {
  const { t } = supportScreenCopy.useCopy();
  if (events.status !== 'ready') return null;
  return (
    <details className="sup-history">
      <summary className="sk-h3">{t('History')}</summary>
      {events.data.length === 0 ? (
        <p className="sk-small">{t('History empty')}</p>
      ) : (
        <ol className="sup-events">
          {events.data.map((event) => (
            <li key={event.id} className="sk-small">
              <strong>{eventWords(event, t)}</strong> · {stamp(event.occurredAt, timeZone)}
            </li>
          ))}
        </ol>
      )}
      {hasSupportEventGap(events.data) ? <p className="sk-small">…</p> : null}
    </details>
  );
}

function eventWords(event: SupportEvent, t: Copy): string {
  switch (event.kind) {
    case 'opened':
      return t('Event opened');
    case 'assigned':
      return t('Event assigned');
    case 'status_changed':
      return t('Event status', { from: word(t, event.fromStatus ?? 'open'), to: word(t, event.toStatus ?? 'open') });
    case 'escalated':
      return t('Event escalated');
    default:
      return t('Event grounding');
  }
}

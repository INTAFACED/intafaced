import { useState } from 'react';
import { z } from 'zod';
import { en } from '@intafaced/i18n/catalog';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
const ticketSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  category: z.enum(['account', 'trading', 'deposit_withdraw', 'other']),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  status: z.enum(['open', 'pending', 'resolved', 'closed']),
  assigneeId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const commentSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorRole: z.enum(['user', 'operator']),
  body: z.string(),
  createdAt: z.string(),
});
const kbSchema = z.object({
  id: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  version: z.number().int().positive().optional(),
  published: z.boolean().optional(),
});
function text(key: string) {
  return typeof en[key as keyof typeof en] === 'string'
    ? (en[key as keyof typeof en] as string)
    : `Published article text is unavailable for ${key}.`;
}
export function Support() {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('support');
  const [limit, setLimit] = useState(50),
    [q, setQ] = useState(''),
    [search, setSearch] = useState(''),
    [category, setCategory] = useState('other'),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [selected, setSelected] = useState(''),
    [comment, setComment] = useState('');
  const kb = useResource(
    (signal) => api.query('support', 'searchKb', { q: search, limit: 50 }, z.array(kbSchema), { signal }),
    `kb:${search}`,
  );
  const tickets = useResource(
    (signal) =>
      api.query(
        'support',
        'listMine',
        { limit },
        z.array(ticketSchema).refine((rows) => rows.every((row) => row.userId === userId), 'Ticket ownership does not match this account'),
        { signal },
      ),
    `support:${userId}:${limit}`,
  );
  return (
    <div className="more-columns">
      <div>
        <Panel title="Help articles">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q);
            }}
            className="more-inline"
          >
            <Field label="Search help" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
          <Read resource={kb.resource} retry={kb.reload} empty="No published articles match this search">
            {(rows) => (
              <div className="more-articles">
                {rows
                  .filter((r) => r.published !== false)
                  .map((r) => (
                    <details key={r.id}>
                      <summary>{text(r.titleKey)}</summary>
                      <p>{text(r.bodyKey)}</p>
                      <small>
                        Article {r.id}
                        {r.version ? ` · version ${r.version}` : ''}
                      </small>
                    </details>
                  ))}
              </div>
            )}
          </Read>
        </Panel>
        <Panel title="Your requests">
          <Read resource={tickets.resource} retry={tickets.reload} empty="You have no support requests">
            {(rows) => (
              <>
                <DataTable headers={['Request', 'Status', 'Updated']} label="Your support requests">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setSelected(row.id);
                            setComment('');
                          }}
                          aria-label={`Open ${row.subject}`}
                        >
                          {row.subject}
                        </Button>
                      </td>
                      <td>{row.status}</td>
                      <td>{row.updatedAt}</td>
                    </tr>
                  ))}
                </DataTable>
                <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
              </>
            )}
          </Read>
        </Panel>
        {selected && <Conversation id={selected} action={action} comment={comment} setComment={setComment} />}
      </div>
      <Panel title="Contact Support">
        <p className="muted">Send the details of your issue. A refund request is a support conversation; this form cannot move funds.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: 'Review support request',
              confirm: 'Send request',
              success: 'Request created',
              content: (
                <Details
                  items={[
                    ['Category', category],
                    ['Subject', subject],
                    ['Message', body],
                  ]}
                />
              ),
              run: () =>
                api.mutate(
                  'support',
                  'create',
                  { category, subject: subject.trim(), body: body.trim() },
                  ticketSchema.refine(
                    (row) =>
                      row.userId === userId && row.subject === subject.trim() && row.body === body.trim() && row.category === category,
                    'Created ticket does not match this account request',
                  ),
                ),
              done: () => {
                setSubject('');
                setBody('');
                tickets.reload();
              },
            });
          }}
        >
          <Select label="Category" value={category} onChange={setCategory} options={['account', 'trading', 'deposit_withdraw', 'other']} />
          <Field label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} />
          <TextArea label="Message" value={body} onChange={setBody} />
          <Button type="submit" disabled={action.disabled || !subject.trim() || !body.trim()}>
            Review request
          </Button>
        </form>
        {action.feedback}
      </Panel>
      {action.dialog}
    </div>
  );
}
function Conversation({
  id,
  action,
  comment,
  setComment,
}: {
  id: string;
  action: ReturnType<typeof useAction>;
  comment: string;
  setComment: (s: string) => void;
}) {
  const api = useApi(),
    { userId } = useSession();
  const [limit, setLimit] = useState(50);
  const detail = useResource(
      (signal) =>
        api.query(
          'support',
          'get',
          { ticketId: id },
          ticketSchema.refine((row) => row.id === id && row.userId === userId, 'Ticket identity does not match this account'),
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
          z.array(commentSchema).refine((rows) => rows.every((row) => row.ticketId === id), 'Comments belong to another ticket'),
          { signal },
        ),
      `support-comments:${userId}:${id}:${limit}`,
    );
  return (
    <Panel title="Conversation">
      <Read resource={detail.resource} retry={detail.reload}>
        {(ticket) => (
          <>
            <h2>{ticket.subject}</h2>
            <p>{ticket.body}</p>
            <small>
              {ticket.status} · {ticket.id}
            </small>
            <Read resource={comments.resource} retry={comments.reload} empty="No replies yet">
              {(rows) => (
                <>
                  <ol className="more-conversation">
                    {rows.map((row) => (
                      <li key={row.id}>
                        <small>
                          {row.authorRole} · {row.createdAt}
                        </small>
                        <p>{row.body}</p>
                      </li>
                    ))}
                  </ol>
                  <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
                </>
              )}
            </Read>
            <TextArea label="Reply" value={comment} onChange={setComment} />
            <Button
              disabled={action.disabled || !comment.trim() || ['closed', 'resolved'].includes(ticket.status)}
              onClick={() =>
                action.stage({
                  title: 'Review reply',
                  confirm: 'Send reply',
                  success: 'Reply posted',
                  content: <p>{comment}</p>,
                  run: () =>
                    api.mutate(
                      'support',
                      'comment',
                      { ticketId: id, body: comment.trim() },
                      commentSchema.refine(
                        (row) => row.ticketId === id && row.authorId === userId && row.authorRole === 'user',
                        'Posted comment does not match this account request',
                      ),
                    ),
                  done: () => {
                    setComment('');
                    comments.reload();
                    detail.reload();
                  },
                })
              }
            >
              Review reply
            </Button>
            {['closed', 'resolved'].includes(ticket.status) && (
              <p className="muted">This request is {ticket.status}; the service refuses further comments.</p>
            )}
          </>
        )}
      </Read>
    </Panel>
  );
}

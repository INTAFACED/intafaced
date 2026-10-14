import { copy, t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { publishedCopy, publishedLanguageFor } from '../../shared/copy';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, useAction } from './common';
import { isHiddenPath } from '../../app/feature-registry';
import { SupportEvents } from './SupportEvents';
import { supportEventsCopy } from './support-events-copy';
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
/** Help articles that describe features this release does not offer (Deposits and withdrawals, Paper vs live). */
const HIDDEN_FEATURE_ARTICLES: ReadonlySet<string> = new Set(['kb-deposit-withdraw-honest', 'kb-paper-vs-live']);
const CATEGORY_VALUES = ['account', 'trading', 'deposit_withdraw', 'other'] as const;
const CATEGORY_KEYS = {
  account: 'support.category.account',
  trading: 'support.category.trading',
  deposit_withdraw: 'support.category.deposit_withdraw',
  other: 'support.category.other',
} as const;
function categoryLabel(value: string): string {
  return value in CATEGORY_KEYS ? copyText(CATEGORY_KEYS[value as keyof typeof CATEGORY_KEYS]) : value;
}
const unavailableArticleKey = 'support.published.article.text.is.unavailable.for';
function text(key: string) {
  return publishedCopy(key) ?? copyText(unavailableArticleKey, { value1: key });
}
function SupportTextArea({
  label,
  value,
  onChange,
}: {
  label: 'support.message' | 'support.reply';
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <Text k={label} />
      <textarea lang="und" value={value} onChange={(e) => onChange(e.target.value)} maxLength={10000} rows={5} />
    </label>
  );
}
export function Support() {
  const { languageFor } = copy.useCopy();
  const depositsHidden = isHiddenPath('/uc/recharge');
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
        z
          .array(ticketSchema)
          .refine((rows) => rows.every((row) => row.userId === userId), copyText('support.ticket.ownership.does.not.match.this.account')),
        { signal },
      ),
    `support:${userId}:${limit}`,
  );
  return (
    <div className="more-columns">
      <div>
        <Panel title={copyText('support.help.articles')}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q);
            }}
            className="more-inline"
          >
            <Field label={copyText('support.search.help')} value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
            <Button type="submit" variant="secondary">
              <Text k="support.search" />
            </Button>
          </form>
          <Read resource={kb.resource} retry={kb.reload} empty={copyText('support.no.published.articles.match.this.search')}>
            {(rows) => (
              <div className="more-articles">
                {rows
                  .filter((r) => r.published !== false && !(depositsHidden && HIDDEN_FEATURE_ARTICLES.has(r.id)))
                  .map((r) => (
                    <details key={r.id}>
                      <summary lang={publishedLanguageFor(r.titleKey) ?? languageFor(unavailableArticleKey)}>{text(r.titleKey)}</summary>
                      <p lang={publishedLanguageFor(r.bodyKey) ?? languageFor(unavailableArticleKey)}>{text(r.bodyKey)}</p>
                    </details>
                  ))}
              </div>
            )}
          </Read>
        </Panel>
        <Panel title={copyText('support.your.requests')}>
          <Read resource={tickets.resource} retry={tickets.reload} empty={copyText('support.you.have.no.support.requests')}>
            {(rows) => (
              <>
                <DataTable
                  headers={[copyText('support.request'), copyText('support.status'), copyText('support.updated')]}
                  label={copyText('support.your.support.requests')}
                >
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Button
                          lang="und"
                          variant="ghost"
                          onClick={() => {
                            setSelected(row.id);
                            setComment('');
                          }}
                          aria-label={copyText('support.open', { value1: row.subject })}
                        >
                          {row.subject}
                        </Button>
                      </td>
                      <td lang="zxx">{row.status}</td>
                      <td lang="zxx">{row.updatedAt}</td>
                    </tr>
                  ))}
                </DataTable>
                <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
              </>
            )}
          </Read>
        </Panel>
        {selected && (
          <Conversation key={selected} id={selected} action={action} comment={comment} setComment={setComment} onUpdated={tickets.reload} />
        )}
      </div>
      <Panel title={copyText('support.contact.support')}>
        <p className="muted">
          <Text k="support.send.the.details.of.your.issue.a" />
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: () => copyText('support.review.support.request'),
              confirm: () => copyText('support.send.request'),
              success: () => copyText('support.request.created'),
              content: () => (
                <Details
                  items={[
                    [copyText('support.category'), <span>{categoryLabel(category)}</span>],
                    [copyText('support.subject'), <span lang="und">{subject}</span>],
                    [copyText('support.message'), <span lang="und">{body}</span>],
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
                    copyText('support.created.ticket.does.not.match.this.account'),
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
          <Select
            label={copyText('support.category')}
            value={category}
            onChange={setCategory}
            options={CATEGORY_VALUES.filter((value) => !(depositsHidden && value === 'deposit_withdraw')).map((value) => ({
              value,
              label: categoryLabel(value),
            }))}
          />
          <Field
            label={<Text k="support.subject" />}
            lang="und"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            maxLength={200}
          />
          <SupportTextArea label="support.message" value={body} onChange={setBody} />
          <Button type="submit" disabled={action.disabled || !subject.trim() || !body.trim()}>
            <Text k="support.review.request" />
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
  onUpdated,
}: {
  id: string;
  action: ReturnType<typeof useAction>;
  comment: string;
  setComment: (s: string) => void;
  onUpdated: () => void;
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
  return (
    <Panel title={copyText('support.conversation')}>
      <div className="support-ticket-context">
        <p className="support-ticket-reference">
          <supportEventsCopy.Copy k="originalRequest" />
          <span lang="zxx">{id}</span>
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            detail.reload();
            comments.reload();
          }}
        >
          <supportEventsCopy.Copy k="refreshRequest" />
        </Button>
      </div>
      <Read resource={detail.resource} retry={detail.reload}>
        {(ticket) => (
          <>
            <h2 lang="und">{ticket.subject}</h2>
            <p lang="und">{ticket.body}</p>
            <small lang="zxx">
              {ticket.status} · {ticket.id}
            </small>
            <Read resource={comments.resource} retry={comments.reload} empty={copyText('support.no.replies.yet')}>
              {(rows) => (
                <>
                  <ol className="more-conversation">
                    {rows.map((row) => (
                      <li key={row.id}>
                        <small>
                          <span lang="zxx">{row.authorRole}</span> · <span lang="zxx">{row.createdAt}</span>
                        </small>
                        <p lang="und">{row.body}</p>
                      </li>
                    ))}
                  </ol>
                  <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
                </>
              )}
            </Read>
            <SupportEvents ticketId={ticket.id} ticketUpdatedAt={ticket.updatedAt} />
            {ticket.status === 'resolved' && (
              <p className="muted">
                <Text k="support.resolved.reply.reopens.same.request" />
              </p>
            )}
            <SupportTextArea label="support.reply" value={comment} onChange={setComment} />
            <Button
              disabled={action.disabled || !comment.trim() || ticket.status === 'closed'}
              onClick={() =>
                action.stage({
                  title: () => copyText('support.review.reply'),
                  reference: id,
                  confirm: () => copyText('support.send.reply'),
                  success: () => copyText('support.reply.posted'),
                  content: () => (
                    <>
                      <Details
                        items={[
                          [supportEventsCopy.t('originalRequest'), <span lang="zxx">{id}</span>],
                          [copyText('support.status'), <span lang="zxx">{ticket.status}</span>],
                          [copyText('support.subject'), <span lang="und">{ticket.subject}</span>],
                          [copyText('support.reply'), <span lang="und">{comment}</span>],
                        ]}
                      />
                      {ticket.status === 'resolved' && (
                        <p className="muted">
                          <Text k="support.resolved.reply.reopens.same.request" />
                        </p>
                      )}
                    </>
                  ),
                  run: () =>
                    api.mutate(
                      'support',
                      'comment',
                      { ticketId: id, body: comment.trim() },
                      commentSchema.refine(
                        (row) => row.ticketId === id && row.authorId === userId && row.authorRole === 'user' && row.body === comment.trim(),
                        copyText('support.posted.comment.does.not.match.this.account'),
                      ),
                    ),
                  done: () => {
                    setComment('');
                    comments.reload();
                    detail.reload();
                    onUpdated();
                  },
                })
              }
            >
              <Text k="support.review.reply" />
            </Button>
            {ticket.status === 'closed' && (
              <p className="muted">
                <Text k="support.this.request.is" />
                {ticket.status}
                <Text k="support.the.service.refuses.further.comments" />
              </p>
            )}
          </>
        )}
      </Read>
    </Panel>
  );
}

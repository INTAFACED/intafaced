import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Field, Tabs } from '../../shared/ui';
import { isHiddenPath } from '../../app/feature-registry';
import { stamp } from '../../screens/money/time';
import { useApi, useSession } from '../session/session';
import { t as copyText } from './copy';
import { Details, Read, Select, useAction } from './common';
import { SupportHelpArticles } from './SupportHelpArticles';
import { StatusBadge, SupportRequest } from './SupportRequest';
import { deskCopy } from './support-desk-copy';
import { STATUS_FILTERS, filterTickets, statusCounts, ticketReference, type StatusFilter } from './support-desk';
import { CATEGORY_VALUES, ticketSchema, type Ticket } from './support-schemas';
import './support-desk.css';

type View = 'help' | 'requests' | 'new';
const VIEWS: readonly View[] = ['help', 'requests', 'new'];
const VIEW_KEY = { help: 'tabHelp', requests: 'tabRequests', new: 'tabNew' } as const;
const FILTER_KEY = { all: 'filterAll', active: 'filterActive', resolved: 'filterResolved', closed: 'filterClosed' } as const;
const CATEGORY_KEYS = {
  account: 'support.category.account',
  trading: 'support.category.trading',
  deposit_withdraw: 'support.category.deposit_withdraw',
  phishing: 'support.category.phishing',
  other: 'support.category.other',
} as const;
const categoryLabel = (value: string): string =>
  value in CATEGORY_KEYS ? copyText(CATEGORY_KEYS[value as keyof typeof CATEGORY_KEYS]) : value;

/**
 * The support desk: published answers, your requests (list, search, conversation, reply) and a new request. Everything the
 * support service offers a signed-in person is here: reply, close, rate, attach a file, and feedback on help articles.
 */
export function Support() {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('support');
  const [view, setView] = useState<View>('help'),
    [selected, setSelected] = useState('');
  const limit = 200;
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
  const labels = Object.fromEntries(VIEWS.map((id) => [id, copy.t(VIEW_KEY[id])]));
  return (
    <div className="support-desk">
      <Tabs
        items={VIEWS}
        value={view}
        onChange={(next) => {
          setView(next as View);
          if (next !== 'requests') setSelected('');
        }}
        label={copy.t('tabsLabel')}
        labels={labels}
      />
      {view === 'help' && <SupportHelpArticles action={action} onStartRequest={() => setView('new')} />}
      {view === 'requests' &&
        (selected ? (
          <SupportRequest key={selected} id={selected} action={action} onUpdated={tickets.reload} onBack={() => setSelected('')} />
        ) : (
          <Read resource={tickets.resource} retry={tickets.reload}>
            {(rows) => <RequestList rows={rows} onOpen={setSelected} onStart={() => setView('new')} />}
          </Read>
        ))}
      {view === 'new' && (
        <NewRequest
          action={action}
          onSent={() => {
            tickets.reload();
            setView('requests');
          }}
        />
      )}
      {action.feedback}
      {action.dialog}
    </div>
  );
}

function RequestList({ rows, onOpen, onStart }: { rows: Ticket[]; onOpen: (id: string) => void; onStart: () => void }) {
  const copy = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const [filter, setFilter] = useState<StatusFilter>('all'),
    [text, setText] = useState('');
  const counts = statusCounts(rows);
  const shown = filterTickets(rows, filter, text);
  if (rows.length === 0)
    return (
      <EmptyState title={copy.t('noRequestsTitle')} action={<Button onClick={onStart}>{copy.t('startRequest')}</Button>}>
        {copy.t('noRequestsBody')}
      </EmptyState>
    );
  return (
    <section className="support-pane" aria-label={copy.t('tabRequests')}>
      <p className="muted">{copy.t('requestsIntro')}</p>
      <div className="support-toolbar">
        <div className="support-chips" role="group" aria-label={copy.t('filterLabel')}>
          {STATUS_FILTERS.map((id) => (
            <button
              type="button"
              key={id}
              className={`support-chip${filter === id ? ' support-chip--on' : ''}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {copy.t(FILTER_KEY[id])} <span aria-hidden="true">{counts[id]}</span>
            </button>
          ))}
        </div>
        <Field label={copy.t('searchRequests')} value={text} onChange={(event) => setText(event.target.value)} maxLength={200} />
      </div>
      {shown.length === 0 ? (
        <EmptyState title={copy.t('noMatchTitle')}>{copy.t('noMatchBody')}</EmptyState>
      ) : (
        <ul className="support-rows">
          {shown.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="support-row"
                onClick={() => onOpen(row.id)}
                aria-label={copy.t('openRequest', { subject: row.subject })}
              >
                <span className="support-row__main">
                  <span className="support-row__subject" lang="und">
                    {row.subject}
                  </span>
                  <span className="support-row__meta muted">
                    <span lang="zxx">{ticketReference(row.id)}</span> · {categoryLabel(row.category)} · {copy.t('lastActivity')}{' '}
                    <span lang="zxx">{stamp(row.updatedAt, timeZone)}</span>
                  </span>
                </span>
                <StatusBadge status={row.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewRequest({ action, onSent }: { action: ReturnType<typeof useAction>; onSent: () => void }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const depositsHidden = isHiddenPath('/uc/recharge');
  const [category, setCategory] = useState('other'),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [headers, setHeaders] = useState('');
  const sendHeaders = category === 'phishing' && headers.trim() !== '' ? headers.trim() : null;
  return (
    <section className="support-pane support-new" aria-label={copy.t('tabNew')}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // One key per decision: a double tap or a retry of this review returns the first ticket instead of a second.
          const clientRequestId = `create:${crypto.randomUUID()}`;
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
                  ...(sendHeaders ? [[copy.t('headersField'), <span lang="und">{sendHeaders}</span>] as [string, ReactNode]] : []),
                ]}
              />
            ),
            run: () =>
              api.mutate(
                'support',
                'create',
                {
                  category,
                  subject: subject.trim(),
                  body: body.trim(),
                  ...(sendHeaders ? { messageHeaders: sendHeaders } : {}),
                  clientRequestId,
                },
                ticketSchema.refine(
                  (row) => row.userId === userId && row.subject === subject.trim() && row.body === body.trim() && row.category === category,
                  copyText('support.created.ticket.does.not.match.this.account'),
                ),
              ),
            done: () => {
              setSubject('');
              setBody('');
              setHeaders('');
              onSent();
            },
          });
        }}
      >
        <p className="muted">{copy.t('newIntro')}</p>
        <p className="support-warning" role="note">
          {copy.t('newWarning')}
        </p>
        <Select
          label={copy.t('topicField')}
          value={category}
          onChange={setCategory}
          options={CATEGORY_VALUES.filter((value) => !(depositsHidden && value === 'deposit_withdraw')).map((value) => ({
            value,
            label: categoryLabel(value),
          }))}
        />
        <Field
          label={copy.t('subjectField')}
          lang="und"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          required
          maxLength={200}
        />
        <label className="field">
          <span>{copy.t('messageField')}</span>
          <textarea lang="und" value={body} onChange={(event) => setBody(event.target.value)} maxLength={10000} rows={7} />
          <small>{copy.t('characters', { count: body.length, max: 10000 })}</small>
        </label>
        {category === 'phishing' && (
          <>
            <p className="support-warning" role="note">
              {copy.t('phishingNote')}
            </p>
            <label className="field">
              <span>{copy.t('headersField')}</span>
              <textarea lang="zxx" value={headers} onChange={(event) => setHeaders(event.target.value)} maxLength={10000} rows={5} />
              <small>{copy.t('headersHint')}</small>
              <small>{copy.t('headersCharacters', { count: headers.length, max: 10000 })}</small>
            </label>
          </>
        )}
        <Button type="submit" disabled={action.disabled || !subject.trim() || !body.trim()}>
          {copy.t('reviewRequest')}
        </Button>
      </form>
      <aside className="support-tips">
        <h3>{copy.t('tipsHeading')}</h3>
        <ul>
          <li>{copy.t('tipWhat')}</li>
          <li>{copy.t('tipSee')}</li>
          <li>{copy.t('tipWhen')}</li>
          <li>{copy.t('tipRef')}</li>
        </ul>
      </aside>
    </section>
  );
}

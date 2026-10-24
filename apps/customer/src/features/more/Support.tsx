import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { CustomerStatusBadge, RequestNotFound, SupportAddressUnknown, SupportRequest } from './SupportRequest';
import { navigate } from '../../app/location';
import { deskCopy } from './support-desk-copy';
import {
  STATUS_FILTERS,
  filterTickets,
  followUpDraft,
  showRatePrompt,
  SUPPORT_TICKETS_HREF,
  supportRequestHref,
  supportRoute,
  type SupportRoute,
  statusCounts,
  ticketReference,
  type StatusFilter,
} from './support-desk';
import { readRatedTicketIds } from './support-calls';
import { CATEGORY_VALUES, ticketSchema, type Ticket } from './support-schemas';
import { supportRequestFormsSchema, type SupportField, type SupportFieldValue } from '@intafaced/contracts/support-forms';
import { supportCategoriesSchema } from '@intafaced/contracts/support-categories';
import { formAnswers, formReady, RequestTypeFields, type FormAnswers } from './SupportRequestForm';

import './support-desk.css';

/** An answer as the review step reads it: a choice by its label, a box as yes or no, text as typed. */
function answerText(field: SupportField | undefined, value: SupportFieldValue): string {
  if (typeof value === 'boolean') return value ? copyText('support.answer.yes') : copyText('support.answer.no');
  return field?.options?.find((option) => option.value === value)?.label ?? value;
}

type View = 'help' | 'requests' | 'new';
const VIEWS: readonly View[] = ['help', 'requests', 'new'];
const VIEW_KEY = { help: 'tabHelp', requests: 'tabRequests', new: 'tabNew' } as const;
/** Each tab is an address of its own (SP-tickets-01), so a request, the list and the form can be linked and reloaded. */
const VIEW_HREF = { help: '/support', requests: SUPPORT_TICKETS_HREF, new: '/support/new' } as const;
const FILTER_KEY = { all: 'filterAll', active: 'filterActive', resolved: 'filterResolved', closed: 'filterClosed' } as const;
const CATEGORY_KEYS = {
  account: 'support.category.account',
  trading: 'support.category.trading',
  deposit_withdraw: 'support.category.deposit_withdraw',
  phishing: 'support.category.phishing',
  fraud_report: 'support.category.fraud_report',
  other: 'support.category.other',
} as const;
const categoryLabel = (value: string): string =>
  value in CATEGORY_KEYS ? copyText(CATEGORY_KEYS[value as keyof typeof CATEGORY_KEYS]) : value;

/** The page title for each support address. */
export function supportPageTitleKey(route: SupportRoute): 'pageNewRequest' | 'pageMyRequests' | 'pageRequest' | 'pageUnknown' | null {
  if (route.view === 'new') return 'pageNewRequest';
  if (route.view === 'requests') return 'pageMyRequests';
  if (route.view === 'request' || route.view === 'badRequest') return 'pageRequest';
  if (route.view === 'unknown') return 'pageUnknown';
  return null;
}

/**
 * The support desk: published answers (/support), your requests (/support/tickets, one at /support/tickets/:id) and a new
 * request (/support/new). Everything the support service offers a signed-in person is here: reply, close, rate, attach a
 * file, and feedback on help articles.
 */
export function Support({ path }: { path: string }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const url = new URL(path, location.origin);
  const route = supportRoute(url.pathname, url.search);
  const view: View = route.view === 'new' ? 'new' : route.view === 'help' || route.view === 'unknown' ? 'help' : 'requests';
  // Replies, closing, rating, attaching and article feedback share one action with no recovery lookup, as before.
  const action = useAction('support');
  // A new request has its own action, because only its key can be read back (support.createdByRequest): a lost answer is
  // recovered by that read, never by sending again. `recovered` holds what the read found: the stored request to open, or
  // null when that send never reached the service.
  const recovered = useRef<Ticket | null | undefined>(undefined);
  const createAction = useAction('support-create', {
    recover: async (reference) => {
      const read = await api.query(
        'support',
        'createdByRequest',
        { clientRequestId: reference },
        ticketSchema
          .nullable()
          .refine((row) => row === null || row.userId === userId, copyText('support.created.ticket.does.not.match.this.account')),
      );
      recovered.current = read.ok ? read.data : undefined;
      return read;
    },
    done: () => {
      const found = recovered.current;
      recovered.current = undefined;
      reloadRequests();
      if (found) navigate(supportRequestHref(found.id));
      else if (found === null) setNotReached(location.pathname + location.search);
    },
  });
  const [followUp, setFollowUp] = useState<Ticket | null>(null),
    // The address where the "that send did not reach us" notice belongs; it goes once the person moves on.
    [notReached, setNotReached] = useState<string | null>(null);
  // A follow-up draft belongs to the form it was started for: leaving the form by any way (a tab, Back, a link) drops it.
  useEffect(() => {
    if (route.view !== 'new') setFollowUp(null);
  }, [route.view]);
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
  // Which requests already carry a rating. A failed read shows no chip rather than a wrong one.
  const rated = useResource((signal) => readRatedTicketIds(api, signal), `support-rated:${userId}`);
  const ratedIds = rated.resource.status === 'ready' ? new Set(rated.resource.data) : null;
  function reloadRequests() {
    tickets.reload();
    rated.reload();
  }
  const labels = Object.fromEntries(VIEWS.map((id) => [id, copy.t(VIEW_KEY[id])]));
  return (
    <div className="support-desk">
      <Tabs items={VIEWS} value={view} onChange={(next) => navigate(VIEW_HREF[next as View])} label={copy.t('tabsLabel')} labels={labels} />
      {route.view === 'help' && <SupportHelpArticles action={action} onStartRequest={() => navigate(VIEW_HREF.new)} />}
      {route.view === 'request' && (
        <SupportRequest
          key={route.id}
          id={route.id}
          action={action}
          onUpdated={reloadRequests}
          onBack={() => navigate(SUPPORT_TICKETS_HREF)}
          onFollowUp={(ticket) => {
            setFollowUp(ticket);
            navigate(VIEW_HREF.new);
          }}
        />
      )}
      {route.view === 'badRequest' && <RequestNotFound />}
      {route.view === 'unknown' && <SupportAddressUnknown />}
      {route.view === 'requests' && (
        <Read resource={tickets.resource} retry={tickets.reload}>
          {(rows) => (
            <RequestList
              rows={rows}
              ratedIds={ratedIds}
              onOpen={(id) => navigate(supportRequestHref(id))}
              onStart={() => navigate(VIEW_HREF.new)}
            />
          )}
        </Read>
      )}
      {route.view === 'new' && (
        <NewRequest
          key={`${userId}:${route.subject}`}
          action={createAction}
          subject={route.subject}
          follows={followUp}
          onClearFollows={() => setFollowUp(null)}
          onSent={(ticket) => {
            setFollowUp(null);
            reloadRequests();
            navigate(supportRequestHref(ticket.id));
          }}
        />
      )}
      {notReached === path && (
        <p className="notice" role="status" data-testid="support-create-not-reached">
          {copy.t('createNotReached')}
        </p>
      )}
      {route.view === 'new' ? createAction.feedback : action.feedback}
      {action.dialog}
      {createAction.dialog}
    </div>
  );
}

export function RequestList({
  rows,
  ratedIds,
  onOpen,
  onStart,
}: {
  rows: Ticket[];
  /** Ids that carry a rating, or null while that is unread or unreadable (no chip is shown then). */
  ratedIds: ReadonlySet<string> | null;
  onOpen: (id: string) => void;
  onStart: () => void;
}) {
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
                {ratedIds && showRatePrompt(row.status, true, ratedIds.has(row.id)) ? (
                  <span className="support-chip support-chip--on" data-testid="rate-chip">
                    {copy.t('rateChip')}
                  </span>
                ) : null}
                <CustomerStatusBadge row={row} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewRequest({
  action,
  subject: drafted,
  follows,
  onClearFollows,
  onSent,
}: {
  action: ReturnType<typeof useAction>;
  /** A subject drafted from the address (the words of a help search that found nothing). */
  subject: string;
  follows: Ticket | null;
  onClearFollows: () => void;
  onSent: (ticket: Ticket) => void;
}) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const depositsHidden = isHiddenPath('/uc/recharge');
  const draft = follows ? followUpDraft(follows, copy.t('followUpPrefix')) : null;
  const [category, setCategory] = useState(draft?.category ?? 'other'),
    [subject, setSubject] = useState(draft?.subject ?? drafted),
    [body, setBody] = useState(''),
    [headers, setHeaders] = useState('');
  const sendHeaders = category === 'phishing' && headers.trim() !== '' ? headers.trim() : null;
  // The request types the desk set up, each with its questions (SP-tickets-03). Unread or none: a general request.
  const catalogue = useResource(
    (signal) => api.query('support', 'requestForms', undefined, supportRequestFormsSchema, { signal }),
    `support-forms:${userId}`,
  );
  const forms = catalogue.resource.status === 'ready' ? catalogue.resource.data : null;
  // Where each category goes (SP-tickets-01): a fraud report goes to compliance, or cannot be sent and says why.
  const routes = useResource(
    (signal) => api.query('support', 'categories', undefined, supportCategoriesSchema, { signal }),
    `support-categories:${userId}`,
  );
  const route = routes.resource.status === 'ready' ? routes.resource.data.categories.find((row) => row.id === category) : undefined;
  const routeNote =
    route?.routesTo === 'compliance'
      ? route.refusal === null
        ? { key: 'fraudNote' as const, blocks: false }
        : { key: 'fraudUnset' as const, blocks: true }
      : category === 'fraud_report' && routes.resource.status !== 'ready'
        ? { key: 'fraudUnread' as const, blocks: true }
        : null;
  const [formId, setFormId] = useState(''),
    [answers, setAnswers] = useState<FormAnswers>({});
  const form = forms?.forms.find((row) => row.id === formId) ?? null;
  const sendForm = form && forms ? { formId: form.id, values: formAnswers(form, forms.fields, answers) } : null;
  const formOk = !form || !forms || formReady(form, forms.fields, answers);
  return (
    <section className="support-pane support-new" aria-label={copy.t('tabNew')}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // One key per decision: a double tap or a retry of this review returns the first ticket instead of a second, and a
          // lost answer is read back by this key (support.createdByRequest) instead of being sent again.
          const clientRequestId = `create:${crypto.randomUUID()}`;
          let created: Ticket | null = null;
          action.stage({
            reference: clientRequestId,
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
                  ...(form && sendForm && forms
                    ? [
                        [copy.t('requestTypeField'), <span lang="und">{form.name}</span>] as [string, ReactNode],
                        ...Object.entries(sendForm.values).map(([fieldId, value]) => {
                          const field = forms.fields.find((row) => row.id === fieldId);
                          return [field?.label ?? fieldId, <span lang="und">{answerText(field, value)}</span>] as [string, ReactNode];
                        }),
                      ]
                    : []),
                ]}
              />
            ),
            run: async () => {
              const result = await api.mutate(
                'support',
                'create',
                {
                  category,
                  subject: subject.trim(),
                  body: body.trim(),
                  ...(sendHeaders ? { messageHeaders: sendHeaders } : {}),
                  ...(follows ? { followsTicketId: follows.id } : {}),
                  ...(sendForm ? { form: sendForm } : {}),
                  clientRequestId,
                },
                ticketSchema.refine(
                  (row) => row.userId === userId && row.subject === subject.trim() && row.body === body.trim() && row.category === category,
                  copyText('support.created.ticket.does.not.match.this.account'),
                ),
              );
              if (result.ok) created = result.data;
              return result;
            },
            done: () => {
              setSubject('');
              setBody('');
              setHeaders('');
              if (created) onSent(created);
            },
          });
        }}
      >
        {follows && (
          <p className="notice" role="note">
            {copy.t('followUpBanner', { reference: ticketReference(follows.id) })}{' '}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onClearFollows();
                setSubject('');
              }}
            >
              {copy.t('followUpClear')}
            </Button>
          </p>
        )}
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
        <RequestTypeFields
          catalogue={forms}
          unread={catalogue.resource.status === 'failed'}
          formId={formId}
          onFormId={(id) => {
            setFormId(id);
            setAnswers({});
          }}
          answers={answers}
          onAnswers={setAnswers}
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
        {routeNote && (
          <p className="support-warning" role="note">
            {copy.t(routeNote.key)}
          </p>
        )}
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
        <Button type="submit" disabled={action.disabled || !subject.trim() || !body.trim() || !formOk || routeNote?.blocks === true}>
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

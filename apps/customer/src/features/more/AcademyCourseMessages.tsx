import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ACADEMY_COURSE_MESSAGES_LIST_MAX,
  academyCourseConversationSchema,
  academyCourseConversationSummarySchema,
  academySendCourseMessageResultSchema,
  type AcademyCourseConversation as Conversation,
} from '@intafaced/contracts/academy-course-messages';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { Button, Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { academyCodeOf, academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyMessagesHref, formatMoment } from './academy-lms';
import { AcademyRefusal } from './AcademyLmsParts';

/**
 * Message the course team (AC-rooms-04). A course page carries the contact form; the Rooms tab links to the reader's
 * conversations, each with its unread marker; opening one marks it read. Every message is stored by Academy; this build
 * has no email provider, so the email copy is named as switched off with `vendor.email`, and the message is sent anyway.
 */

const INBOX_PAGE = 50;

type Failure = Extract<ApiResult<never>, { ok: false }>;
type Outcome = { kind: 'refused'; failure: Failure } | { kind: 'uncertain' } | { kind: 'done'; conversationId: string };

const newRequest = () => `msg:${crypto.randomUUID()}`;

function Refused({ failure, testId }: { failure: Failure; testId: string }) {
  const { t } = copy.useCopy();
  const code = academyCodeOf(failure);
  const words = code === 'academy.enrolment_required' ? t('teamContactEnrolRequired') : academyRefusalText(failure, t);
  return (
    <div role="status" className="failure" data-testid={testId} data-code={code ?? undefined}>
      {words === null ? <AcademyRefusal failure={failure} /> : <p>{words}</p>}
    </div>
  );
}

/** Send one message to a course team; the same text sent again keeps its request id, so it is stored once. */
function useSend(courseSlug: string) {
  const api = useApi();
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const request = useRef(newRequest());
  const inFlight = useRef(false);
  const edited = () => {
    request.current = newRequest();
  };
  const send = async (body: string, onSent: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setOutcome(null);
    try {
      const sent = await api.mutate(
        'academy',
        'sendCourseMessage',
        { courseSlug, body, clientRequestId: request.current },
        academySendCourseMessageResultSchema,
      );
      if (sent.ok) {
        setOutcome({ kind: 'done', conversationId: sent.data.conversationId });
        request.current = newRequest();
        onSent();
      } else if (sent.reason === 'uncertain') setOutcome({ kind: 'uncertain' });
      else {
        setOutcome({ kind: 'refused', failure: sent });
        request.current = newRequest();
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return { sending, outcome, send, edited };
}

/** The contact form on a course page. */
export function CourseTeamContact({ courseSlug }: { courseSlug: string }) {
  const { t } = copy.useCopy();
  const id = useId();
  const [body, setBody] = useState('');
  const { sending, outcome, send, edited } = useSend(courseSlug);
  return (
    <Panel title={t('teamContactTitle')}>
      <form
        className="academy-lms-stack"
        data-testid="course-team-contact"
        onSubmit={(event) => {
          event.preventDefault();
          void send(body, () => setBody(''));
        }}
      >
        <p className="muted">{t('teamContactIntro')}</p>
        <p className="muted">
          {t('teamContactSupport')}{' '}
          <a className="text-link" href="/help">
            {t('teamContactSupportLink')}
          </a>
        </p>
        <label className="field" htmlFor={`${id}-body`}>
          <span>{t('teamContactLabel')}</span>
          <textarea
            id={`${id}-body`}
            value={body}
            rows={4}
            required
            onChange={(event) => {
              setBody(event.target.value);
              edited();
            }}
          />
        </label>
        <Button type="submit" disabled={sending}>
          {t('teamContactSend')}
        </Button>
        {outcome?.kind === 'done' && (
          <div className="academy-lms-stack">
            <p role="status" data-testid="course-team-outcome" data-code="ok">
              {t('teamContactSent')}
            </p>
            <ServiceOffNotice code="vendor.email" action={t('teamContactMailAction')} role="status" />
            <a className="academy-learning-link" href={academyMessagesHref(outcome.conversationId)}>
              {t('teamContactOpen')}
            </a>
          </div>
        )}
        {outcome?.kind === 'uncertain' && (
          <p role="status" className="failure" data-testid="course-team-outcome">
            {t('teamContactUncertain')}
          </p>
        )}
        {outcome?.kind === 'refused' && <Refused failure={outcome.failure} testId="course-team-outcome" />}
      </form>
    </Panel>
  );
}

/** The Rooms tab's way into the reader's conversations. */
export function AcademyCourseMessagesLink() {
  const { t } = copy.useCopy();
  return (
    <Panel title={t('teamMessagesTitle')}>
      <div className="academy-lms-stack">
        <p className="muted">{t('teamMessagesIntro')}</p>
        <a className="academy-learning-link" href={academyMessagesHref()}>
          {t('teamMessagesOpen')}
        </a>
      </div>
    </Panel>
  );
}

/** `/academy/rooms/messages`: the reader's conversations, newest first, each with its unread marker. */
export function AcademyCourseInbox() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const inbox = useResource(
    (signal) =>
      api.query('academy', 'courseConversations', { limit: INBOX_PAGE }, z.array(academyCourseConversationSummarySchema), { signal }),
    `course-inbox:${userId}`,
  );
  return (
    <div className="academy-lms-stack">
      <a className="text-link" href="/academy/rooms">
        {t('discussionAll')}
      </a>
      <Panel title={t('teamMessagesTitle')}>
        <div className="academy-lms-stack" data-course-inbox>
          <p className="muted">{t('teamMessagesIntro')}</p>
          {inbox.resource.status === 'loading' && <Loading />}
          {inbox.resource.status === 'failed' && <AcademyRefusal failure={inbox.resource.failure} retry={inbox.reload} />}
          {inbox.resource.status === 'ready' &&
            (inbox.resource.data.length === 0 ? (
              <p role="status">{t('teamMessagesNone')}</p>
            ) : (
              <ul className="academy-lms-rows">
                {inbox.resource.data.map((row) => (
                  <li key={row.id} data-course-inbox-row={row.id} data-unread={String(row.unread)}>
                    <div>
                      <a className="academy-learning-link" href={academyMessagesHref(row.id)} lang="und">
                        {row.courseTitle}
                      </a>
                      <div className="academy-lms-meta">
                        <span className="academy-lms-chip" data-status={row.unread ? 'open' : 'recorded'}>
                          {row.unread ? t('teamMessagesUnread') : t('teamMessagesRead')}
                        </span>
                        <span>{t('teamMessagesLast', { when: formatMoment(row.lastMessageAt.toISOString(), language) })}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </Panel>
    </div>
  );
}

/** `/academy/rooms/messages/:conversationId`: one conversation, oldest first. Opening it marks it read. */
export function AcademyCourseConversation({ conversationId }: { conversationId: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; data: Conversation } | { kind: 'failed'; failure: Failure }>({
    kind: 'loading',
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    // Opening is a write (it marks the conversation read), so it is a mutation, run once per open or re-read.
    void api
      .mutate(
        'academy',
        'openCourseConversation',
        { conversationId, limit: ACADEMY_COURSE_MESSAGES_LIST_MAX },
        academyCourseConversationSchema,
      )
      .then((opened) => {
        if (!live) return;
        if (opened.ok) setState({ kind: 'ready', data: opened.data });
        else setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'failed', failure: opened }));
      });
    return () => {
      live = false;
    };
  }, [api, conversationId, revision]);
  return (
    <div className="academy-lms-stack">
      <a className="text-link" href={academyMessagesHref()}>
        {t('teamMessagesAll')}
      </a>
      {state.kind === 'loading' && <Loading />}
      {state.kind === 'failed' && <AcademyRefusal failure={state.failure} retry={() => setRevision((n) => n + 1)} />}
      {state.kind === 'ready' && (
        <div className="academy-lms-stack" data-course-conversation={state.data.id}>
          <Panel title={<span lang="und">{state.data.courseTitle}</span>}>
            {state.data.earlier && (
              <p className="muted" data-earlier-messages>
                {t('teamMessagesEarlier', { count: ACADEMY_COURSE_MESSAGES_LIST_MAX })}
              </p>
            )}
            <ol className="academy-lms-rows">
              {state.data.messages.map((message) => (
                <li key={message.id} data-course-message={message.id} data-from={message.from}>
                  <div className="academy-lms-stack">
                    <div className="academy-lms-meta">
                      <strong>{message.from === 'learner' ? t('teamMessagesFromYou') : t('teamMessagesFromTeam')}</strong>
                      <span>{formatMoment(message.sentAt.toISOString(), language)}</span>
                    </div>
                    <p lang="und" className="academy-discussion-body">
                      {message.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
          <ConversationReply courseSlug={state.data.courseSlug} onSent={() => setRevision((n) => n + 1)} />
        </div>
      )}
    </div>
  );
}

function ConversationReply({ courseSlug, onSent }: { courseSlug: string; onSent: () => void }) {
  const { t } = copy.useCopy();
  const id = useId();
  const [body, setBody] = useState('');
  const { sending, outcome, send, edited } = useSend(courseSlug);
  return (
    <Panel title={t('teamMessagesReplyLabel')}>
      <form
        className="academy-lms-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void send(body, () => {
            setBody('');
            onSent();
          });
        }}
      >
        <label className="field" htmlFor={`${id}-body`}>
          <span>{t('teamMessagesReplyLabel')}</span>
          <textarea
            id={`${id}-body`}
            value={body}
            rows={3}
            required
            onChange={(event) => {
              setBody(event.target.value);
              edited();
            }}
          />
        </label>
        <Button type="submit" disabled={sending}>
          {t('teamMessagesReplySend')}
        </Button>
        {outcome?.kind === 'done' && <ServiceOffNotice code="vendor.email" action={t('teamContactMailAction')} role="status" />}
        {outcome?.kind === 'uncertain' && (
          <p role="status" data-testid="failure" className="failure">
            {t('teamContactUncertain')}
          </p>
        )}
        {outcome?.kind === 'refused' && <Refused failure={outcome.failure} testId="course-team-reply-outcome" />}
      </form>
    </Panel>
  );
}

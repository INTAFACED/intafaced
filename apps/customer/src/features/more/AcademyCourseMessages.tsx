// volt-room: /academy/rooms/messages/:conversationId
import { useEffect, useId, useRef, useState } from 'react';
import {
  ACADEMY_COURSE_MESSAGES_LIST_MAX,
  type AcademyCourseConversation as Conversation,
} from '@intafaced/contracts/academy-course-messages';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session';
import { academyCodeOf, academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyMessagesHref, formatMoment } from './academy-lms';
import { AcademyRefusal } from './academy-refusal';
import { ServiceOffNote } from './service-off-note';
import { ACADEMY_SEND_COURSE_MESSAGE } from '@intafaced/contracts/academy-send-course-message-procedures';
import { ACADEMY_COURSE_CONVERSATIONS } from '@intafaced/contracts/academy-course-conversations-procedures';
import { ACADEMY_OPEN_COURSE_CONVERSATION } from '@intafaced/contracts/academy-open-course-conversation-procedures';
import { Button } from '@intafaced/ui/lit';
import { ReadingTemplate, TextAreaField } from '@intafaced/ui/lit/templates';
import { AcademySections } from './academy-sections';
import { t as copyText } from './copy';
import { Section, Waiting } from './volt-parts';

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
    <div role="status" className="lt-refusal" data-testid={testId} data-code={code ?? undefined}>
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
      const sent = await api.call(ACADEMY_SEND_COURSE_MESSAGE, { courseSlug, body, clientRequestId: request.current });
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
    <Section title={t('teamContactTitle')}>
      <form
        data-testid="course-team-contact"
        onSubmit={(event) => {
          event.preventDefault();
          void send(body, () => setBody(''));
        }}
      >
        <p>{t('teamContactIntro')}</p>
        <p>
          {t('teamContactSupport')}{' '}
          <a className="lt-link" href="/help">
            {t('teamContactSupportLink')}
          </a>
        </p>
        <TextAreaField
          id={`${id}-body`}
          label={t('teamContactLabel')}
          value={body}
          rows={4}
          required
          onChange={(value) => {
            setBody(value);
            edited();
          }}
        />
        <Button tone="primary" type="submit" disabled={sending}>
          {t('teamContactSend')}
        </Button>
        {outcome?.kind === 'done' && (
          <div>
            <p role="status" data-testid="course-team-outcome" data-code="ok">
              {t('teamContactSent')}
            </p>
            <ServiceOffNote code="vendor.email" action={t('teamContactMailAction')} role="status" />
            <a className="lt-link" href={academyMessagesHref(outcome.conversationId)}>
              {t('teamContactOpen')}
            </a>
          </div>
        )}
        {outcome?.kind === 'uncertain' && (
          <p role="status" className="lt-refusal" data-testid="course-team-outcome">
            {t('teamContactUncertain')}
          </p>
        )}
        {outcome?.kind === 'refused' && <Refused failure={outcome.failure} testId="course-team-outcome" />}
      </form>
    </Section>
  );
}

/** The Rooms tab's way into the reader's conversations. */
export function AcademyCourseMessagesLink() {
  const { t } = copy.useCopy();
  return (
    <Section title={t('teamMessagesTitle')}>
      <div>
        <p>{t('teamMessagesIntro')}</p>
        <a className="lt-link" href={academyMessagesHref()}>
          {t('teamMessagesOpen')}
        </a>
      </div>
    </Section>
  );
}

/**
 * `/academy/rooms/messages`: the reader's conversations, newest first, each with its unread marker. The room that draws
 * them is academy-inbox/AcademyInboxRoom.tsx.
 */
export function useCourseInbox() {
  const api = useApi();
  const { userId } = useSession();
  return useResource((signal) => api.call(ACADEMY_COURSE_CONVERSATIONS, { limit: INBOX_PAGE }, { signal }), `course-inbox:${userId}`);
}

/**
 * `/academy/rooms/messages/:conversationId` on the reading template, signed in: one conversation with a course team and
 * the reply form under it. The Academy's sections are links above it.
 */
export function AcademyCourseConversationRoom({ conversationId }: { conversationId: string }) {
  return (
    <div data-room="academy-course-conversation">
      <ReadingTemplate
        title={copyText('moreroutes.academy')}
        description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
        state={{ kind: 'ready' }}
        meta={<AcademySections current="Rooms" />}
        body={<AcademyCourseConversation key={conversationId} conversationId={conversationId} />}
      />
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
    void api.call(ACADEMY_OPEN_COURSE_CONVERSATION, { conversationId, limit: ACADEMY_COURSE_MESSAGES_LIST_MAX }).then((opened) => {
      if (!live) return;
      if (opened.ok) setState({ kind: 'ready', data: opened.data });
      else setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'failed', failure: opened }));
    });
    return () => {
      live = false;
    };
  }, [api, conversationId, revision]);
  return (
    <div>
      <a className="lt-link" href={academyMessagesHref()}>
        {t('teamMessagesAll')}
      </a>
      {state.kind === 'loading' && <Waiting />}
      {state.kind === 'failed' && <AcademyRefusal failure={state.failure} retry={() => setRevision((n) => n + 1)} />}
      {state.kind === 'ready' && (
        <div data-course-conversation={state.data.id}>
          <Section title={<span lang="und">{state.data.courseTitle}</span>}>
            {state.data.earlier && <p data-earlier-messages>{t('teamMessagesEarlier', { count: ACADEMY_COURSE_MESSAGES_LIST_MAX })}</p>}
            <ol>
              {state.data.messages.map((message) => (
                <li key={message.id} data-course-message={message.id} data-from={message.from}>
                  <div>
                    <div data-testid="academy-lms-meta">
                      <strong>{message.from === 'learner' ? t('teamMessagesFromYou') : t('teamMessagesFromTeam')}</strong>
                      <span>{formatMoment(message.sentAt, language)}</span>
                    </div>
                    <p lang="und" className="lt-pre-wrap">
                      {message.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>
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
    <Section title={t('teamMessagesReplyLabel')}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(body, () => {
            setBody('');
            onSent();
          });
        }}
      >
        <TextAreaField
          id={`${id}-body`}
          label={t('teamMessagesReplyLabel')}
          value={body}
          rows={3}
          required
          onChange={(value) => {
            setBody(value);
            edited();
          }}
        />
        <Button tone="primary" type="submit" disabled={sending}>
          {t('teamMessagesReplySend')}
        </Button>
        {outcome?.kind === 'done' && <ServiceOffNote code="vendor.email" action={t('teamContactMailAction')} role="status" />}
        {outcome?.kind === 'uncertain' && (
          <p role="status" data-testid="failure" className="lt-refusal">
            {t('teamContactUncertain')}
          </p>
        )}
        {outcome?.kind === 'refused' && <Refused failure={outcome.failure} testId="course-team-reply-outcome" />}
      </form>
    </Section>
  );
}

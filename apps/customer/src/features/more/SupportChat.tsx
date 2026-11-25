// volt-room: /support/chat
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { SupportChatAvailability, SupportChatMessage, SupportChatSession } from '@intafaced/contracts/support-chat';
import { useDataEnv } from '../../data/hooks';
import { readContract, writeContract } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { ServiceOffNotice } from '../../shared/service-off';
import { Button } from '@intafaced/ui/lit';
import { ReadingTemplate, TextField } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { chatCopy } from './support-chat-copy';
import {
  chatAvailability,
  chatClose,
  chatContinueByEmail,
  chatOpen,
  chatPoll,
  chatRefusalCode,
  chatSend,
  keepChat,
  mergeMessages,
  newChatKey,
  readKeptChat,
  type KeptChat,
} from './support-chat';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type ChatT = ReturnType<typeof chatCopy.useCopy>['t'];

/** The plain sentence for a chat refusal; the code is shown as it is. */
function ChatRefusal({ refusal, t }: { refusal: Refusal; t: ChatT }) {
  const code = chatRefusalCode(refusal.message, refusal.code);
  const unset = /^support\.(chat_rate_limit|chat_identity_ttl|guest_address_key|guest_retention)_unset$/.test(code ?? '');
  const sentence =
    code === 'support.chat_rate_limited'
      ? t('rateLimited')
      : unset
        ? t('unset', { setting: code! })
        : code === 'support.chat_closed'
          ? t('closed')
          : code === 'support.chat_not_found'
            ? t('notFound')
            : code === 'support.chat_email_unproved'
              ? t('emailUnproved')
              : code === 'support.chat_message_conflict'
                ? t('conflict')
                : code === 'support.chat_prechat_invalid'
                  ? t('prechatInvalid')
                  : code === 'support.chat_agent_unavailable'
                    ? t('agentUnavailable')
                    : code === 'support.comment_secret_refused'
                      ? t('secretRefused')
                      : t('failed');
  return (
    <p role="alert" className="lt-refusal" data-testid="support-chat-refusal" data-code={code ?? undefined}>
      {sentence} {code ? <small lang="zxx">{code}</small> : null}
    </p>
  );
}

function Hours({ hours, t }: { hours: string | null; t: ChatT }) {
  return hours ? (
    <p className="lt-muted" data-testid="support-chat-hours">
      {t('hoursLabel')} <span lang="und">{hours}</span>
    </p>
  ) : (
    <p className="lt-muted" data-testid="support-chat-hours-unset">
      {t('hoursNotSet')}
    </p>
  );
}

/**
 * /support/chat (SP-chat-01): chat with a person, signed in or as a guest. With nobody on the desk it offers the request
 * form and the support hours instead. New messages are read every `pollMs`, which the page says. A closed chat is a request
 * holding the whole conversation, and the page links it.
 */
export function SupportChatRoom() {
  const { t } = chatCopy.useCopy();
  const { api } = useDataEnv();
  const { session: signedIn } = useSession();
  const [availability, setAvailability] = useState<SupportChatAvailability | 'loading' | 'unread'>('loading');
  const [kept, setKept] = useState<KeptChat | null>(() => readKeptChat());
  const [chat, setChat] = useState<SupportChatSession | null>(null);
  const [messages, setMessages] = useState<SupportChatMessage[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [emailNotice, setEmailNotice] = useState<'emailed' | 'not_connected' | null>(null);
  const [busy, setBusy] = useState<'start' | 'send' | 'end' | 'email' | null>(null);
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [draft, setDraft] = useState('');
  // A message keeps its key until it is stored, so sending again after a lost answer never stores it twice.
  const pending = useRef<{ body: string; key: string } | null>(null);
  // The same holds for opening: one key per form content, kept until the chat is open.
  const opening = useRef<{ content: string; key: string } | null>(null);
  // The cursor is read by the timer without restarting it.
  const lastSeq = useRef(0);
  useEffect(() => {
    lastSeq.current = messages.at(-1)?.seq ?? 0;
  }, [messages]);

  const loadAvailability = useCallback(
    (signal?: AbortSignal) =>
      readContract(api, chatAvailability, undefined, { signal })
        .then((answer) => {
          if (!signal?.aborted) setAvailability(answer.ok ? answer.data : 'unread');
        })
        .catch(() => {
          if (!signal?.aborted) setAvailability('unread');
        }),
    [api],
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadAvailability(controller.signal);
    return () => controller.abort();
  }, [loadAvailability]);

  // An open chat is read again from its last message every pollMs, until it is closed.
  const pollMs = availability !== 'loading' && availability !== 'unread' ? availability.pollMs : null;
  useEffect(() => {
    if (!kept || pollMs === null || chat?.status === 'closed') return;
    let stopped = false;
    const read = async () => {
      const answer = await writeContract(api, chatPoll, {
        sessionId: kept.sessionId,
        accessToken: kept.accessToken,
        after: lastSeq.current,
      });
      if (stopped) return;
      if (answer.ok) {
        setChat(answer.data.session);
        if (answer.data.messages.length) setMessages((held) => mergeMessages(held, answer.data.messages));
      } else if (chatRefusalCode(answer.message, answer.code) === 'support.chat_not_found') {
        keepChat(null);
        setKept(null);
      }
    };
    void read();
    const timer = setInterval(() => void read(), pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, kept, pollMs, chat?.status]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (availability === 'loading' || availability === 'unread') return;
    setBusy('start');
    setRefusal(null);
    const guestFields = signedIn ? {} : { name: form.name.trim() || undefined, email: form.email.trim() || undefined };
    const prechat = Object.fromEntries(
      Object.entries(guestFields).filter(([field, value]) => value && availability.prechatFields.includes(field as 'name' | 'email')),
    );
    const content = JSON.stringify([form.message.trim(), prechat]);
    if (!opening.current || opening.current.content !== content) opening.current = { content, key: newChatKey() };
    const clientKey = opening.current.key;
    const answer = await writeContract(api, chatOpen, {
      clientKey,
      message: form.message.trim(),
      ...(Object.keys(prechat).length ? { prechat } : {}),
    });
    setBusy(null);
    if (!answer.ok) {
      setRefusal(answer);
      if (chatRefusalCode(answer.message, answer.code) === 'support.chat_agent_unavailable') void loadAvailability();
      return;
    }
    opening.current = null;
    const next = { clientKey, sessionId: answer.data.session.id, accessToken: answer.data.accessToken };
    keepChat(next);
    setKept(next);
    setChat(answer.data.session);
    setMessages([answer.data.first]);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!kept || !draft.trim()) return;
    const body = draft.trim();
    if (!pending.current || pending.current.body !== body) pending.current = { body, key: newChatKey() };
    setBusy('send');
    setRefusal(null);
    const answer = await writeContract(api, chatSend, {
      sessionId: kept.sessionId,
      accessToken: kept.accessToken,
      clientMessageId: pending.current.key,
      body,
    });
    setBusy(null);
    if (!answer.ok) return setRefusal(answer);
    pending.current = null;
    setDraft('');
    setMessages((held) => mergeMessages(held, [answer.data]));
  };

  const end = async () => {
    if (!kept) return;
    setBusy('end');
    setRefusal(null);
    const answer = await writeContract(api, chatClose, { sessionId: kept.sessionId, accessToken: kept.accessToken });
    setBusy(null);
    if (!answer.ok) return setRefusal(answer);
    setChat(answer.data);
  };

  const continueByEmail = async () => {
    if (!kept) return;
    setBusy('email');
    setRefusal(null);
    const answer = await writeContract(api, chatContinueByEmail, { sessionId: kept.sessionId, accessToken: kept.accessToken });
    setBusy(null);
    if (!answer.ok) return setRefusal(answer);
    setChat(answer.data.session);
    setEmailNotice(answer.data.status);
  };

  const restart = () => {
    keepChat(null);
    setKept(null);
    setChat(null);
    setMessages([]);
    setEmailNotice(null);
    setRefusal(null);
    setForm({ name: '', email: '', message: '' });
    void loadAvailability();
  };

  const header = (
    <>
      <p className="lt-muted">{t('intro')}</p>
      {pollMs !== null && (
        <p className="lt-muted" data-testid="support-chat-poll">
          {t('pollNote', { seconds: Math.round(pollMs / 1000) })}
        </p>
      )}
    </>
  );

  // The room on its reading template: the title and the line under it, and the chat as the article.
  const frame = (body: ReactNode) => (
    <ReadingTemplate title={t('pageTitle')} description={t('pageDescription')} state={{ kind: 'ready' }} body={body} />
  );

  if (kept && chat) {
    const closed = chat.status === 'closed';
    return frame(
      <section className="lt-stack" data-testid="support-chat" data-chat-status={chat.status}>
        {header}
        {chat.claim === 'refused' && (
          <p role="status" className="lt-refusal" data-testid="support-chat-claim-refused">
            {t('claimRefused')}
          </p>
        )}
        {!closed && (
          <p role="status" data-testid="support-chat-state">
            {chat.waitingForAgent ? t('waiting') : t('joined')}
          </p>
        )}
        <ol className="lt-list" data-testid="support-chat-messages" aria-live="polite">
          {messages.map((m) => (
            <li key={m.seq} data-author={m.author} data-testid="support-chat-message">
              <strong>{m.author === 'agent' ? t('support') : t('you')}</strong> <span>{m.body}</span>
            </li>
          ))}
        </ol>
        {refusal && <ChatRefusal refusal={refusal} t={t} />}
        {emailNotice && !closed && (
          <div role="status" data-testid="support-chat-email-notice" data-email-status={emailNotice}>
            {emailNotice === 'emailed' ? (
              <>
                <h2>{t('emailedTitle')}</h2>
                <p className="lt-muted">{t('emailedBody')}</p>
              </>
            ) : (
              <ServiceOffNotice code="vendor.email" action={t('continueEmailAction')} />
            )}
            <p className="lt-muted">{t('continueEmailNote')}</p>
          </div>
        )}
        {closed ? (
          <div role="status" data-testid="support-chat-closed">
            <h2>{t('closedTitle')}</h2>
            <p className="lt-muted">{t('closedBody')}</p>
            {chat.ticketId && signedIn && chat.identity === 'account' && (
              <a className="lt-button lt-button-primary" href={`/support/tickets/${chat.ticketId}`}>
                {t('openRequest')}
              </a>
            )}
            <Button tone="secondary" onClick={restart}>
              {t('newChat')}
            </Button>
          </div>
        ) : (
          <>
            <form className="lt-stack" onSubmit={(e) => void send(e)}>
              <TextField
                label={t('composeLabel')}
                name="chat-message"
                value={draft}
                maxLength={2000}
                onChange={(value) => setDraft(value)}
              />
              <Button tone="primary" type="submit" disabled={busy !== null || !draft.trim()}>
                {busy === 'send' ? t('sending') : t('send')}
              </Button>
            </form>
            <div className="lt-actions">
              <Button tone="secondary" onClick={() => void continueByEmail()} disabled={busy !== null}>
                {t('continueEmail')}
              </Button>
              <Button tone="secondary" onClick={() => void end()} disabled={busy !== null}>
                {busy === 'end' ? t('ending') : t('end')}
              </Button>
            </div>
          </>
        )}
      </section>,
    );
  }

  return frame(
    <section className="lt-stack" data-testid="support-chat" data-chat-status="none">
      {header}
      {availability === 'loading' ? (
        <p className="lt-muted" role="status">
          {t('loading')}
        </p>
      ) : availability === 'unread' ? (
        <div role="alert" data-testid="support-chat-unread">
          <p>{t('unread')}</p>
          <Button tone="secondary" onClick={() => void loadAvailability()}>
            {t('retry')}
          </Button>
          <a className="lt-link" href="/support/new">
            {t('sendRequest')}
          </a>
        </div>
      ) : availability.agents === 'offline' ? (
        <div data-testid="support-chat-offline">
          <h2>{t('offlineTitle')}</h2>
          <p className="lt-muted">{t('offlineBody')}</p>
          <Hours hours={availability.hours} t={t} />
          <a className="lt-button lt-button-primary" href="/support/new" data-testid="support-chat-request-form">
            {t('sendRequest')}
          </a>
        </div>
      ) : (
        <form className="lt-stack" data-testid="support-chat-start" onSubmit={(e) => void start(e)}>
          <h2>{t('startTitle')}</h2>
          {availability.agents === 'busy' && (
            <p className="lt-muted" role="status" data-testid="support-chat-busy">
              {t('busyNote')}
            </p>
          )}
          <Hours hours={availability.hours} t={t} />
          {!signedIn && availability.prechatFields.includes('name') && (
            <TextField
              label={t('nameLabel')}
              name="chat-name"
              required
              maxLength={120}
              value={form.name}
              onChange={(value) => setForm({ ...form, name: value })}
            />
          )}
          {!signedIn && availability.prechatFields.includes('email') && (
            <TextField
              label={t('emailLabel')}
              hint={t('emailHint')}
              name="chat-email"
              type="email"
              required
              maxLength={254}
              value={form.email}
              onChange={(value) => setForm({ ...form, email: value })}
            />
          )}
          <TextField
            label={t('messageLabel')}
            hint={t('messageHint')}
            name="chat-first-message"
            required
            maxLength={2000}
            value={form.message}
            onChange={(value) => setForm({ ...form, message: value })}
          />
          {refusal && <ChatRefusal refusal={refusal} t={t} />}
          <Button tone="primary" type="submit" disabled={busy !== null || !form.message.trim()}>
            {busy === 'start' ? t('starting') : t('start')}
          </Button>
        </form>
      )}
    </section>,
  );
}

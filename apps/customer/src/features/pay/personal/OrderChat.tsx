import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, StateBlock } from '@intafaced/ui';
import { uiCopy } from '../../../shared/ui-copy';
import { PaySection } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { Trade } from '../schemas';
import { p2pChatCopy } from './p2p-chat-copy';
import { p2pDepth } from './p2p-depth-copy';
import { TradeStatus } from './P2PDepth';
import { TraderName, useTraders } from './Trader';
import { ChatStore, MAX_CHAT_TEXT, chatTime, senderRole, type ChatState, type PendingMessage, type ServiceFailure } from './p2p-chat-model';

type ChatT = ReturnType<typeof p2pChatCopy.useCopy>['t'];

/** The plain sentence for a kind of refusal. No service text and no code ever reaches the customer. */
export function failureText(t: ChatT, kind: ServiceFailure): string {
  switch (kind) {
    case 'signIn':
      return t('failSignIn');
    case 'notParty':
      return t('failNotParty');
    case 'readOnly':
      return t('failReadOnly');
    case 'verify':
      return t('failVerify');
    case 'region':
      return t('failRegion');
    case 'textRequired':
      return t('failTextRequired');
    case 'attachment':
      return t('failAttachment');
    case 'self':
      return t('failSelf');
    case 'conflict':
      return t('failConflict');
    case 'inProgress':
      return t('failInProgress');
    case 'unconfirmed':
      return t('failUnconfirmed');
    case 'noService':
      return t('failNoService');
    case 'viewChanged':
      return t('failViewChanged');
    case 'generic':
      return t('failGeneric');
  }
}

/** A refusal in words, with the way forward when there is one (verification is a page of its own). */
export function FailureText({ kind }: { kind: ServiceFailure }) {
  const { t } = p2pChatCopy.useCopy();
  return (
    <>
      {failureText(t, kind)}
      {kind === 'verify' ? (
        <>
          {' '}
          <a className="text-link" href="/verification">
            {t('failVerifyLink')}
          </a>
        </>
      ) : null}
    </>
  );
}

/** Sending the same words again cannot help after these; the person edits or drops the message instead. */
const NOT_RETRIABLE: ReadonlySet<ServiceFailure> = new Set(['notParty', 'textRequired', 'attachment', 'region', 'verify', 'self']);

function PendingItem({
  item,
  onResend,
  onEdit,
  onDiscard,
}: {
  item: PendingMessage;
  onResend: (clientId: string) => void;
  onEdit: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const { t } = p2pChatCopy.useCopy();
  const unconfirmed = item.status === 'unconfirmed';
  const retriable = item.failure === null || !NOT_RETRIABLE.has(item.failure);
  return (
    <li className="p2p-chat-item">
      <div className="p2p-chat-msg" data-own="true" data-status={item.status} data-testid="chat-pending">
        <div className="p2p-chat-meta">
          <strong>{t('roleYou')}</strong>
          <span className="muted">{item.status === 'sending' ? t('sending') : unconfirmed ? t('unconfirmedTitle') : t('failedTitle')}</span>
        </div>
        <p className="p2p-chat-text" lang="und">
          {item.text}
        </p>
        {item.status !== 'sending' ? (
          <div className="p2p-chat-problem" role="alert">
            <p>
              {unconfirmed && (item.failure === null || item.failure === 'unconfirmed' || item.failure === 'noService') ? (
                t('unconfirmedBody')
              ) : item.failure ? (
                <FailureText kind={item.failure} />
              ) : null}
            </p>
            <div className="actions">
              {retriable ? (
                <Button variant="secondary" size={32} onClick={() => onResend(item.clientId)}>
                  {unconfirmed ? t('checkAndSend') : t('sendAgain')}
                </Button>
              ) : null}
              <Button variant="ghost" size={32} onClick={() => onEdit(item.clientId)}>
                {t('edit')}
              </Button>
              <Button variant="ghost" size={32} onClick={() => onDiscard(item.clientId)}>
                {t('discard')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The conversation exactly as the store holds it. Pure of timers and requests, so it renders the same on any path. */
export function ChatView({
  state,
  trade,
  viewer,
  now,
  counterparty,
  draft,
  onDraft,
  onQuick,
  onSend,
  onRefresh,
  onResend,
  onEdit,
  onDiscard,
}: {
  state: ChatState;
  trade: Pick<Trade, 'buyerId' | 'sellerId' | 'status'>;
  viewer: string | null;
  now: number;
  /** The other side's name: a handle or a plain word, never an account id. */
  counterparty: ReactNode;
  draft: string;
  onDraft: (value: string) => void;
  /** Put a ready-made sentence in the box. Nothing is sent until the person sends it. */
  onQuick: (text: string) => void;
  onSend: () => void;
  onRefresh: () => void;
  onResend: (clientId: string) => void;
  onEdit: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const { t, requestedLocale, languageFor, directionFor } = p2pChatCopy.useCopy();
  const depth = p2pDepth.useCopy();
  const ui = uiCopy.useCopy();
  const hintId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const count = state.messages.length + state.pending.length;
  const own = state.pending.length;
  useLayoutEffect(() => {
    const node = thread.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [count]);
  // A message the person just sent always brings the thread to the bottom.
  useLayoutEffect(() => {
    const node = thread.current;
    if (node && own > 0) node.scrollTop = node.scrollHeight;
  }, [own]);
  const ready = state.phase === 'ready';
  const empty = draft.trim().length === 0;
  const me = viewer === trade.buyerId ? 'buyer' : viewer === trade.sellerId ? 'seller' : null;
  const closed = trade.status === 'released' || trade.status === 'cancelled';
  const quick = me === 'buyer' ? [t('quickPaid'), t('quickRelease')] : me === 'seller' ? [t('quickReceived'), t('quickProof')] : [];
  const hint = state.phase === 'loading' ? t('loading') : state.phase === 'failed' ? t('composeOffLoad') : t('composeHint');
  return (
    <div className="p2p-chat" data-testid="order-chat" lang={languageFor('title')} dir={directionFor('title')}>
      <div className="p2p-chat-head" data-testid="chat-head">
        <strong>{counterparty}</strong>
        {me ? <span className="muted">{me === 'buyer' ? t('roleSeller') : t('roleBuyer')}</span> : null}
        <TradeStatus status={trade.status} />
      </div>
      <p className="muted">{t('intro')}</p>
      {me === 'seller' && (trade.status === 'escrowed' || trade.status === 'fiat_sent') ? (
        <p className="p2p-chat-warning" role="note" data-testid="chat-seller-warning">
          {t('sellerWarning')}
        </p>
      ) : null}
      {state.unreadBelow ? (
        <p className="p2p-chat-new" role="status" data-testid="chat-unread-below">
          {t('unreadBelow', { count: state.unreadBelow })}
        </p>
      ) : null}
      {state.phase === 'loading' ? <StateBlock kind="loading" label={ui.t('loading')} /> : null}
      {state.phase === 'failed' ? (
        <div className="p2p-chat-problem" role="alert" data-testid="chat-load-failed">
          <h3>{t('loadFailedTitle')}</h3>
          <p>
            <FailureText kind={state.loadFailure ?? 'generic'} />
          </p>
          <Button variant="secondary" onClick={onRefresh}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {ready ? (
        <div
          className="p2p-chat-thread"
          ref={thread}
          role="log"
          tabIndex={0}
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('threadLabel')}
          onScroll={(event) => {
            const node = event.currentTarget;
            stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
        >
          {count === 0 ? (
            <p className="muted" data-testid="chat-empty">
              {depth.t('chatEmpty')} {t('emptyHint')}
            </p>
          ) : (
            <ol className="p2p-chat-list">
              {state.messages.map((message) => {
                const role = senderRole(message.senderId, trade, viewer);
                return (
                  <li key={message.id} className="p2p-chat-item">
                    {message.id === state.firstUnread && state.unreadAtOpen > 0 ? (
                      <p className="p2p-chat-new" data-testid="chat-new-divider">
                        {t('newDivider', { count: state.unreadAtOpen })}
                      </p>
                    ) : null}
                    <div className="p2p-chat-msg" data-own={role === 'you'} data-role={role} data-testid="chat-message">
                      <div className="p2p-chat-meta">
                        <strong>
                          {role === 'you'
                            ? t('roleYou')
                            : role === 'buyer'
                              ? t('roleBuyer')
                              : role === 'seller'
                                ? t('roleSeller')
                                : t('roleModerator')}
                        </strong>
                        <time className="muted" dateTime={message.createdAt} title={message.createdAt} lang={requestedLocale}>
                          {chatTime(message.createdAt, requestedLocale, now)}
                        </time>
                      </div>
                      <p className="p2p-chat-text" lang="und">
                        {message.text}
                      </p>
                    </div>
                  </li>
                );
              })}
              {state.pending.map((item) => (
                <PendingItem key={item.clientId} item={item} onResend={onResend} onEdit={onEdit} onDiscard={onDiscard} />
              ))}
            </ol>
          )}
        </div>
      ) : null}
      {ready && state.refreshFailure ? (
        <p className="p2p-chat-problem" role="status" data-testid="chat-refresh-failed">
          {t('refreshFailed')} <FailureText kind={state.refreshFailure} />{' '}
          <Button variant="ghost" size={32} onClick={onRefresh}>
            {t('checkNow')}
          </Button>
        </p>
      ) : null}
      {state.lastNotified === false ? (
        <p className="muted" role="status" data-testid="chat-not-notified">
          {t('notifiedOff')}
        </p>
      ) : null}
      {closed ? (
        <p className="muted" data-testid="chat-closed">
          {trade.status === 'cancelled' ? t('closedCancelledNote') : t('closedReleasedNote')}
        </p>
      ) : null}
      {!closed && quick.length > 0 && ready ? (
        <div className="p2p-chat-quick" role="group" aria-label={t('quickLabel')} data-testid="chat-quick">
          {quick.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => {
                onQuick(text);
                box.current?.focus();
              }}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="p2p-chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !empty) onSend();
        }}
      >
        <label className="field p2p-chat-field">
          <span>{depth.t('chatLabel')}</span>
          <textarea
            ref={box}
            value={draft}
            rows={2}
            maxLength={MAX_CHAT_TEXT}
            placeholder={depth.t('chatPlaceholder')}
            aria-describedby={hintId}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends and Shift+Enter starts a new line. A key that confirms an input method's text is left alone.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && ready && !empty) {
                event.preventDefault();
                onSend();
              }
            }}
          />
        </label>
        <Button type="submit" variant="primary" disabled={!ready || empty} aria-describedby={hintId}>
          {depth.t('chatSend')}
        </Button>
      </form>
      <p className="muted p2p-chat-hint" id={hintId}>
        {hint} <span>{t('charCount', { used: draft.length, max: MAX_CHAT_TEXT })}</span>
      </p>
      <div className="p2p-chat-notes">
        <p className="muted">{t('liveNote')}</p>
        <p className="muted">{t('attachmentsOff')}</p>
        <p className="muted">{t('systemOff', { path: depth.t('escrowTitle') })}</p>
      </div>
      <div className="actions">
        <Button variant="ghost" onClick={onRefresh}>
          {t('refresh')}
        </Button>
      </div>
    </div>
  );
}

const newClientId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** The order conversation, read from and written to svc-p2p. Reading pauses while the page is hidden. */
export function OrderChat({ pay, trade, userId }: { pay: PersonalPayApi; trade: Trade; userId: string | null }) {
  const { t } = p2pChatCopy.useCopy();
  const closed = useRef(false);
  closed.current = trade.status === 'released' || trade.status === 'cancelled';
  // Reading the thread marks it read, so it is read only while it is on screen. Without a way to tell, it counts as seen.
  const inView = useRef(typeof IntersectionObserver === 'undefined');
  const frame = useRef<HTMLDivElement>(null);
  const store = useMemo(
    () =>
      new ChatStore({
        list: (page, signal) => pay.chatMessages(trade.id, page, signal),
        send: (text, clientId) => pay.chatSend(trade.id, text, clientId),
        unread: (signal) => pay.chatUnread(trade.id, signal),
        viewer: userId,
        newId: newClientId,
        closed: () => closed.current,
        visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
        inView: () => inView.current,
      }),
    [pay, trade.id, userId],
  );
  useEffect(() => {
    const onVisibility = () => store.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined' && frame.current) {
      observer = new IntersectionObserver(
        (entries) => {
          const seen = entries.some((entry) => entry.isIntersecting);
          if (seen === inView.current) return;
          inView.current = seen;
          store.visibilityChanged();
        },
        { threshold: 0.1 },
      );
      observer.observe(frame.current);
    }
    store.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      store.stop();
    };
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [draft, setDraft] = useState('');
  // The draft is also kept in a ref so a second press of Send in the same instant sees it already taken.
  const taken = useRef('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const otherId = trade.buyerId === userId ? trade.sellerId : trade.buyerId;
  const traders = useTraders(pay, [otherId]);
  const setBox = (value: string) => {
    taken.current = value;
    setDraft(value);
  };
  return (
    <div ref={frame}>
      <PaySection title={t('title')}>
        <ChatView
          state={state}
          trade={trade}
          viewer={userId}
          now={now}
          counterparty={<TraderName record={traders[otherId.toLowerCase()] ?? null} />}
          draft={draft}
          onDraft={setBox}
          onQuick={(text) => setBox(draft.trim() ? `${draft.trimEnd()} ${text}` : text)}
          onSend={() => {
            const text = taken.current || draft;
            if (!text.trim()) return;
            setBox('');
            void store.send(text);
          }}
          onRefresh={() => void store.refresh()}
          onResend={(clientId) => void store.resend(clientId)}
          onEdit={(clientId) =>
            void store.take(clientId).then((outcome) => {
              if (outcome.status === 'text') setBox(draft ? `${outcome.text}\n${draft}` : outcome.text);
            })
          }
          onDiscard={(clientId) => void store.take(clientId)}
        />
      </PaySection>
    </div>
  );
}

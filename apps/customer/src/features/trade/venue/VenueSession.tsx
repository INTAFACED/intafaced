import { useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { createTradingSessionApi, heldKey, joinLiveSession, keyFor, usePolled, useWallet, type HeldKey } from '../../protocol';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../session';
import { venueCopy } from './venue-copy';
import { VENUE_POLL_MS } from './poll';
import { useVenueApi } from './venue-words';
import { sessionLine, startSession, type SessionSigning, type SessionStartResult } from './session-signer';
import { preparedAnswerSchema, walletTypedData, type VenueUp } from '../venue-api';

/**
 * The trading session on the desk (session-signer.ts): on a venue whose orders a session key signs, this sign-in's
 * session for the connected wallet, read every VENUE_POLL_MS from svc-trade's record (which reads the venue's own list of
 * agents), and the key this tab holds for it. `signing` is what `useVenueActions` signs with; nothing here signs an order.
 */
export function useDeskSession(owner: string | null, status: VenueUp) {
  const { api, userId } = useSession();
  const tradesSignedBy = status.tradesSignedBy ?? 'owner_wallet';
  const on = tradesSignedBy === 'session_key' && owner !== null && userId !== null;
  const sessions = useMemo(() => createTradingSessionApi(api), [api]);
  // The key this tab holds for the person, re-read from the tab's storage whenever this desk starts or ends a session.
  const [held, setHeld] = useState<HeldKey | null>(() => (userId ? heldKey(userId) : null));
  // Each read of the session: when it is live under a key another of the person's tabs holds, this tab takes that key
  // too (the venue keeps one per account), so no tab needs its own approval.
  const read = usePolled(
    async (signal) => {
      if (!on || !owner) return null;
      const answer = await sessions.session(owner, signal);
      if (answer.ok && userId) {
        const joined = await joinLiveSession(userId, answer.data.current, heldKey(userId));
        if (joined && !signal.aborted) setHeld(joined);
      }
      return answer;
    },
    `venue-session:${userId ?? ''}:${owner ?? ''}:${on ? 'on' : 'off'}`,
    VENUE_POLL_MS,
  );
  const current = read.data?.current ?? null;
  const live = on && read.data && keyFor(current, held) === 'use' ? held : null;
  const signing: SessionSigning = useMemo(() => ({ tradesSignedBy, live }), [tradesSignedBy, live]);
  return { on, read: read.data !== null, failure: read.failure, current, held, setHeld, reload: read.reload, signing, sessions, userId };
}
export type DeskSession = ReturnType<typeof useDeskSession>;

/** The one panel: why the session is needed, its state in words, and Start or End. Nothing on a venue the wallet signs. */
export function VenueSessionPanel({ session, owner, status }: { session: DeskSession; owner: string; status: VenueUp }) {
  const { t } = venueCopy.useCopy();
  const { timeZone } = usePreferences();
  const wallet = useWallet();
  const venue = useVenueApi();
  const [said, setSaid] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  const [busy, setBusy] = useState<'start' | 'end' | null>(null);
  const inFlight = useRef(false);
  if (!session.on || !session.userId) return null;
  const userId = session.userId;
  const line = session.read ? sessionLine(session.current, session.held) : null;

  const until = (iso: string | null) => {
    if (!iso) return t('Session line live open');
    try {
      const time = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
      return t('Session line live', { time });
    } catch {
      return t('Session line live', { time: iso });
    }
  };
  const lineText = (): string | null => {
    if (!line) return null;
    switch (line.line) {
      case 'live':
        return until(line.validUntil);
      case 'refused': {
        const detail = session.current?.refusal?.detail;
        return detail ? t('Session line refused', { detail }) : t('Session refused no detail');
      }
      default:
        return t(`Session line ${line.line}`);
    }
  };

  async function once(kind: 'start' | 'end', work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setSaid(null);
    try {
      await work();
    } catch {
      setSaid({ tone: 'alert', text: t('Session start failed') });
    } finally {
      inFlight.current = false;
      setBusy(null);
      session.reload();
    }
  }

  const start = () =>
    once('start', async () => {
      const result = await startSession({
        sessions: session.sessions,
        submit: venue.submit,
        sign: (typedData) => wallet.sign({ kind: 'typedData', typedData }),
        userId,
        owner,
        current: session.current,
        held: session.held,
        hold: session.setHeld,
        forget: () => session.setHeld(null),
      });
      setSaid(startWords(result, t));
    });

  const end = () =>
    once('end', async () => {
      const ending = await session.sessions.end(owner);
      if (!ending.ok) return setSaid({ tone: 'alert', text: t('Session start refused', { detail: ending.message }) });
      const parsed = preparedAnswerSchema.safeParse(ending.data);
      if (!parsed.success) return setSaid({ tone: 'alert', text: t('Session start failed') });
      const p = parsed.data.prepared;
      let signature = { digest: p.digest, signature: '0x', signedBy: owner };
      if (!parsed.data.signed) {
        const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
        if (signed.status === 'rejected') return;
        if (signed.status !== 'signed')
          return setSaid({ tone: 'alert', text: t('Session wallet failed', { detail: signed.status === 'failed' ? signed.message : '' }) });
        signature = { digest: p.digest, signature: signed.signature, signedBy: owner };
      }
      const sent = await venue.submit(parsed.data.actionKey, signature);
      if (!sent.ok && sent.reason !== 'uncertain') setSaid({ tone: 'alert', text: t('Session start refused', { detail: sent.message }) });
    });

  return (
    <section className="lt-stack" aria-label={t('Session title')} data-testid="venue-session">
      <h2>{t('Session title')}</h2>
      <p className="lt-hint">{t('Session why', { venue: status.venue.displayName })}</p>
      {line ? (
        <p role="status" data-testid="venue-session-line" data-session={line.line}>
          {lineText()}
        </p>
      ) : null}
      {said?.tone === 'alert' ? (
        <p role="alert" className="lt-refusal" data-testid="venue-session-said">
          {said.text}
        </p>
      ) : said ? (
        <p role="status" data-testid="venue-session-said">
          {said.text}
        </p>
      ) : null}
      {line ? (
        <div className="lt-actions">
          {line.offer === 'start' ? (
            <Button tone="primary" disabled={busy !== null} onClick={() => void start()} data-testid="venue-session-start">
              {busy === 'start' ? t('Session starting') : t('Session start')}
            </Button>
          ) : (
            <Button tone="secondary" disabled={busy !== null} onClick={() => void end()} data-testid="venue-session-end">
              {busy === 'end' ? t('Session ending') : t('Session end')}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The words for a start's result. A start that reached the venue says nothing more: the re-read line says the state. */
function startWords(
  result: SessionStartResult,
  t: ReturnType<typeof venueCopy.useCopy>['t'],
): { tone: 'status' | 'alert'; text: string } | null {
  switch (result.kind) {
    case 'joined':
      return null;
    case 'sent':
      if (result.answer === 'accepted') return null;
      if (result.answer === 'unknown') return { tone: 'status', text: t('Session unknown') };
      return { tone: 'alert', text: result.detail ? t('Session line refused', { detail: result.detail }) : t('Session refused no detail') };
    case 'refused':
      return { tone: 'alert', text: result.message ? t('Session start refused', { detail: result.message }) : t('Session start failed') };
    case 'rejected':
      return { tone: 'status', text: t('Session rejected') };
    case 'wallet_failed':
      return { tone: 'alert', text: t('Session wallet failed', { detail: result.message }) };
  }
}

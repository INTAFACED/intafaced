import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '../../../shared/preferences';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import { draftId, keys, type VenueUp } from '../../../features/trade/venue-api';
import { useVenueApi, VENUE_POLL_MS, type ActionResult, type RunAction } from '../../../features/trade/venue/VenueKit';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from './deps';
import { deadManChoices, otherSeconds } from './dead-man';
import { clockSeconds } from './time';
import { spotVenueCopy } from './venue-copy';

type T = ReturnType<typeof spotVenueCopy.useCopy>['t'];
type Note = { tone: 'good' | 'bad'; text: string } | null;

/**
 * The dead-man switch on the launch model (J-cex-spot-07 #1 to #4): the venue's own scheduled cancel. The person picks one
 * of the owner's published timeouts (or types another, which svc-trade refuses in words before the wallet is asked) and
 * signs it; the venue then cancels every open order of the venue account at the time it records, unless a later
 * signature moves that time on ("Refresh now") or removes it ("Turn off", timeout 0). The time shown is always the
 * venue's own record, read back after every change. A venue with no scheduled cancel says so: not offered.
 */
export function VenueDeadMan({
  status,
  owner,
  run,
  onFired,
}: {
  status: VenueUp;
  owner: string | null;
  run: RunAction;
  /** Called when the venue's record shows it fired: the open orders it cancelled are read again. */
  onFired: () => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  const { timeZone } = usePreferences();
  const venue = useVenueApi();
  const offered = status.scheduledCancel ?? null;
  const choices = deadManChoices(offered?.timeoutsSec);
  const read = usePolled(
    (signal) => (owner && offered ? venue.scheduledCancel(owner, signal) : Promise.resolve(null)),
    `scheduled-cancel:${owner ?? ''}:${offered ? 'on' : 'off'}`,
    VENUE_POLL_MS,
  );
  const record = read.data?.value ?? null;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<number | 'other' | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [note, setNote] = useState<Note>(null);
  // A press whose answer was not definite keeps its key: pressed again, it is read back, never signed twice.
  const draft = useRef<string | null>(null);
  // The venue's last firing this page has already shown.
  const seenFiring = useRef<string | null | undefined>(undefined);

  const fired = record?.lastFired ?? null;
  useEffect(() => {
    if (!read.data) return;
    const at = fired?.firedAt ?? null;
    if (seenFiring.current === undefined) {
      seenFiring.current = at;
      return;
    }
    if (at !== null && at !== seenFiring.current) {
      seenFiring.current = at;
      setNote({ tone: 'good', text: t('Dead man fired', { count: fired!.canceled, time: clockSeconds(Date.parse(at), timeZone) }) });
      onFired();
    }
  }, [read.data, fired, onFired, t, timeZone]);

  const cancelsAt = record?.cancelsAt ? Date.parse(record.cancelsAt) : null;
  const label = !offered
    ? t('Dead man not offered label')
    : !owner || (!read.data && !read.failure)
      ? t('Dead man checking')
      : !read.data
        ? t('Dead man unknown')
        : cancelsAt !== null
          ? t('Dead man on', { time: clockSeconds(cancelsAt, timeZone) })
          : t('Dead man off');
  const picked = choice === 'other' ? otherSeconds(other) : (choice ?? choices[0] ?? null);

  async function send(timeoutSec: number) {
    if (!owner || sending.current) return;
    sending.current = true;
    setBusy(true);
    draft.current ??= draftId();
    const answer = await run({ kind: 'schedule_cancel', timeoutSec, time: null }, { actionKey: keys.scheduleCancel(owner, draft.current) });
    if (answer.kind === 'outcome' || answer.kind === 'refused' || answer.kind === 'rejected') draft.current = null;
    let text = problem(t, answer, choices);
    if (text === null) {
      // The time shown is the venue's own record, read back now.
      const now = await venue.scheduledCancel(owner);
      read.reload();
      const at = now.ok ? now.data.value.cancelsAt : null;
      text =
        timeoutSec === 0
          ? t('Dead man disarmed')
          : at
            ? t('Dead man armed', { time: clockSeconds(Date.parse(at), timeZone) })
            : t('Dead man unknown answer');
      setNote({ tone: timeoutSec === 0 || at ? 'good' : 'bad', text });
    } else setNote({ tone: 'bad', text });
    sending.current = false;
    setBusy(false);
  }

  function close() {
    if (sending.current) return;
    setOpen(false);
    setNote(null);
  }

  const armed = cancelsAt !== null;
  return (
    <>
      <button type="button" className="dk-cancel-all" aria-haspopup="dialog" data-testid="venue-dead-man" onClick={() => setOpen(true)}>
        {label}
      </button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        {open ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Dead man title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Dead man intro', { venue: status.venue.displayName })}</AlertDialogDescription>
            </AlertDialogHeader>
            {!offered ? (
              <p className="dk-note dk-note--bad" role="status" data-testid="venue-dead-man-not-offered">
                {t('Dead man not offered', { venue: status.venue.displayName })}
              </p>
            ) : choices.length === 0 ? (
              <p className="dk-note dk-note--bad" role="status">
                {t('Dead man not published')}
              </p>
            ) : (
              <fieldset className="dk-scopes" aria-label={t('Dead man after')}>
                {choices.map((s) => (
                  <label key={s} className="dk-scope">
                    <input type="radio" name="venue-dead-man" checked={picked === s && choice !== 'other'} onChange={() => setChoice(s)} />
                    <span>{t('Dead man seconds', { count: s })}</span>
                  </label>
                ))}
                <label className="dk-scope">
                  <input type="radio" name="venue-dead-man" checked={choice === 'other'} onChange={() => setChoice('other')} />
                  <span>{t('Dead man other')}</span>
                </label>
                {choice === 'other' ? (
                  <input
                    className="dk-deadman-other"
                    inputMode="numeric"
                    aria-label={t('Dead man other seconds')}
                    value={other}
                    onChange={(event) => setOther(event.target.value)}
                  />
                ) : null}
              </fieldset>
            )}
            {armed && !note ? (
              <p className="dk-note" role="status">
                {t('Dead man armed', { time: clockSeconds(cancelsAt, timeZone) })}
              </p>
            ) : null}
            {note ? (
              <p
                className={note.tone === 'good' ? 'dk-note dk-note--good' : 'dk-note dk-note--bad'}
                role={note.tone === 'good' ? 'status' : 'alert'}
              >
                {note.text}
              </p>
            ) : null}
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={busy} onClick={close}>
                {t('Dead man close')}
              </Button>
              {offered && armed ? (
                <Button variant="secondary" size={40} loading={busy} onClick={() => void send(0)}>
                  {t('Dead man disarm')}
                </Button>
              ) : null}
              {offered && choices.length > 0 ? (
                <Button
                  variant="primary"
                  shape="pill"
                  size={40}
                  loading={busy}
                  disabled={picked === null || !owner}
                  onClick={() => picked !== null && void send(picked)}
                >
                  {armed ? t('Dead man refresh') : t('Dead man arm')}
                </Button>
              ) : null}
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}

/** The words for an answer that changed nothing, or null when the venue took it. */
function problem(t: T, answer: ActionResult, choices: readonly number[]): string | null {
  switch (answer.kind) {
    case 'outcome':
      return answer.outcome.accepted ? null : t('Dead man refused', { detail: answer.outcome.refusal.detail });
    case 'refused':
      return answer.code === 'trade.cancel_all_after_rejected'
        ? t('Dead man refused timeout', { list: choices.join(', ') })
        : answer.code === 'trade.cancel_all_after_unset'
          ? t('Dead man not published')
          : t('Dead man refused', { detail: answer.message });
    case 'rejected':
      return t('Dead man rejected');
    case 'wallet_failed':
      return t('Dead man refused', { detail: answer.message });
    case 'unknown':
    case 'waiting':
      return t('Dead man unknown answer');
  }
}

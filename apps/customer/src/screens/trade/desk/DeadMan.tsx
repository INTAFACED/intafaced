import { useCallback, useEffect, useRef, useState } from 'react';
import type { CancelAllAfter } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { deadManChoices, deadManRefusal, otherSeconds, refreshEveryMs } from './dead-man';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  refusalCopy,
} from './deps';
import { clockSeconds } from './time';

type Note = { tone: 'good' | 'bad'; text: string };

/** After the deadline, how often and how many times the desk reads the switch while the sweep has not run yet. */
const SWEEP_CHECK_MS = 2000;
const SWEEP_CHECKS = 15;

/**
 * The dead-man switch (cancel-all-after). The person picks one of the published timeouts (or types another, which the
 * service refuses in words), turns it on and sees the time it fires; refreshing pushes that time out, and "off" sends 0.
 * While "keep refreshing" is ticked this page pushes it out on its own, so it only fires once the page goes quiet.
 * Every open order in every market is cancelled when it fires; the service never touches another person's orders.
 */
export function DeadMan({ onChanged }: { onChanged: () => void }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const api = useDeskApi();
  const [state, setState] = useState<CancelAllAfter | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<number | 'other' | null>(null);
  const [other, setOther] = useState('');
  const [keepAlive, setKeepAlive] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // A keep-alive refresh on its way. It never blocks the person: their action waits for it, then goes, so a late
  // refresh can never re-arm a switch they just turned off.
  const quietRef = useRef<Promise<unknown> | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    const result = await api.cancelAllAfter();
    if (result.ok) {
      setState(result.data);
      setUnreadable(false);
    } else setUnreadable(true);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const choices = deadManChoices(state?.timeouts);
  const armedTimeout = state?.armed ? state.timeout : 0;
  const picked = choice === 'other' ? otherSeconds(other) : (choice ?? (armedTimeout || choices[0] || null));

  const send = useCallback(
    async (timeout: number, quiet = false): Promise<boolean> => {
      if (quiet) {
        // A person's action wins over a refresh, and one refresh is on its way at a time.
        if (busyRef.current || quietRef.current) return false;
        const pending = api.armCancelAllAfter(timeout);
        quietRef.current = pending;
        const answer = await pending;
        quietRef.current = null;
        if (busyRef.current || !answer.ok) return false;
        setState((prev) => ({ ...answer.data, timeouts: answer.data.timeouts ?? prev?.timeouts ?? null }));
        onChanged();
        return true;
      }
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      if (quietRef.current) await quietRef.current.catch(() => undefined);
      const result = await api.armCancelAllAfter(timeout);
      busyRef.current = false;
      setBusy(false);
      if (result.ok) {
        setState((prev) => ({ ...result.data, timeouts: result.data.timeouts ?? prev?.timeouts ?? null }));
        setNote({ tone: 'good', text: timeout === 0 ? t('Dead man disarmed') : t('Dead man armed', { time: at(result.data) }) });
        onChanged();
        return true;
      }
      const kind = deadManRefusal(result.code, timeout, state?.timeouts);
      const text =
        kind === 'timeout'
          ? t('Dead man refused timeout', { list: choices.join(', ') })
          : kind === 'session'
            ? t('Dead man refused session')
            : kind === 'unset'
              ? t('Dead man refused unset')
              : t('Dead man refused other', { reason: result.code ? refusalCopy(result.code).title : result.message });
      setNote({ tone: 'bad', text });
      return false;
    },
    // `at` reads the zone; `choices` and `state` are read for the refusal words only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, onChanged, state?.timeouts, timeZone],
  );

  // Keep refreshing: push the deadline out while this page is open and the switch is on.
  useEffect(() => {
    if (!keepAlive || armedTimeout === 0) return;
    const id = setInterval(() => void send(armedTimeout, true), refreshEveryMs(armedTimeout));
    return () => clearInterval(id);
  }, [keepAlive, armedTimeout, send]);

  // A deadline that has passed fires on the service's next sweep: read the switch after the deadline, and again every
  // couple of seconds while it still reads armed for that same deadline, then show what the sweep cancelled.
  const trigger = state?.armed && state.triggerTime ? Date.parse(state.triggerTime) : null;
  useEffect(() => {
    if (trigger === null) return;
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const result = await api.cancelAllAfter();
      if (stopped) return;
      tries += 1;
      if (result.ok) {
        setState(result.data);
        setUnreadable(false);
        if (!result.data.armed || tries === 1) onChanged();
        if (!result.data.armed) return;
      }
      if (tries < SWEEP_CHECKS) timer = setTimeout(() => void check(), SWEEP_CHECK_MS);
    };
    timer = setTimeout(() => void check(), Math.max(0, trigger - Date.now()) + 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [trigger, api, onChanged]);

  function at(s: CancelAllAfter): string {
    return s.triggerTime ? clockSeconds(Date.parse(s.triggerTime), timeZone) : '';
  }
  const passed = trigger !== null && trigger <= Date.now();
  // Never "off" before the switch has been read: an unread switch may be on.
  const label =
    state === null
      ? unreadable
        ? t('Dead man unknown')
        : t('Dead man checking')
      : state.armed
        ? t('Dead man on', { time: at(state) })
        : t('Dead man off');

  function close() {
    if (busyRef.current) return;
    setOpen(false);
    setNote(null);
  }

  return (
    <>
      <button type="button" className="dk-cancel-all" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {label}
      </button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        {open ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Dead man title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Dead man intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            {state === null ? (
              <p className="dk-note" role={unreadable ? 'alert' : 'status'}>
                {unreadable ? t('Dead man unreadable') : t('Dead man loading')}
              </p>
            ) : choices.length === 0 ? (
              <p data-testid="dk-note--bad" className="dk-note dk-note--bad" role="status">
                {t('Dead man not published')}
              </p>
            ) : (
              <fieldset className="dk-scopes" aria-label={t('Dead man after')}>
                {choices.map((s) => (
                  <label key={s} className="dk-scope">
                    <input type="radio" name="dead-man" checked={picked === s && choice !== 'other'} onChange={() => setChoice(s)} />
                    <span>{t('Dead man seconds', { count: s })}</span>
                  </label>
                ))}
                <label className="dk-scope">
                  <input type="radio" name="dead-man" checked={choice === 'other'} onChange={() => setChoice('other')} />
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
                <label className="dk-scope">
                  <input type="checkbox" checked={keepAlive} onChange={(event) => setKeepAlive(event.target.checked)} />
                  <span>{t('Dead man keep alive')}</span>
                </label>
              </fieldset>
            )}
            {state?.armed && !note ? (
              <p className="dk-note" role="status">
                {passed ? t('Dead man firing') : t('Dead man armed', { time: at(state) })}
              </p>
            ) : null}
            {note ? (
              <p
                data-testid={note.tone === 'good' ? undefined : 'dk-note--bad'}
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
              {state?.armed ? (
                <Button variant="secondary" size={40} loading={busy} onClick={() => void send(0)}>
                  {t('Dead man disarm')}
                </Button>
              ) : null}
              {choices.length > 0 ? (
                <Button
                  variant="primary"
                  shape="pill"
                  size={40}
                  loading={busy}
                  disabled={picked === null}
                  onClick={() => picked !== null && void send(picked)}
                >
                  {state?.armed ? t('Dead man refresh') : t('Dead man arm')}
                </Button>
              ) : null}
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}

/**
 * The popup and the sound of a price alert (J-charts-desk-10, C-alerts-scan-04), played by this app while it is open.
 *
 * The bell's unread count is polled already. When it goes up, the newest unread notifications are read once; each alert
 * notification not seen before whose alert was set to the popup shows one over the page (closed by the person, or after a
 * short while), and one set to the sound plays a short tone. The alert's channels come from the person's own alert list.
 * Nothing plays for a notification that was already there when the app opened, and nothing is invented: a browser that
 * blocks sound before the person has used the page plays none.
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../features/session/session';
import { alertsCopy } from './alerts-copy';
import { listAlerts, listNotifications, type Notification } from './notify-api';

const POPUP_MS = 12_000;

function tone() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    /* a browser that refuses sound plays none */
  }
}

export function AlertCues({ unread }: { unread: number | null }) {
  const copy = alertsCopy.useCopy();
  const { api, userId } = useSession();
  const seen = useRef<Set<string> | null>(null);
  const last = useRef<number | null>(null);
  const [popups, setPopups] = useState<readonly Notification[]>([]);

  useEffect(() => {
    if (!userId || unread === null) return;
    const before = last.current;
    last.current = unread;
    // The first count only marks what was already there; a count that did not go up has nothing new.
    if (before !== null && unread <= before && seen.current !== null) return;
    const controller = new AbortController();
    void (async () => {
      const page = await listNotifications(api, { limit: 10, unreadOnly: true }, controller.signal);
      if (controller.signal.aborted || !page.ok) return;
      const alertsOnly = page.data.items.filter((item) => item.kind === 'alert.price.crossed' && typeof item.params.alertId === 'string');
      if (seen.current === null) {
        seen.current = new Set(page.data.items.map((item) => item.id));
        return;
      }
      const fresh = alertsOnly.filter((item) => !seen.current!.has(item.id));
      for (const item of page.data.items) seen.current.add(item.id);
      if (fresh.length === 0) return;
      const list = await listAlerts(api, controller.signal);
      if (controller.signal.aborted || !list.ok) return;
      const channelsOf = new Map(list.data.items.map((row) => [row.id, row.channels ?? ['inapp']]));
      const toShow = fresh.filter((item) => channelsOf.get(String(item.params.alertId))?.includes('popup'));
      if (fresh.some((item) => channelsOf.get(String(item.params.alertId))?.includes('sound'))) tone();
      if (toShow.length > 0) setPopups((shown) => [...toShow, ...shown].slice(0, 3));
    })();
    return () => controller.abort();
  }, [api, userId, unread]);

  useEffect(() => {
    if (popups.length === 0) return;
    const timer = window.setTimeout(() => setPopups((shown) => shown.slice(0, -1)), POPUP_MS);
    return () => window.clearTimeout(timer);
  }, [popups]);

  if (popups.length === 0) return null;
  return (
    <div className="nf-cues" aria-live="polite">
      {popups.map((item) => (
        <div key={item.id} role="status" className="nf-banner nf-cue" data-testid="alert-popup">
          <strong>{item.title}</strong>
          <span>{item.body}</span>
          <button type="button" onClick={() => setPopups((shown) => shown.filter((row) => row.id !== item.id))}>
            {copy.t('popupClose')}
          </button>
        </div>
      ))}
    </div>
  );
}

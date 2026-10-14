/**
 * The status bar under the workspace (PRO-TERMINAL-PLAN section 2): connection light, server clock, sound mute and
 * an Announcements placeholder. The light comes from today's polled reads; when the feed is lost the bar turns amber
 * and the price panels dim (see `PanelHost`), so nobody trades on a silent stale screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { Megaphone, Volume2, VolumeX } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipTrigger } from '@intafaced/ui';
import { terminalCopy } from './copy';
import { clockOffsetMs } from './connection';
import { useDesk } from './desk-context';
import { useNow } from '../desk/hooks';
import { clockSeconds } from '../desk/time';
import type { Preferences } from '../../../shared/preferences';

const MUTE_KEY = 'intafaced.terminal.muted.v1';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** The mute choice for this device. Nothing plays yet (the sound set is a later item); the choice is kept so it already holds when sounds arrive. */
export function useMuted(): [boolean, () => void] {
  const [muted, setMuted] = useState(readMuted);
  const toggle = () =>
    setMuted((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(MUTE_KEY, next ? '1' : '0');
      } catch {
        /* the choice just won't be remembered */
      }
      return next;
    });
  return [muted, toggle];
}

function zoneLabel(zone: Preferences['timeZone'], at: number): string {
  if (zone === 'UTC' || zone === 'UTC+8') return zone;
  try {
    return (
      new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ??
      ''
    );
  } catch {
    return '';
  }
}

export function StatusBar() {
  const { t } = terminalCopy.useCopy();
  const { connection, book, zone } = useDesk();
  const now = useNow(1_000);
  const [muted, toggleMuted] = useMuted();

  // M mutes (PRO-TERMINAL-PLAN section 8), unless the person is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'm' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]')
      )
        return;
      toggleMuted();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const offset = useMemo(() => (book.status === 'ready' ? clockOffsetMs(book.data.timestamp, book.asOf) : null), [book]);
  const serverNow = offset === null ? null : now + offset;
  const label = {
    connecting: t('Conn connecting'),
    live: t('Conn live'),
    delayed: t('Conn delayed'),
    reconnecting: t('Conn reconnecting'),
  }[connection];
  const detail = {
    connecting: t('Conn connecting detail'),
    live: t('Conn live detail'),
    delayed: t('Conn delayed detail'),
    reconnecting: t('Conn reconnecting detail'),
  }[connection];

  return (
    <footer className="tm-status" data-state={connection} aria-label={t('Status bar')}>
      <Tooltip>
        <TooltipTrigger render={<span className="tm-conn" tabIndex={0} role="status" aria-label={`${label}. ${detail}`} />}>
          <span className="tm-dot" aria-hidden="true" />
          <span>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{detail}</TooltipContent>
      </Tooltip>
      <span className="tm-clock if-num" aria-label={t('Server time')}>
        {serverNow === null ? (
          <>{t('Server time')} —</>
        ) : (
          <>
            {t('Server time')} {clockSeconds(serverNow, zone)} {zoneLabel(zone, serverNow)}
          </>
        )}
      </span>
      <span className="tm-status-gap" />
      <button
        type="button"
        className="tm-status-btn"
        aria-pressed={muted}
        aria-label={muted ? t('Unmute sounds') : t('Mute sounds')}
        onClick={toggleMuted}
      >
        {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
        <span>{muted ? t('Sounds off') : t('Sounds on')}</span>
      </button>
      <Popover>
        <PopoverTrigger className="tm-status-btn">
          <Megaphone size={14} aria-hidden="true" />
          <span>{t('Announcements')}</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="tm-announce">
          <p className="tm-announce-title">{t('Announcements')}</p>
          <p>{t('No announcements')}</p>
          <p className="tm-announce-about">{t('Announcements about')}</p>
        </PopoverContent>
      </Popover>
    </footer>
  );
}

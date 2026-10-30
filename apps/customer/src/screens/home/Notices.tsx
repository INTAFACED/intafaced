import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { dayTime } from './clock';
import { homeCopy } from './copy';
import { StatusTag } from './deps';
import { homeNotices, type HomeNotice } from './notice-model';
import { HOME_CONFIG_PROCEDURE, homeConfigOutputSchema, NOTICE_STRIP_LIMIT_UNSET } from '@intafaced/contracts/home-work-items';
import { readLatestAnnouncements, readNoticeStatus } from '../../features/public/notices-api';
import { useSession } from '../../features/session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';

/** Only an incident interrupts a screen reader; a planned window and an announcement are read when reached. */
const KIND = {
  incident: { status: 'failed', label: 'Notice kind incident', role: 'alert' },
  maintenance: { status: 'pending', label: 'Notice kind maintenance', role: 'status' },
  announcement: { status: 'working', label: 'Notice kind announcement', role: 'status' },
} as const;

/** How often an open Home reads the board again, so a new window shows and a closed one goes. */
const REREAD_MS = 60_000;

/**
 * The board's last answer. A re-read keeps it on screen while it loads; a failed read draws nothing, as on first load.
 */
function useLastAnswer<T>(resource: Resource<T>): T | null {
  const last = useRef<T | null>(null);
  if (resource.status === 'ready') last.current = resource.data;
  else if (resource.status === 'failed') last.current = null;
  return last.current;
}

/** A failed read draws nothing on Home; one line goes to the console so the gap is not silent. */
function useLogged(resource: Resource<unknown>, what: string) {
  const code = resource.status === 'failed' ? resource.failure.code : null;
  useEffect(() => {
    if (code) console.warn(`home notices: ${what} unread (${code})`);
  }, [code, what]);
}

/**
 * The notice board on Home (HM-widgets-03): a banner for each open incident or maintenance window, with its end time,
 * and a strip of the latest announcements, as many as the owner's strip count (`home.config`). Published notices only,
 * plain text only, and nothing at all when there is nothing to show or the board does not answer. While the strip count
 * is blank the strip says so with `home.notice_strip_limit_unset`, and no number of notices is invented.
 */
export function HomeNotices() {
  const { api } = useSession();
  const status = useResource((signal) => readNoticeStatus(api, signal), 'home-notice-status');
  const config = useResource(
    (signal) => api.query('ops', HOME_CONFIG_PROCEDURE, undefined, homeConfigOutputSchema, { signal }),
    'home-config',
  );
  const limit = config.resource.status === 'ready' ? config.resource.data.noticeStripLimit : null;
  const announcement = useResource(
    (signal) => (limit === null ? Promise.resolve({ ok: true as const, data: [] }) : readLatestAnnouncements(api, limit, signal)),
    `home-announcements:${limit ?? 'unset'}`,
  );
  useLogged(status.resource, 'notice status');
  useLogged(config.resource, 'owner values');
  useLogged(announcement.resource, 'announcements');
  const stripUnset = config.resource.status === 'ready' && limit === null;
  const [now, setNow] = useState(() => Date.now());
  const reread = useRef(() => {});
  reread.current = () => {
    setNow(Date.now());
    status.reload();
    announcement.reload();
  };
  useEffect(() => {
    const timer = setInterval(() => reread.current(), REREAD_MS);
    return () => clearInterval(timer);
  }, []);
  const lastStatus = useLastAnswer(status.resource);
  const lastAnnouncement = useLastAnswer(announcement.resource);
  const { banner, strip } = useMemo(() => homeNotices(lastStatus, lastAnnouncement, now), [lastStatus, lastAnnouncement, now]);
  if (banner.length === 0 && strip.length === 0 && !stripUnset) return null;
  return (
    <div data-testid="home-notices" className="home-notices">
      {banner.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} banner />
      ))}
      {strip.map((notice, index) => (
        <NoticeRow key={notice.id} notice={notice} banner={false} all={index === 0} />
      ))}
      {stripUnset ? <StripUnset /> : null}
    </div>
  );
}

/** The strip while the owner's strip count is blank: it says so, with the typed code, and lists no notice. */
function StripUnset() {
  const { t } = homeCopy.useCopy();
  return (
    <section data-testid="home-notice-strip-unset" className="home-notice" role="status" data-code={NOTICE_STRIP_LIMIT_UNSET}>
      <p className="home-notice__title">{t('Notice strip unset')}</p>
      <a className="home-notice__link" href="/notice">
        {t('Notice all')}
      </a>
    </section>
  );
}

export function NoticeRow({ notice, banner, all = !banner }: { notice: HomeNotice; banner: boolean; all?: boolean }) {
  const { t } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  const kind = KIND[notice.kind];
  const until = notice.endsAt ? dayTime(notice.endsAt, timeZone) : null;
  return (
    <section
      data-testid="home-notice"
      className={banner ? 'home-notice home-notice--banner' : 'home-notice'}
      role={kind.role}
      aria-label={t(kind.label)}
      data-kind={notice.kind}
    >
      <StatusTag status={kind.status} label={t(kind.label)} />
      <p className="home-notice__title">{notice.title}</p>
      {banner ? <p className="home-notice__until">{until ? t('Notice until {time}', { time: until }) : t('Notice no end')}</p> : null}
      <a className="home-notice__link" href={`/notice/${notice.id}`}>
        {t('Notice read')}
        <ChevronRight size={14} aria-hidden="true" />
      </a>
      {banner || !all ? null : (
        <a className="home-notice__link" href="/notice">
          {t('Notice all')}
        </a>
      )}
    </section>
  );
}

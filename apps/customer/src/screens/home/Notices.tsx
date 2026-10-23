import { useEffect, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { dayTime } from './clock';
import { homeCopy } from './copy';
import { StatusTag } from './deps';
import { homeNotices } from './notices';
import { readAnnouncement, readNoticeStatus, type Notice } from '../../features/public/notices-api';
import { useSession } from '../../features/session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';

const KIND = {
  incident: { status: 'failed', label: 'Notice kind incident' },
  maintenance: { status: 'pending', label: 'Notice kind maintenance' },
  announcement: { status: 'working', label: 'Notice kind announcement' },
} as const;

const answer = <T,>(resource: Resource<T>): T | null => (resource.status === 'ready' ? resource.data : null);

/** A failed read draws nothing on Home; one line goes to the console so the gap is not silent. */
function useLogged(resource: Resource<unknown>, what: string) {
  const code = resource.status === 'failed' ? resource.failure.code : null;
  useEffect(() => {
    if (code) console.warn(`home notices: ${what} unread (${code})`);
  }, [code, what]);
}

/**
 * The notice board on Home (HM-widgets-03): a banner for each open incident or maintenance window, with its end time,
 * and a strip for the current announcement. Published notices only, plain text only, and nothing at all when there is
 * nothing to show or the board does not answer.
 */
export function HomeNotices() {
  const { api } = useSession();
  const status = useResource((signal) => readNoticeStatus(api, signal), 'home-notice-status');
  const announcement = useResource((signal) => readAnnouncement(api, signal), 'home-announcement');
  useLogged(status.resource, 'notice status');
  useLogged(announcement.resource, 'announcement');
  const { banner, strip } = useMemo(
    () => homeNotices(answer(status.resource), answer(announcement.resource)),
    [status.resource, announcement.resource],
  );
  if (banner.length === 0 && strip === null) return null;
  return (
    <div className="home-notices">
      {banner.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} banner />
      ))}
      {strip ? <NoticeRow notice={strip} banner={false} /> : null}
    </div>
  );
}

export function NoticeRow({ notice, banner }: { notice: Notice; banner: boolean }) {
  const { t } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  const kind = notice.kind === 'changelog' ? KIND.announcement : KIND[notice.kind];
  const until = notice.endsAt ? dayTime(notice.endsAt, timeZone) : null;
  return (
    <section
      className={banner ? 'home-notice home-notice--banner' : 'home-notice'}
      role={banner ? 'alert' : 'status'}
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
      {banner ? null : (
        <a className="home-notice__link" href="/notice">
          {t('Notice all')}
        </a>
      )}
    </section>
  );
}

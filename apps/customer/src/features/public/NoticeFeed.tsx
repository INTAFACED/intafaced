import { useEffect, useState } from 'react';
import { StateBlock } from '@intafaced/ui';
import { useSession } from '../session/session';
import { useRead } from '../developers/use-read';
import { noticeFeedCopy } from './notice-feed-copy';
import { feedNotices, isNoticeId, maintenancePhase, readNotice, readNotices, type Notice } from './notices-api';
import './public-pages.css';

const day = (value: string | null) => (value ? value.slice(0, 10) : null);

/** The time, moving on each minute, so an open page's maintenance phase follows the clock across a window's edge. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function NoticeCard({ notice, link }: { notice: Notice; link: boolean }) {
  const { t } = noticeFeedCopy.useCopy();
  const from = day(notice.startsAt);
  const to = day(notice.endsAt);
  const now = useMinute();
  const phase = maintenancePhase(notice, now);
  return (
    <article className="pub-card" data-kind={notice.kind} data-testid={`notice-${notice.id}`} {...(phase ? { 'data-phase': phase } : {})}>
      <h2>{notice.title}</h2>
      <p className="muted">
        {t(`kind_${notice.kind}` as const)}
        {phase ? ` · ${t(`maintenance_${phase}` as const)}` : ''}
        {notice.publishedAt ? ` · ${t('published', { date: day(notice.publishedAt) ?? '' })}` : ''}
        {from || to ? ` · ${t('window', { from: from ?? t('windowNotSet'), to: to ?? t('windowNotSet') })}` : ''}
      </p>
      <p>{notice.body}</p>
      {link && (
        <a className="text-link" href={`/notice/${notice.id}`}>
          {t('open')} →
        </a>
      )}
    </article>
  );
}

/** The list, given rows already read. Empty is a plain statement, never a sample. */
export function NoticeList({ notices }: { notices: readonly Notice[] }) {
  const { t } = noticeFeedCopy.useCopy();
  const rows = feedNotices(notices);
  if (rows.length === 0)
    return (
      <section className="pub-notice" role="status">
        <h2>{t('none')}</h2>
        <p>{t('noneBody')}</p>
      </section>
    );
  return (
    <>
      {rows.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} link />
      ))}
    </>
  );
}

export function NoticeMissing() {
  const { t } = noticeFeedCopy.useCopy();
  return (
    <section className="pub-notice" role="status">
      <h2>{t('detailNone')}</h2>
      <p>{t('detailNoneBody')}</p>
    </section>
  );
}

function NoticeLoaded({ id }: { id: string }) {
  const { t } = noticeFeedCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readNotice(api, id, signal), [api, id]);
  if (read.status === 'loading') return <StateBlock kind="loading" rows={1} rowHeight={96} label={t('loading')} />;
  if (read.status === 'failed') return <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />;
  return read.data ? <NoticeCard notice={read.data} link={false} /> : <NoticeMissing />;
}

/** One notice. A reference that is not a notice id reads as not published without asking the service. */
export function NoticeDetail({ id }: { id: string | null }) {
  return isNoticeId(id) ? <NoticeLoaded id={id} /> : <NoticeMissing />;
}

/** The feed on /notice. */
export function NoticeFeed() {
  const { t } = noticeFeedCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readNotices(api, signal), [api]);
  if (read.status === 'loading') return <StateBlock kind="loading" rows={3} rowHeight={72} label={t('loading')} />;
  if (read.status === 'failed') return <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />;
  return <NoticeList notices={read.data} />;
}

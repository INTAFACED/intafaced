import { useEffect, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { useRead } from '../../developers';
import { noticeFeedCopy } from '../notice-feed-copy';
import { feedNotices, isNoticeId, maintenancePhase, readNotice, readNotices, type Notice } from '../notices-api';

const day = (value: string | null) => (value ? value.slice(0, 10) : null);
/** The second a fee change takes effect, in UTC as stored: "2026-11-01 00:00:00 UTC" (a minute alone would read early). */
const secondUtc = (value: string) => `${value.slice(0, 19).replace('T', ' ')} UTC`;

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
  const feeChange = notice.kind === 'fee_change';
  return (
    <article className="lt-stack" data-kind={notice.kind} data-testid={`notice-${notice.id}`} {...(phase ? { 'data-phase': phase } : {})}>
      <h2>{notice.title}</h2>
      <p className="lt-hint">
        {t(`kind_${notice.kind}` as const)}
        {notice.category ? (
          <>
            {' · '}
            <span data-testid="notice-category">{notice.category.name}</span>
          </>
        ) : null}
        {phase ? ` · ${t(`maintenance_${phase}` as const)}` : ''}
        {notice.publishedAt ? ` · ${t('published', { date: day(notice.publishedAt) ?? '' })}` : ''}
        {feeChange && notice.startsAt ? (
          <>
            {' · '}
            <time data-testid="notice-effective" dateTime={notice.startsAt}>
              {t('effective', { time: secondUtc(notice.startsAt) })}
            </time>
          </>
        ) : from || to ? (
          ` · ${t('window', { from: from ?? t('windowNotSet'), to: to ?? t('windowNotSet') })}`
        ) : (
          ''
        )}
      </p>
      <p>{notice.body}</p>
      {feeChange ? <p className="lt-hint">{t('effectiveNote')}</p> : null}
      {link && (
        <a className="lt-link" href={`/notice/${notice.id}`}>
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
      <section className="lt-empty" role="status">
        <h2 className="lt-empty-title">{t('none')}</h2>
        <p className="lt-empty-body">{t('noneBody')}</p>
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
    <section className="lt-empty" role="status">
      <h2 className="lt-empty-title">{t('detailNone')}</h2>
      <p className="lt-empty-body">{t('detailNoneBody')}</p>
    </section>
  );
}

/** The feed or one notice on its way: the kit's skeleton rows, named for assistive tech. */
function Loading({ label, rows }: { label: string; rows: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <Skeleton shape="rows" count={rows} />
    </div>
  );
}

/** A read that failed: said plainly, with a way to read again. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = noticeFeedCopy.useCopy();
  return (
    <div className="lt-refusal" role="alert">
      <p className="lt-refusal-title">{t('loadFailed')}</p>
      <div className="lt-actions">
        <Button tone="secondary" onClick={onRetry}>
          {t('tryAgain')}
        </Button>
      </div>
    </div>
  );
}

function NoticeLoaded({ id }: { id: string }) {
  const { t } = noticeFeedCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readNotice(api, id, signal), [api, id]);
  if (read.status === 'loading') return <Loading label={t('loading')} rows={1} />;
  if (read.status === 'failed') return <LoadFailed onRetry={reload} />;
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
  if (read.status === 'loading') return <Loading label={t('loading')} rows={3} />;
  if (read.status === 'failed') return <LoadFailed onRetry={reload} />;
  return <NoticeList notices={read.data} />;
}

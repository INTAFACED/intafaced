import type { Notice, NoticeStatus } from '../../features/public/notices-api';

/** A notice Home draws: the board's own three kinds (changelog entries have their own page). */
export type HomeNotice = Notice & { kind: 'incident' | 'maintenance' | 'announcement' };

/** What Home draws from the notice board (HM-widgets-03): open windows as a banner, the latest announcements as a strip. */
export type HomeNotices = { banner: HomeNotice[]; strip: HomeNotice[] };

const drawable = (row: Notice): row is HomeNotice => row.kind === 'incident' || row.kind === 'maintenance' || row.kind === 'announcement';

/** Only published notices still open at `now` are drawn, each once, whatever the read held. */
const open = (rows: readonly Notice[], now: number): HomeNotice[] => {
  const seen = new Set<string>();
  return rows.filter(
    (row): row is HomeNotice =>
      drawable(row) &&
      row.status === 'published' &&
      !(row.endsAt !== null && Date.parse(row.endsAt) <= now) &&
      !seen.has(row.id) &&
      !!seen.add(row.id),
  );
};

/**
 * Incidents lead the banner, then maintenance windows. A read that failed draws nothing: the rest of Home is unaffected
 * and nothing is invented in its place. A window that has closed since the read is dropped without waiting for the next.
 */
export function homeNotices(status: NoticeStatus | null, announcements: readonly Notice[] | null, now: number): HomeNotices {
  const banner = status ? open([...status.incidents, ...status.maintenance], now) : [];
  const strip = announcements
    ? open(
        announcements.filter((row) => row.kind === 'announcement'),
        now,
      )
    : [];
  return { banner, strip };
}

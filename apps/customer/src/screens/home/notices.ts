import type { Notice, NoticeStatus } from '../../features/public/notices-api';

/** What Home draws from the notice board (HM-widgets-03): open windows as a banner, the current announcement as a strip. */
export type HomeNotices = { banner: Notice[]; strip: Notice | null };

/** Only published notices are drawn, each once, whatever the read held. */
const published = (rows: readonly Notice[]): Notice[] => {
  const seen = new Set<string>();
  return rows.filter((row) => row.status === 'published' && !seen.has(row.id) && seen.add(row.id));
};

/**
 * Incidents lead the banner, then maintenance windows. A read that failed draws nothing: the rest of Home is unaffected
 * and nothing is invented in its place.
 */
export function homeNotices(status: NoticeStatus | null, announcement: Notice | null): HomeNotices {
  const banner = status ? published([...status.incidents, ...status.maintenance]) : [];
  const strip = announcement && announcement.kind === 'announcement' ? (published([announcement])[0] ?? null) : null;
  return { banner, strip };
}

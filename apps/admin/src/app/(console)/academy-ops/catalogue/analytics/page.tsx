import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { Failed } from '@/components/academy-courses-desk';
import { ACADEMY_LEARNER_TAG_PATTERN } from '@intafaced/contracts/academy-learner-desk';
import { loadAnalytics } from '@/lib/academy/analytics-server';
import { ACTIVITY_DAYS, cellText } from '@/lib/academy/analytics-model';
import { formatWhen } from '@/lib/as-of';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Academy's numbers (AC-analytics-01, J-academy-16 #1 and #2): lesson reads, completions and certificates granted on
 * each of the last UTC days, as svc-academy counts them (a day before it began recording reads "not recorded", never
 * zero, and no day is shown that the window does not hold), and a summary of each learner with an open enrolment,
 * filtered by a learner tag. Read only.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ tag?: string; after?: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { tag: rawTag, after: rawAfter } = await searchParams;
  const tag = rawTag && ACADEMY_LEARNER_TAG_PATTERN.test(rawTag.trim()) ? rawTag.trim() : null;
  const after = rawAfter && UUID.test(rawAfter) ? rawAfter : null;
  const view = await loadAnalytics(founder, { tag, after, now: new Date() });
  const activity = view.activity;
  const summaries = view.summaries;
  return (
    <div className="dk" data-testid="academy-analytics">
      <div className="adm-pagehead">
        <div>
          <h1>Academy numbers</h1>
          <p>
            <Link href="/academy-ops/catalogue">Back to the catalogue</Link> · <Link href="/academy-ops/catalogue/reports">Reports</Link>
          </p>
        </div>
      </div>
      <section className="dk-stack" aria-labelledby="h-activity">
        <h2 id="h-activity">Activity by day, last {ACTIVITY_DAYS} UTC days</h2>
        {activity.kind === 'failed' ? (
          <Failed title="Could not read the daily activity" message={activity.message} code={activity.code} />
        ) : (
          <>
            <p className="dk-muted" data-testid="recording-since" data-day={activity.data.recordingSince}>
              svc-academy has recorded learning activity since {activity.data.recordingSince} (UTC). A day before that reads “not recorded”.
            </p>
            <table className="dk-table" data-testid="activity-by-day">
              <thead>
                <tr>
                  <th scope="col">Day (UTC)</th>
                  <th scope="col">Lessons read</th>
                  <th scope="col">Items completed</th>
                  <th scope="col">Certificates granted</th>
                </tr>
              </thead>
              <tbody>
                {activity.data.days.map((d) => (
                  <tr key={d.date} data-day={d.date}>
                    <th scope="row">{d.date}</th>
                    <td data-metric="lessonsRead">{cellText(d.lessonsRead)}</td>
                    <td data-metric="completions">{cellText(d.completions)}</td>
                    <td data-metric="grants">{cellText(d.grants)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      <section className="dk-stack" aria-labelledby="h-summaries">
        <h2 id="h-summaries">Learner summaries</h2>
        <form className="dk-row" aria-label="Filter learner summaries" method="get">
          <label>
            Learner tag (blank for every learner)
            <input name="tag" defaultValue={tag ?? ''} aria-label="Learner tag" />
          </label>
          <button type="submit" className="adm-btn">
            Show summaries
          </button>
        </form>
        {summaries.kind === 'failed' ? (
          <Failed title="Could not read the learner summaries" message={summaries.message} code={summaries.code} />
        ) : summaries.data.rows.length === 0 ? (
          <p className="dk-muted" data-testid="learner-summaries-empty">
            {tag ? `No learner with an open enrolment carries the tag ${tag}.` : 'No learner has an open enrolment yet.'}
          </p>
        ) : (
          <>
            <table className="dk-table" data-testid="learner-summaries" data-tag={tag ?? ''}>
              <thead>
                <tr>
                  <th scope="col">Learner</th>
                  <th scope="col">Open enrolments</th>
                  <th scope="col">Items completed</th>
                  <th scope="col">Last active</th>
                  <th scope="col">Tags</th>
                </tr>
              </thead>
              <tbody>
                {summaries.data.rows.map((row) => (
                  <tr key={row.userId} data-learner={row.userId}>
                    <td>
                      <a href={`/academy-ops/programmes/learners/${row.userId}`}>{row.userId}</a>
                    </td>
                    <td data-metric="enrolments">{row.enrolments}</td>
                    <td data-metric="itemsCompleted">{row.itemsCompleted}</td>
                    <td data-metric="lastActive" data-at={row.lastActiveAt ?? ''}>
                      {row.lastActiveAt ? formatWhen(row.lastActiveAt) : 'not recorded'}
                    </td>
                    <td>{row.tags.join(', ') || 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summaries.data.next && (
              <Link
                href={`/academy-ops/catalogue/analytics?${new URLSearchParams({ ...(tag ? { tag } : {}), after: summaries.data.next })}`}
              >
                Next {summaries.data.pageSize} learners
              </Link>
            )}
          </>
        )}
      </section>
    </div>
  );
}

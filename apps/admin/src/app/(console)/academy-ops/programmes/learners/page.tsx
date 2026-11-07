import { redirect } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { Failed } from '@/components/academy-courses-desk';
import { findLearner, loadLearners } from '@/lib/academy/learners-server';
import { ACADEMY_LEARNER_TAG_PATTERN } from '@intafaced/contracts/academy-learner-desk';

/**
 * Learners (J-academy-14): find one learner by their whole email or handle and open their page, or read the learners
 * report, filtered by a tag. The search is identity's exact lookup, audited there; nothing is kept here.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; tag?: string }> }) {
  requireModulePage('academy-ops');
  const operator = await requireFounderPage();
  const { q, tag: rawTag } = await searchParams;
  const term = (q ?? '').trim();
  let searchMessage: { title: string; message: string; code: string | null } | null = null;
  if (term) {
    const found = await findLearner(operator, term);
    if (found.kind === 'ok' && found.data) redirect(`/academy-ops/programmes/learners/${found.data.id}`);
    searchMessage =
      found.kind === 'ok'
        ? { title: 'No learner found', message: `No account has the email or handle “${term}”.`, code: null }
        : { title: 'Could not search', message: found.message, code: found.code };
  }
  const tag = rawTag && ACADEMY_LEARNER_TAG_PATTERN.test(rawTag.trim()) ? rawTag.trim() : null;
  const view = await loadLearners(operator, tag);
  const report = view.report;
  return (
    <section className="dk-stack" aria-labelledby="h-learners" data-testid="learners-desk">
      <h2 id="h-learners">Learners</h2>
      <form className="dk-row" role="search" aria-label="Find a learner" method="get">
        <label>
          Whole email or handle
          <input name="q" defaultValue={term} aria-label="Learner email or handle" />
        </label>
        <button type="submit" className="adm-btn">
          Find learner
        </button>
      </form>
      {searchMessage && <Failed title={searchMessage.title} message={searchMessage.message} code={searchMessage.code} />}
      <h3>{tag ? `Learners tagged ${tag}` : 'Every learner'}</h3>
      <form className="dk-row" aria-label="Filter by tag" method="get">
        <label>
          Tag
          <select name="tag" defaultValue={tag ?? ''} aria-label="Filter by tag">
            <option value="">Every learner</option>
            {view.tags.kind === 'ok' &&
              view.tags.data.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.learners})
                </option>
              ))}
          </select>
        </label>
        <button type="submit" className="adm-btn">
          Show
        </button>
      </form>
      {report.kind === 'failed' ? (
        <Failed title="Could not read the learners report" message={report.message} code={report.code} />
      ) : report.data.rows.length === 0 ? (
        <p className="dk-muted">{tag ? `No learner carries the tag ${tag}.` : 'No learner yet.'}</p>
      ) : (
        <table className="dk-table" data-testid="learners-report" data-tag={tag ?? ''}>
          <thead>
            <tr>
              <th scope="col">Learner</th>
              <th scope="col">Courses</th>
              <th scope="col">Tags</th>
            </tr>
          </thead>
          <tbody>
            {report.data.rows.map((row) => (
              <tr key={row.userId} data-learner={row.userId}>
                <td>
                  <a href={`/academy-ops/programmes/learners/${row.userId}`}>{view.handles[row.userId] ?? row.userId}</a>
                </td>
                <td>{row.paths.join(', ') || 'none'}</td>
                <td>{row.tags.join(', ') || 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

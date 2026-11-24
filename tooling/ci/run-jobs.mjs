// Read by tooling/ci/*: the one jobs-list reader.
// A run's jobs, read in pages of JOBS_PAGE and followed to the last page: the one way to read a run's jobs list.
//
// GitHub's jobs page costs it about 0.2 s a job on a run that has been re-run, and its gateway answers 502 at about 10 s.
// Measured 22 Nov 2026 on re-run runs 44481200108 (97 jobs) and 44473256197 (71 jobs): per_page=100 was 502 at 11.1 s
// on every try, per_page=50 took 9.4 to 10.0 s, per_page=30 took 5.6 to 6.0 s (project-state#3258). One page of 100
// made every reader fail closed after any re-run, the merge seal among them (intafaced#8984, job 135427222376).
// tooling/ci/run-jobs.test.mjs fails on any reader that asks a run's jobs list by itself.

export const JOBS_PAGE = 30;
// 20 pages of 30: past the most jobs a run can hold today (90 shards and their few other jobs; journey-shards.mjs).
const MAX_PAGES = 20;

/** The path of one page: `path` is a run's (or attempt's) jobs list, with or without a filter, never per_page or page. */
export function jobsPage(path, page) {
  if (/[?&](per_page|page)=/.test(path)) throw new Error(`runJobs: ${path} names its own page; give the path without it`);
  return `${path}${path.includes('?') ? '&' : '?'}per_page=${JOBS_PAGE}&page=${page}`;
}

// One page read: whether that was the last, or null when the reply held no list (the caller decides what that means).
function take(out, json) {
  if (!Array.isArray(json?.jobs)) return null;
  out.push(...json.jobs);
  return json.jobs.length < JOBS_PAGE || (Number.isSafeInteger(json.total_count) && out.length >= json.total_count);
}

/**
 * Every job of a run, every page. `getJson(pagePath)` returns the page's parsed reply (it may throw, as its own reader
 * does). A page that holds no jobs list makes the whole read null, so a caller that checked `?.jobs` checks this instead.
 */
export async function runJobs(path, getJson) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const last = take(out, await getJson(jobsPage(path, page)));
    if (last === null) return null;
    if (last) return out;
  }
  throw new Error(`${path}: more than ${MAX_PAGES * JOBS_PAGE} jobs, not whole`);
}

/** runJobs for a reader that is not async (`gh api` through execFileSync). */
export function runJobsSync(path, getJson) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const last = take(out, getJson(jobsPage(path, page)));
    if (last === null) return null;
    if (last) return out;
  }
  throw new Error(`${path}: more than ${MAX_PAGES * JOBS_PAGE} jobs, not whole`);
}

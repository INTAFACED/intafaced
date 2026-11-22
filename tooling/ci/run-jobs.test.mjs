import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JOBS_PAGE, jobsPage, runJobs, runJobsSync } from './run-jobs.mjs';

// A reply like GitHub's after a re-run (project-state#3258): 502 past 30 a page, else the page asked.
function github(all) {
  const asked = [];
  const get = (path) => {
    asked.push(path);
    const u = new URL(path, 'https://api.github.com');
    const per = Number(u.searchParams.get('per_page') ?? 30);
    if (per > 30) throw new Error(`GitHub 502 on GET ${path}`);
    const page = Number(u.searchParams.get('page') ?? 1);
    return { total_count: all.length, jobs: all.slice((page - 1) * per, page * per) };
  };
  return { asked, get };
}
const jobsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `shard ${i + 1}` }));

test("22 Nov replayed: run 44481200108's 97 jobs after its re-run are read whole, in pages GitHub answers", async () => {
  const { asked, get } = github(jobsOf(97));
  const jobs = await runJobs('/repos/o/r/actions/runs/44481200108/jobs?filter=latest', get);
  assert.deepEqual(
    jobs.map((j) => j.id),
    jobsOf(97).map((j) => j.id),
  );
  assert.deepEqual(
    asked,
    [1, 2, 3, 4].map((p) => `/repos/o/r/actions/runs/44481200108/jobs?filter=latest&per_page=30&page=${p}`),
  );
  assert.equal(JOBS_PAGE, 30);
});

test('a run of exactly one page asks once more only when the count says there is more', async () => {
  const { asked, get } = github(jobsOf(30));
  assert.equal((await runJobs('/repos/o/r/actions/runs/1/jobs', get)).length, 30);
  assert.deepEqual(asked, ['/repos/o/r/actions/runs/1/jobs?per_page=30&page=1']);
  const sync = github(jobsOf(45));
  assert.equal(runJobsSync('repos/o/r/actions/runs/1/attempts/2/jobs', sync.get).length, 45);
  assert.equal(sync.asked.length, 2);
});

test('a page with no jobs list makes the read null; a failed page throws as its reader does; a path with its own page is refused', async () => {
  assert.equal(await runJobs('/r/runs/1/jobs', async () => ({ message: 'Not Found' })), null);
  assert.equal(
    runJobsSync('/r/runs/1/jobs', () => undefined),
    null,
  );
  let n = 0;
  const second = async () => (++n === 1 ? { total_count: 40, jobs: jobsOf(30) } : null);
  assert.equal(await runJobs('/r/runs/1/jobs', second), null, 'a missing later page is not a whole read');
  await assert.rejects(() => runJobs('/r/runs/1/jobs', async () => Promise.reject(new Error('GitHub 502'))), /GitHub 502/);
  assert.throws(() => jobsPage('/r/runs/1/jobs?filter=latest&per_page=100', 1), /names its own page/);
  await assert.rejects(() => runJobs('/r/runs/1/jobs', async () => ({ total_count: 9999, jobs: jobsOf(30) })), /not whole/);
});

// Every reader of a run's jobs list goes through runJobs (or, in a workflow, gh api --paginate at per_page=30).
const RUN_JOBS = /(?:runs|attempts)\/(?:\$\{[^}]+\}|\$\w+|\d+)\/jobs(?![\w/-])/g;
function strays(files) {
  const out = [];
  for (const { path, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!RUN_JOBS.test(line)) return;
      RUN_JOBS.lastIndex = 0;
      const ok = path.endsWith('.yml')
        ? /per_page=30\b/.test(line) && /--paginate/.test(line + lines[i + 1])
        : /runJobs(Sync)?\(/.test(lines[i - 1] + line) && !/per_page=/.test(line);
      if (!ok) out.push(`${path}:${i + 1}: read a run's jobs with runJobs from tooling/ci/run-jobs.mjs (pages of 30)`);
    });
  }
  return out;
}

test("no reader asks a run's jobs list by itself (project-state#3258)", () => {
  const paths = execFileSync('git', ['ls-files', 'tooling/*.mjs', '.github/workflows/*.yml'], { encoding: 'utf8' })
    .split('\n')
    .filter((p) => p && !p.endsWith('.test.mjs') && p !== 'tooling/ci/run-jobs.mjs');
  assert.ok(paths.length > 50, 'the scan read the tree');
  assert.deepEqual(strays(paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }))), []);
});

test("the scan fails on the seal's own 19 Nov read, and on model-check.yml's page of 100", () => {
  const seal = [
    '    while (step.act === "jobs") {',
    '      const jobs = (await get(`/repos/${repo}/actions/runs/${step.runId}/jobs?filter=latest&per_page=100`))?.jobs;',
  ].join('\n');
  assert.equal(strays([{ path: 'tooling/ci/journey-seal.mjs', text: seal }]).length, 1);
  const yml = '            down=$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" --paginate \\';
  assert.equal(strays([{ path: '.github/workflows/model-check.yml', text: yml }]).length, 1);
  assert.equal(strays([{ path: 'x.mjs', text: 'GET /repos/o/r/actions/jobs/9/logs and /runs/${id}/jobs/rerun' }]).length, 0);
});

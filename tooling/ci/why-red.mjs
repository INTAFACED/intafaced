#!/usr/bin/env node
/**
 * WHY RED — one short answer to "why are this PR's checks not green?", for agents that pay for every line they read.
 *
 *   node tooling/ci/why-red.mjs 6064            a PR number (its current head)
 *   node tooling/ci/why-red.mjs <40-char sha>   one commit
 *   node tooling/ci/why-red.mjs --self-test
 *
 * Measured on 2026-10-23 across ten thread transcripts: a red CI took 7 to 10 calls and 30-40K characters to explain,
 * because the tail of a job log is runner cleanup (Postgres checkpoints, git), so threads fetched 3,000 and then 40,000
 * lines. The errors are already on GitHub as annotations (vitest's FAIL lines, the type errors and failed gates CI now
 * prints). This reads those, plus the job steps where a red job left none, and prints one verdict:
 *
 *   GREEN    every check passed on the head.
 *   RUNNING  some checks have not finished; the lines say which.
 *   REVIEW   every check is green except the merge seal, which only waits for the independent review of this head.
 *   RESEAL   the review is in but the seal stayed red and the sign-off workflow could not re-run it: re-run it once.
 *   RED      the lines say what failed.
 *   SUPERSEDED  a newer push to the PR cancelled this head's run.
 *
 * Read only: it changes no check and no result. A 403 or 429 from GitHub stops it (tooling/scripts/gate-gh.mjs).
 */
import { fileURLToPath } from 'node:url';
import { ghJson, makeGh } from '../scripts/gate-gh.mjs';

const SEAL = 'CI merge seal';
const REVIEW_STATUS = 'Independent review';
const RERUN_STATUS = 'Seal re-run'; // review-signoff.mjs posts it red when it could not re-run the seal itself
const REVIEW_MISSING = 'Review sign-off missing'; // the annotation title review-marker.mjs prints
const MAX_LINES = 8;
const WIDTH = 200;

const GREEN = new Set(['success', 'neutral', 'skipped']);

/** One annotation as one short line, or null for runner boilerplate that names nothing. */
export function annotationLine(a) {
  if (a.annotation_level !== 'failure') return null;
  let msg = String(a.message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!msg || /^Process completed with exit code \d+\.?$/.test(msg)) return null;
  // turbo's "command (/home/runner/.../services/svc-support) .../pnpm run typecheck exited (1)"
  const cmd = /^command \(.*\/([^/)]+)\) .*\brun (\S+) exited \((\d+)\)$/.exec(msg);
  if (cmd) msg = `${cmd[1]}: ${cmd[2]} failed (exit ${cmd[3]})`;
  const where = a.path && a.path !== '.github' ? `${a.path}${a.start_line ? `:${a.start_line}` : ''} ` : '';
  const title = a.title && !msg.startsWith(a.title) ? `${a.title}: ` : '';
  return `${where}${title}${msg}`.slice(0, WIDTH);
}

/**
 * One check run per name, the newest. A workflow that ran twice on a head (a re-run, or a re-triggered event) leaves
 * both runs in the list, and the older red one no longer counts.
 */
export function latestPerName(checks) {
  const newest = new Map();
  const key = (c) => [c.started_at ?? '', c.id];
  for (const c of checks) {
    const seen = newest.get(c.name);
    const [ct, ci] = key(c);
    const [st, si] = seen ? key(seen) : ['', -1];
    if (!seen || ct > st || (ct === st && ci > si)) newest.set(c.name, c);
  }
  return [...newest.values()];
}

/**
 * The verdict and its lines.
 * @param {{ sha: string, checks: Array<{id:number,name:string,status:string,conclusion:string|null}>,
 *   annotations: Record<number, object[]>, failedSteps: Record<number, string[]>,
 *   statuses: Array<{context:string,state:string}> }} input
 */
export function summarize({ sha, checks: all, annotations, failedSteps, statuses }) {
  const checks = latestPerName(all);
  const out = [];
  const running = checks.filter((c) => c.status !== 'completed');
  // The seal last: its line reads after the jobs it follows.
  const red = checks
    .filter((c) => c.status === 'completed' && !GREEN.has(c.conclusion))
    .sort((a, b) => (a.name === SEAL) - (b.name === SEAL));
  const green = checks.length - running.length - red.length;
  out.push(`${sha.slice(0, 12)}: ${checks.length} checks, ${green} green, ${running.length} running, ${red.length} red`);

  const lines = new Map();
  for (const c of red) {
    const seen = new Set();
    for (const a of annotations[c.id] ?? []) {
      const l = annotationLine(a);
      if (l && !seen.has(l)) seen.add(l);
    }
    lines.set(c.id, [...seen]);
  }

  const seal = red.find((c) => c.name === SEAL);
  const others = red.filter((c) => c !== seal);
  const sealOnlyReview =
    seal &&
    (annotations[seal.id] ?? []).some((a) => a.title === REVIEW_MISSING) &&
    lines.get(seal.id).every((l) => l.includes(REVIEW_MISSING));
  const rerunFailed = statuses.some((s) => s.context === RERUN_STATUS && s.state === 'failure');
  const reviewIn = statuses.some((s) => s.context === REVIEW_STATUS && s.state === 'success');
  const redStatuses = statuses.filter((s) => (s.state === 'failure' || s.state === 'error') && s.context !== RERUN_STATUS);

  for (const c of running) out.push(`RUNNING  ${c.name}`);
  for (const c of red) {
    if (c === seal && sealOnlyReview && others.length > 0) {
      out.push(`RED      ${c.name}: follows the red jobs above; this head also needs its independent review`);
      continue;
    }
    if (c === seal && sealOnlyReview) continue; // said once in the verdict
    out.push(`RED      ${c.name} (${c.conclusion})`);
    const ls = lines.get(c.id);
    for (const l of ls.slice(0, MAX_LINES)) out.push(`         ${l}`);
    if (ls.length > MAX_LINES) out.push(`         ... ${ls.length - MAX_LINES} more`);
    if (ls.length === 0) {
      const steps = failedSteps[c.id] ?? [];
      out.push(
        steps.length
          ? `         no error lines; failed step: ${steps.join('; ')} (job ${c.id}: search the log for that step, its tail is runner cleanup)`
          : `         no error lines and no failed step (job ${c.id})`,
      );
    }
  }
  for (const s of redStatuses) out.push(`RED      status ${s.context}`);

  const sealSeen = checks.some((c) => c.name === SEAL);
  const othersRunning = running.filter((c) => c.name !== SEAL);
  // A newer push to the same PR cancels this head's run (ci.yml concurrency): nothing on this head to fix.
  const superseded =
    others.length > 0 &&
    others.every(
      (c) => c.conclusion === 'cancelled' && (annotations[c.id] ?? []).some((a) => /higher priority waiting request/.test(a.message ?? '')),
    );
  if (superseded) out.push("SUPERSEDED: a newer push cancelled this head's run; read the PR's current head instead.");
  else if (redStatuses.length > 0 || others.length > 0 || (seal && !sealOnlyReview)) out.push('RED: fix what the lines above name.');
  else if (red.length === 0 && running.length === 0)
    out.push(sealSeen ? 'GREEN: every check passed on this head.' : `RUNNING: the "${SEAL}" has not reported on this head yet.`);
  else if (othersRunning.length > 0 || !seal)
    out.push(
      running.length === 1 && running[0].name === SEAL
        ? `RUNNING: every other check is green; the seal may be waiting for the independent review of this head.`
        : `RUNNING: ${running.length} check(s) not finished.`,
    );
  else if (rerunFailed)
    out.push(
      `RESEAL: the review is in, but the sign-off workflow could not re-run the seal ("${RERUN_STATUS}" is red); re-run the "${SEAL}" job once. Nothing to fix in the code.`,
    );
  else if (reviewIn)
    out.push(
      `REVIEW: the review is in and the sign-off workflow re-runs the seal; wait for it. Re-run the "${SEAL}" job once only if "${RERUN_STATUS}" turns red. Nothing to fix in the code.`,
    );
  else
    out.push(
      `REVIEW: every other check is green; the seal waits for "Independent review: PASS ${sha}" from a listed reviewer, and the sign-off workflow re-runs the seal when it lands. Ask the review thread if nobody has yet; a PASS that names this PR's own session (a \`Claude-Session:\` line of its commits) does not count, so another session reviews. Nothing to fix in the code.`,
    );
  return out;
}

/** Everything summarize() needs, read with `gh api` (REST only). */
export function collect(gh, repo, ref) {
  const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : ghJson(gh, ['api', `repos/${repo}/pulls/${ref}`]).head.sha;
  const checks = [];
  for (let page = 1; ; page++) {
    const r = ghJson(gh, ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`]);
    checks.push(...r.check_runs);
    if (r.check_runs.length === 0 || checks.length >= r.total_count) break;
  }
  const statuses = ghJson(gh, ['api', `repos/${repo}/commits/${sha}/status?per_page=100`]).statuses ?? [];
  const annotations = {};
  const failedSteps = {};
  for (const c of latestPerName(checks).filter((c) => c.status === 'completed' && !GREEN.has(c.conclusion))) {
    annotations[c.id] = ghJson(gh, ['api', `repos/${repo}/check-runs/${c.id}/annotations?per_page=50`]);
    if (!annotations[c.id].some((a) => annotationLine(a))) {
      // Only an Actions job has steps; another app's check run answers 404 here and keeps an empty list.
      const job = gh(['api', `repos/${repo}/actions/jobs/${c.id}`], { allowFail: true });
      const steps = job.status === 0 ? (JSON.parse(job.stdout).steps ?? []) : [];
      failedSteps[c.id] = steps.filter((s) => s.conclusion === 'failure').map((s) => s.name);
    }
  }
  return { sha, checks, annotations, failedSteps, statuses };
}

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`why-red self-test: ${msg}`);
  };
  const sha = 'a'.repeat(40);
  const fail = (message, extra = {}) => ({ annotation_level: 'failure', path: '.github', message, ...extra });
  const ok = (id, name) => ({ id, name, status: 'completed', conclusion: 'success' });
  const red = (id, name) => ({ id, name, status: 'completed', conclusion: 'failure' });
  const review = fail(`No success status "Independent review" on ${sha}.`, { title: REVIEW_MISSING });
  const last = (r) => r[r.length - 1];

  assert(annotationLine(fail('Process completed with exit code 1.')) === null, 'drops the exit-code boilerplate');
  assert(annotationLine({ annotation_level: 'notice', message: 'ubuntu-latest will migrate' }) === null, 'drops notices');
  assert(
    annotationLine(fail('command (/home/runner/work/x/x/services/svc-support) /bin/pnpm run typecheck exited (1)')) ===
      'svc-support: typecheck failed (exit 1)',
    'names the package a turbo task failed in',
  );
  assert(
    annotationLine(fail('AssertionError: expected false', { path: 'packages/config/a.test.ts', start_line: 281 })) ===
      'packages/config/a.test.ts:281 AssertionError: expected false',
    'keeps the file and line',
  );

  const base = { sha, annotations: {}, failedSteps: {}, statuses: [] };
  assert(last(summarize({ ...base, checks: [ok(1, 'Format'), ok(2, SEAL)] })).startsWith('GREEN'), 'all green');
  assert(last(summarize({ ...base, checks: [] })).startsWith('RUNNING'), 'no checks yet is not green');
  assert(last(summarize({ ...base, checks: [ok(1, 'Gate-file guard')] })).startsWith('RUNNING'), 'green without the seal is not green');
  assert(
    last(summarize({ ...base, checks: [ok(1, 'Format'), { id: 2, name: 'Tests', status: 'in_progress', conclusion: null }] })).startsWith(
      'RUNNING',
    ),
    'running',
  );

  const onlyReview = {
    ...base,
    checks: [ok(1, 'Format'), red(2, SEAL)],
    annotations: { 2: [review, fail('Process completed with exit code 1.')] },
  };
  assert(last(summarize(onlyReview)).startsWith('REVIEW'), 'a seal red only for the review says so');
  assert(!summarize(onlyReview).some((l) => l.startsWith('RED ')), 'and lists nothing as red');
  assert(
    last(summarize({ ...onlyReview, statuses: [{ context: REVIEW_STATUS, state: 'success' }] })).startsWith('REVIEW'),
    'a review status alone leaves the re-run to the sign-off workflow',
  );
  assert(
    last(summarize({ ...onlyReview, statuses: [{ context: REVIEW_STATUS, state: 'success' }] })).includes('the review is in'),
    'and does not send the author back to the reviewer',
  );
  assert(
    last(summarize({ ...onlyReview, statuses: [{ context: RERUN_STATUS, state: 'failure' }] })).startsWith('RESEAL'),
    'a failed sign-off re-run asks for one re-run by hand',
  );
  const reviewAndRunning = {
    ...onlyReview,
    checks: [...onlyReview.checks, { id: 6, name: 'Gitleaks', status: 'in_progress', conclusion: null }],
  };
  assert(last(summarize(reviewAndRunning)).startsWith('RUNNING'), 'never "nothing to fix" while another check still runs');
  const sealWaiting = { ...base, checks: [ok(1, 'Format'), { id: 2, name: SEAL, status: 'in_progress', conclusion: null }] };
  assert(last(summarize(sealWaiting)).includes('waiting for the independent review'), 'a running seal alone may be the review wait');

  // Never "nothing to fix" while anything else is red, or while the seal is red for another reason.
  const testsRed = {
    ...onlyReview,
    checks: [...onlyReview.checks, red(3, 'Tests (changed)')],
    annotations: { ...onlyReview.annotations, 3: [fail(' FAIL  src/a.test.ts > b')] },
  };
  const r = summarize(testsRed);
  assert(last(r).startsWith('RED'), 'a red job beside the review wait is RED');
  assert(
    r.some((l) => l.includes('FAIL src/a.test.ts > b')),
    'and names the failing test',
  );
  const sealOther = { ...base, checks: [red(2, SEAL)], annotations: { 2: [review, fail('needed job build: failure')] } };
  assert(last(summarize(sealOther)).startsWith('RED'), 'a seal red for another reason is RED');
  const sealBare = { ...base, checks: [red(2, SEAL)], annotations: { 2: [fail('Process completed with exit code 1.')] } };
  assert(last(summarize(sealBare)).startsWith('RED'), 'a seal red with no review annotation is RED');
  const cancelled = { ...base, checks: [{ ...red(4, 'Tests (1)'), conclusion: 'cancelled' }] };
  assert(last(summarize(cancelled)).startsWith('RED'), 'cancelled is not green');
  const statusRed = { ...base, checks: [ok(1, 'Format')], statuses: [{ context: 'Gitleaks', state: 'failure' }] };
  assert(
    summarize(statusRed).some((l) => l.includes('status Gitleaks')),
    'a red commit status is listed',
  );
  assert(
    last(summarize({ ...statusRed, checks: [ok(1, 'Format'), ok(2, SEAL)] })).startsWith('RED'),
    'a red commit status makes the verdict RED, never GREEN',
  );
  const sealFirst = summarize({ ...testsRed, checks: [red(2, SEAL), ok(1, 'Format'), red(3, 'Tests (changed)')] });
  assert(
    sealFirst.findIndex((l) => l.includes(SEAL)) > sealFirst.findIndex((l) => l.includes('Tests (changed)')),
    'the seal prints after the jobs it follows',
  );

  const cancelledByPush = fail('Canceling since a higher priority waiting request for CI-refs/pull/1/merge exists');
  const supersededRun = summarize({
    ...base,
    checks: [{ ...red(10, 'Tests (1/8)'), conclusion: 'cancelled' }, red(2, SEAL)],
    annotations: { 10: [cancelledByPush], 2: [fail('needed job tests-full: cancelled')] },
  });
  assert(last(supersededRun).startsWith('SUPERSEDED'), 'a run cancelled by a newer push says so');
  assert(last(summarize(cancelled)).startsWith('RED'), 'a cancel for another reason stays RED');

  const rerun = summarize({
    ...base,
    checks: [
      { ...red(7, 'Gate-file guard'), started_at: '2026-10-23T09:00:00Z' },
      { ...ok(8, 'Gate-file guard'), started_at: '2026-10-23T09:05:00Z' },
      ok(2, SEAL),
    ],
  });
  assert(last(rerun).startsWith('GREEN'), 'a check that failed and then passed on a later run is green');
  const rerunRed = summarize({
    ...base,
    checks: [
      { ...ok(8, 'Gate-file guard'), started_at: '2026-10-23T09:00:00Z' },
      { ...red(9, 'Gate-file guard'), started_at: '2026-10-23T09:05:00Z' },
      ok(2, SEAL),
    ],
  });
  assert(last(rerunRed).startsWith('RED'), 'a check that passed and then failed on a later run is red');

  const bare = summarize({
    ...base,
    checks: [red(5, 'Doctrine gates')],
    failedSteps: { 5: ['Doctrine gates (the same list `pnpm verify` runs)'] },
  });
  assert(
    bare.some((l) => l.includes('failed step: Doctrine gates')),
    'a red job with no annotations names its failed step',
  );
  console.log('why-red self-test ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
  } else {
    const ri = args.indexOf('--repo');
    const repo = ri >= 0 ? (args[ri + 1] ?? '') : 'INTAFACED/intafaced';
    const ref = args.find((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1));
    if (!ref || !/^(\d+|[0-9a-f]{40})$/.test(ref) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      console.error('usage: why-red.mjs <PR number | 40-char sha> [--repo owner/name] | --self-test');
      process.exit(2);
    }
    for (const line of summarize(collect(makeGh(), repo, ref))) console.log(line);
  }
}

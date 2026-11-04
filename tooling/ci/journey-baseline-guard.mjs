#!/usr/bin/env node
/**
 * JOURNEY BASELINE GUARD: a pull request may not hide a regression in docs/runbooks/journey-baseline.json.
 *
 * THE RULE (docs/runbooks/regression-issue-state.md, "The journeys baseline"; this guard enforces three of its lines):
 *
 *   1. The file is rewritten only from a finished Real-app journeys run on main that it names. A PR that changes the
 *      baseline's `run` must name a run of real-app-journeys.yml on main that completed and was not cancelled or
 *      skipped, with the run number, id and commit GitHub has for it, and no older than the run the base names.
 *   2. A step that has passed on main is never added as `unbuilt`. An entry the PR adds as `unbuilt`, or turns into
 *      `unbuilt`, is refused when the step passed in any finished run on main the guard reads: the run the base names,
 *      the run the PR names, and every finished, uncancelled run on main between them. The one exception is the
 *      runbook's "test ahead of code": an entry that names `strengthenedBy` (a full sha), `blocker`, `lane` and
 *      `lastPassedRun`, plus `priorTestProof` when that commit changes product code, may stand when every pass the
 *      guard sees came from a run whose commit does not contain `strengthenedBy`.
 *   3. Only a pass on main takes a step off. An entry the PR removes must have passed in a run the guard reads after the
 *      base's run, or be gone from docs/roadmap/journeys.json (a retired step; journeys.json is a gate file, so that is
 *      a reviewed change too).
 *
 * WHY THIS EXISTS
 *
 * The runbook wrote these rules on 1 Nov 2026 (W9) and nothing enforced them: a PR could list a green step as unbuilt,
 * and the journeys run, which reads the list for its verdict (setup step 3 of the factory's pilot), would then call a
 * broken step expected. The pilot's stop S2 names exactly that: "a step that passed on main put on the list".
 *
 * WHAT IT CANNOT SEE (read this before trusting it)
 *
 * - Runs before the base's named run. A step the PR adds that was skipped or absent in the base's run (a new test, or
 *   one an earlier failing step stopped) is judged on the runs read only; a pass in an older run is invisible here. The
 *   output names every such step under "not seen before run <n>", and the journeys verdict and the reader in the
 *   planning repo (`ready`) read the full history.
 * - A run whose report is gone (the artifact expired or was never written) fails closed for an added `unbuilt` entry:
 *   the guard can't rule out a pass there.
 * - `money`, `regression` entries and their issues' state lines: the journeys verdict and the reader check those.
 * - Who wrote the PR. Like the gate-file guard, this is about what changes, not who changes it.
 *
 * WHERE IT RUNS: the `gates` job of ci.yml (Doctrine gates, which the CI merge seal needs), on pull requests, from
 * main's copy of this file in a worktree, so a PR can't loosen the rule it is judged by. It reads the base's baseline
 * from origin/main and the PR's from the checkout. It does nothing when the PR leaves the baseline unchanged.
 *
 * Usage:
 *   node tooling/ci/journey-baseline-guard.mjs [--repo owner/name] [--base-ref origin/main]
 *   node tooling/ci/journey-baseline-guard.mjs --base-file a.json --head-file b.json --journeys-file journeys.json \
 *     --runs-file runs.json [--report <run number>=<report.json>]... [--contains <sha>@<run number>=yes|no]...
 *     [--commit-files <sha>=<a JSON list of the files that commit changes>]...   (offline)
 * Exit 0 = pass, 1 = refused, 2 = usage or lookup error, 3 = GitHub refused (stop, no retry).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepStates, JOURNEYS_ARTIFACT } from './post-merge-trust.mjs';
import { GitHubRefusalError, makeGh, ghJson } from '../scripts/gate-gh.mjs';

export const BASELINE_PATH = 'docs/runbooks/journey-baseline.json';
export const JOURNEYS_PATH = 'docs/roadmap/journeys.json';
export const JOURNEYS_WORKFLOW_PATH = '.github/workflows/real-app-journeys.yml';
const FULL_SHA = /^[0-9a-f]{40}$/;
const PRODUCT_ROOTS = /^(apps|services|packages)\//;
const TEST_PATH = [/(^|\/)(test|tests|__tests__|testing)\//, /\.(test|spec)\.[^/]*$/, /\.pw\.mjs$/, /\.journey\.ts$/];
/** Product code, as the runbook defines it ("Test ahead of code", item 2). */
export const isProductCode = (f) => PRODUCT_ROOTS.test(f) && !TEST_PATH.some((re) => re.test(f));
const byStep = (list) => new Map((list ?? []).map((e) => [e.step, e]));
const sortSteps = (keys) => [...keys].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

/** The live step keys in a journeys.json (`J-<module>-NN#<n>`): not deferred, as roadmap.mjs liveJourneys reads it. */
export function liveSteps(journeys) {
  const list = Array.isArray(journeys) ? journeys : [];
  return new Set(list.filter((j) => !j.deferred).flatMap((j) => (j.steps ?? []).filter((s) => !s.deferred).map((s) => `${j.id}#${s.n}`)));
}

/**
 * Is `run` a finished Real-app journeys run on main, as rule 1 asks? `meta` is GitHub's run object for `run.id`.
 * Returns null when it is, or why not.
 */
export function namedRunProblem(run, meta) {
  if (!meta) return `run ${run?.number} (id ${run?.id}) couldn't be read`;
  if (meta.path && meta.path !== JOURNEYS_WORKFLOW_PATH) return `run id ${run.id} is not a Real-app journeys run (${meta.path})`;
  if (meta.head_branch !== 'main') return `run ${run.number} ran on ${meta.head_branch}, not main`;
  if (meta.event === 'pull_request') return `run ${run.number} is a pull request run`;
  if (meta.status !== 'completed') return `run ${run.number} has not finished (${meta.status})`;
  if (['cancelled', 'skipped'].includes(meta.conclusion)) return `run ${run.number} was ${meta.conclusion}`;
  if (meta.run_number !== run.number) return `run id ${run.id} is run ${meta.run_number}, not ${run.number}`;
  if (meta.head_sha !== run.sha) return `run ${run.number} ran ${meta.head_sha}, not ${run.sha}`;
  return null;
}

/**
 * The verdict on one baseline change. Pure: every read is passed in.
 *   base, head   the baseline on main and in the PR (parsed)
 *   live         liveSteps() of the PR's journeys.json
 *   headRunMeta  GitHub's run object for head.run.id (only read when the PR changes `run`)
 *   runs         the finished, uncancelled runs on main from base.run.number to head.run.number, oldest first:
 *                [{ number, id, head_sha }]
 *   reports      Map<run number, Map<step, 'passed'|'failed'|'skipped'> | null>  (null: the report is gone)
 *   contains     (sha, runNumber) => true | false | undefined: does that run's commit contain sha?
 *   commitFiles  (sha) => [file] | undefined: the files a commit changes
 * Returns { ok, problems: [{ step?, why }], notes: [string] }.
 */
export function judgeBaselineChange({
  base,
  head,
  live,
  headRunMeta,
  runs,
  reports,
  contains = () => undefined,
  commitFiles = () => undefined,
}) {
  const problems = [];
  const notes = [];
  const no = (why, step) => problems.push(step ? { step, why } : { why });
  const baseRun = base?.run?.number;
  const headRun = head?.run?.number;
  if (!Number.isInteger(headRun) || !head?.run?.id || !FULL_SHA.test(String(head?.run?.sha)))
    no('the baseline names no run (number, id and full sha)');
  const runChanged = JSON.stringify(base?.run) !== JSON.stringify(head?.run);
  if (runChanged && Number.isInteger(headRun)) {
    if (Number.isInteger(baseRun) && headRun < baseRun) no(`the baseline moves back from run ${baseRun} to run ${headRun}`);
    const why = namedRunProblem(head.run, headRunMeta);
    if (why) no(`the baseline is rewritten from ${why}; rule 1 needs a finished run on main`);
  }

  // What the runs read say about each step: the runs it passed in, and the runs whose report is gone.
  const passedIn = new Map();
  const gone = [];
  for (const r of runs) {
    const states = reports.get(r.number);
    if (states === null || states === undefined) {
      gone.push(r.number);
      continue;
    }
    for (const [step, s] of states) if (s === 'passed') passedIn.set(step, [...(passedIn.get(step) ?? []), r.number]);
  }
  const baseStates = reports.get(baseRun);
  const headStates = reports.get(headRun);

  const before = byStep(base?.steps);
  const after = byStep(head?.steps);
  const notBaselined = byStep(base?.notBaselined);
  const unseen = [];
  for (const [step, e] of after) {
    const was = before.get(step);
    if (e.state !== 'unbuilt' || was?.state === 'unbuilt') continue;
    // Rule 2: added as unbuilt, or turned into unbuilt.
    const what = was ? `turned from ${was.state} into unbuilt` : 'added as unbuilt';
    let passes = passedIn.get(step) ?? [];
    if (e.strengthenedBy !== undefined) {
      const c = String(e.strengthenedBy);
      if (!FULL_SHA.test(c)) {
        no(`${what} after a stricter test, but strengthenedBy "${c}" is not a full sha`, step);
        continue;
      }
      const missing = ['blocker', 'lane', 'lastPassedRun'].filter((k) => e[k] === undefined || e[k] === '');
      if (missing.length) no(`${what} after a stricter test, without ${missing.join(', ')}`, step);
      const files = commitFiles(c);
      if (files === undefined) no(`${what} after commit ${c.slice(0, 7)}, whose files couldn't be read`, step);
      else {
        if (!files.includes(e.file)) no(`${what} after commit ${c.slice(0, 7)}, which doesn't change the step's file ${e.file}`, step);
        const product = files.filter(isProductCode);
        const p = e.priorTestProof;
        if (product.length && !(p?.mainSha && p?.command && p?.log))
          no(
            `${what} after commit ${c.slice(0, 7)}, which changes product code (${product.slice(0, 3).join(', ')}), without a full priorTestProof`,
            step,
          );
      }
      // Only a pass of the stricter test counts: a run whose commit contains strengthenedBy.
      const kept = [];
      for (const n of passes) {
        const has = contains(c, n);
        if (has === undefined)
          no(`${what} after commit ${c.slice(0, 7)}, but whether run ${n} (where it passed) has that commit couldn't be read`, step);
        else if (has) kept.push(n);
      }
      passes = kept;
    } else {
      // What the files themselves record of a pass before the runs read: a regression passed on main by definition, and
      // the base's notBaselined and the entry's own lastPassedRun name a run it passed in.
      const nb = notBaselined.get(step);
      if (was?.state === 'regression') no(`${what}, but a regression entry passed on main before (issue #${was.issue ?? '?'})`, step);
      else if (nb) no(`${what}, but the base lists it in notBaselined: it passed on main in run ${nb.lastPassedRun ?? '?'}`, step);
      else if (e.lastPassedRun !== undefined) no(`${what}, but its own entry says it passed on main in run ${e.lastPassedRun}`, step);
    }
    if (passes.length) no(`${what}, but it passed on main in run ${passes.join(', ')}`, step);
    else if (gone.length) no(`${what}, but run ${gone.join(', ')} has no report, so a pass there can't be ruled out`, step);
    if (!baseStates?.has(step) || baseStates.get(step) === 'skipped') unseen.push(step);
  }
  for (const [step, e] of before) {
    if (after.has(step)) continue;
    // Rule 3: only a pass on main takes a step off.
    const passes = (passedIn.get(step) ?? []).filter((n) => n > baseRun);
    if (passes.length) continue;
    if (!live.has(step)) {
      notes.push(`${step} leaves the baseline as retired: it is no longer in ${JOURNEYS_PATH}`);
      continue;
    }
    const now = headStates?.get(step) ?? 'missing';
    no(`removed from the baseline (was ${e.state}) without a pass on main after run ${baseRun}: it is ${now} in run ${headRun}`, step);
  }
  if (unseen.length)
    notes.push(`not seen before run ${baseRun} (skipped or absent there, so older runs weren't read): ${sortSteps(unseen).join(', ')}`);
  return { ok: problems.length === 0, problems, notes };
}

export function render(result, { baseRun, headRun, changed }) {
  if (!changed) return `Journey baseline guard: OK. The PR doesn't change ${BASELINE_PATH}.`;
  const lines = [`Journey baseline guard: ${result.ok ? 'OK' : 'REFUSED'}. ${BASELINE_PATH} goes from run ${baseRun} to run ${headRun}.`];
  for (const p of result.problems) lines.push(`- ${p.step ? `${p.step}: ` : ''}${p.why}`);
  for (const n of result.notes) lines.push(`- note: ${n}`);
  if (!result.ok)
    lines.push(
      '',
      'Rule: docs/runbooks/regression-issue-state.md, "The journeys baseline". A step that has passed on main is never added as unbuilt; only a pass on main takes a step off; the file is rewritten from a finished run on main it names.',
    );
  return lines.join('\n');
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The finished, uncancelled Real-app journeys runs on main numbered from..to, oldest first. Pages back from the newest. */
export function listRuns(gh, repo, from, to, maxPages = 30) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const got = ghJson(gh, [
      'api',
      `repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=completed&per_page=100&page=${page}`,
    ]);
    const runs = got.workflow_runs ?? [];
    for (const r of runs) {
      if (r.run_number < from || r.run_number > to || r.head_branch !== 'main' || r.event === 'pull_request') continue;
      if (['cancelled', 'skipped'].includes(r.conclusion)) continue;
      out.push({ number: r.run_number, id: r.id, head_sha: r.head_sha });
    }
    if (!runs.length || runs.at(-1).run_number <= from) return out.sort((a, b) => a.number - b.number);
  }
  throw new Error(`run ${from} is more than ${maxPages} pages of runs back; read fewer runs or raise maxPages`);
}

/** One run's step states from its `real-app-journeys` artifact, or null when the report is gone. */
export function readReport(gh, repo, id) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-guard-'));
  try {
    const r = gh(['run', 'download', String(id), '--repo', repo, '--name', JOURNEYS_ARTIFACT, '--dir', dir], { allowFail: true });
    const file = join(dir, 'report.json');
    if (r.status !== 0 || !existsSync(file)) return null;
    return stepStates(JSON.parse(readFileSync(file, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const o = {
    repo: process.env.REPO || process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced',
    baseRef: 'origin/main',
    reports: [],
    contains: [],
    commitFiles: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--base-ref') o.baseRef = argv[++i];
    else if (a === '--base-file') o.baseFile = argv[++i];
    else if (a === '--head-file') o.headFile = argv[++i];
    else if (a === '--journeys-file') o.journeysFile = argv[++i];
    else if (a === '--runs-file') o.runsFile = argv[++i];
    else if (a === '--report') o.reports.push(argv[++i]);
    else if (a === '--contains') o.contains.push(argv[++i]);
    else if (a === '--commit-files') o.commitFiles.push(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  o.offline = Boolean(o.baseFile);
  if (o.offline && !(o.headFile && o.journeysFile && o.runsFile))
    throw new Error('offline needs --base-file, --head-file, --journeys-file and --runs-file');
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`journey-baseline-guard: ${e.message}`);
    return 2;
  }
  try {
    const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
    const baseText = o.offline
      ? readFileSync(o.baseFile, 'utf8')
      : execFileSync('git', ['show', `${o.baseRef}:${BASELINE_PATH}`], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
    const headText = readFileSync(o.offline ? o.headFile : BASELINE_PATH, 'utf8');
    const base = JSON.parse(baseText);
    const head = JSON.parse(headText);
    const changed = baseText !== headText;
    if (!changed) {
      console.log(render(null, { changed }));
      return 0;
    }
    const live = liveSteps(read(o.offline ? o.journeysFile : JOURNEYS_PATH));
    const from = base.run?.number;
    const to = Math.max(from, head.run?.number ?? from);
    let runs, reports, headRunMeta, contains, commitFiles;
    if (o.offline) {
      const listed = read(o.runsFile);
      runs = listed.filter((r) => r.number >= from && r.number <= to).sort((a, b) => a.number - b.number);
      headRunMeta = listed.find((r) => r.id === head.run?.id)?.meta;
      const given = new Map(o.reports.map((s) => s.split('=')).map(([n, f]) => [Number(n), f]));
      reports = new Map(runs.map((r) => [r.number, given.has(r.number) ? stepStates(read(given.get(r.number))) : null]));
      const facts = new Map(o.contains.map((s) => s.split('=')).map(([k, v]) => [k, v === 'yes']));
      contains = (sha, n) => facts.get(`${sha}@${n}`);
      const files = new Map(o.commitFiles.map((x) => x.split('=')).map(([sha, f]) => [sha, read(f)]));
      commitFiles = (sha) => files.get(sha);
    } else {
      const gh = makeGh();
      runs = listRuns(gh, o.repo, from, to);
      headRunMeta =
        JSON.stringify(base.run) === JSON.stringify(head.run)
          ? undefined
          : ghJson(gh, ['api', `repos/${o.repo}/actions/runs/${head.run.id}`]);
      // Only an entry added as unbuilt needs every run in the range; a removal needs a pass after the base's run, which
      // the PR's named run usually shows. So the range is read only when it is needed (a long range costs a minute per
      // 20 to 30 reports, against the gates job's 10-minute limit).
      const needsRange = (head.steps ?? []).some((e) => e.state === 'unbuilt' && byStep(base.steps).get(e.step)?.state !== 'unbuilt');
      const headStates = runs.some((r) => r.number === head.run?.number) ? readReport(gh, o.repo, head.run.id) : undefined;
      reports = new Map(
        runs.map((r) => [r.number, r.number === head.run?.number ? headStates : needsRange ? readReport(gh, o.repo, r.id) : undefined]),
      );
      if (!needsRange) {
        const quick = judgeBaselineChange({
          base,
          head,
          live,
          headRunMeta,
          runs: runs.filter((r) => r.number === head.run?.number),
          reports,
        });
        if (!quick.ok) for (const r of runs) if (!reports.get(r.number)) reports.set(r.number, readReport(gh, o.repo, r.id));
      }
      const shaOf = new Map(runs.map((r) => [r.number, r.head_sha]));
      // GitHub's compare from the commit to the run's head: "ahead" or "identical" means the run has the commit.
      contains = (sha, n) => {
        const r = gh(['api', `repos/${o.repo}/compare/${sha}...${shaOf.get(n)}`, '--jq', '.status'], { allowFail: true });
        const status = r.status === 0 ? r.stdout.trim() : '';
        return status ? ['ahead', 'identical'].includes(status) : undefined;
      };
      // A commit's first 300 files (GitHub's limit on one page); a longer one reads as unreadable, so it fails closed.
      commitFiles = (sha) => {
        const r = gh(['api', `repos/${o.repo}/commits/${sha}`, '--jq', '[.files[].filename]'], { allowFail: true });
        let files;
        try {
          files = r.status === 0 ? JSON.parse(r.stdout) : undefined;
        } catch {
          files = undefined;
        }
        return Array.isArray(files) && files.length < 300 ? files : undefined;
      };
    }
    const result = judgeBaselineChange({ base, head, live, headRunMeta, runs, reports, contains, commitFiles });
    console.log(render(result, { baseRun: from, headRun: head.run?.number, changed }));
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error(`journey-baseline-guard: ${e.message}`);
    return e instanceof GitHubRefusalError ? 3 : 2;
  }
}

// realpath: on macOS /tmp is /private/tmp, so a plain comparison of the two paths never matched there.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exit(await main());
}

#!/usr/bin/env node
/**
 * MERGE GATE: tests are the merge condition, enforced by script (Nitro's choice, 2026-10-13).
 *
 *   node tooling/scripts/merge-gate.mjs <pr> --head <full-sha> [--timeout-min 150] [--poll-sec 30] [--no-comment]
 *
 * It never merges. On PASS it posts a summary comment on the PR and prints the exact merge command; the caller runs
 * that command as its own step. On any failure it exits non-zero and prints why. Run it from a checkout of main, not from
 * the PR's branch: a PR that edits this file is a gate change (see gate-file-guard.mjs) and is flagged as one.
 *
 * WHAT "PASS" MEANS (a ratchet, not a green-main requirement)
 *
 *   1. The PR head is exactly --head, the PR is open, not a draft, and has no merge conflict.
 *   2. Every check on that head has FINISHED (bounded wait; nothing here can hang past --timeout-min).
 *   3. The required checks, Gitleaks and Dependency audit, ran and passed. They run on every PR, docs-only included.
 *   4. The PR adds no failing check that is not ALSO failing on main's latest completed push run of ci.yml that actually
 *      ran jobs (cancelled and superseded runs, 21 of the last 60 in the 2026-10-13 audit, are skipped). Main is red
 *      today, so a failure main already has is not this PR's fault; a failure main does not have is.
 *   5. The PR does not change gate files (tooling/ci, workflows, ...) unless its title says so (gate-file-guard.mjs).
 *
 * Docs-only PRs: ci.yml has a path filter, so a PR that only touches docs/**, *.md, NOTICE or LICENSE gets no CI run at
 * all (and may report no checks beyond the always-on ones). That is a PASS when, and only when, the changed files are
 * all excluded by that filter and the two required checks passed. The verdict says so.
 *
 * Limits of a job-name ratchet: it compares job NAMES. A PR runs only the test shard its files affect ("Tests (money)")
 * while main's push run runs "Tests (full)", so a shard failure is never excused by a red "Tests (full)" on main. That is
 * deliberate (it is how a money regression would hide under a red full suite); set SHARD_EXCUSED_BY_FULL to relax it.
 *
 * Exit codes: 0 pass, 1 gate failed (new failures, missing required check, undeclared gate change, conflict), 2 could not
 * decide (wrong head, timeout, bad arguments, no baseline), 3 GitHub refused with 403/429 (stop, never retried).
 */
import { fileURLToPath } from 'node:url';
import { evaluateGateFileRule, RULE_TEXT } from './gate-file-guard.mjs';
import { GitHubRefusalError, ghJson, makeGh } from './gate-gh.mjs';

export const REPO = 'Phantom-X-007/intafaced';
export const MARKER = '<!-- merge-gate -->';

/** Checks that must run and pass on every PR (branch protection requires the same two). Never excused by main. */
export const REQUIRED = ['Gitleaks', 'Dependency audit'];

/**
 * PR-ONLY JOBS KNOWN TO BE RED. They never run on main, so the ratchet cannot compare them with a main run.
 * An entry is allowed to fail on a PR and is reported in the verdict. Every entry needs a reason and a way out; delete
 * the entry when the job is fixed. This list may only shrink: it is a gate file, so adding to it needs a `ci:` title.
 */
export const KNOWN_PR_ONLY_RED = {
  // Has failed on every PR since 2026-08-24: the harness environment produces NaN. On the heal-main list.
  // Remove this entry when .github/workflows/order-path-cx8.yml is green on a clean PR.
  'CX-8 assembled smoke': 'harness env NaN, red on every PR since 2026-08-24 (heal-main item)',
};

/** If true, a failing shard ("Tests (money)") is excused when "Tests (full)" fails on main. Off: see the header. */
export const SHARD_EXCUSED_BY_FULL = false;
export const SHARDS = ['Tests (protocol)', 'Tests (money)', 'Tests (trade)', 'Tests (pay-bank)'];

/** Mirror of `on.pull_request.paths` in .github/workflows/ci.yml (merge-gate.test.mjs fails if they drift). */
export const CI_PR_PATHS = ['**', '!docs/**', '!**/*.md', '!NOTICE', '!LICENSE', 'INTAFACED_DEFINITIVE_BUILD.md'];
export const CI_WORKFLOW_NAME = 'CI';

const FAIL_BUCKETS = new Set(['fail', 'cancel']);

export class GateError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function pathGlob(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (glob[i] === '*') re += '[^/]*';
    else re += glob[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** GitHub path-filter semantics: patterns in order, the last one that matches decides; the workflow runs if any file is in. */
export function ciWouldRun(files, patterns = CI_PR_PATHS) {
  const compiled = patterns.map((p) => ({ neg: p.startsWith('!'), re: pathGlob(p.replace(/^!/, '')) }));
  return files.some((f) => {
    let included = false;
    for (const p of compiled) if (p.re.test(f)) included = !p.neg;
    return included;
  });
}

/** One entry per check name (a re-run leaves several): keep the latest by completedAt, a pending entry counts as latest. */
export function collapseChecks(checks) {
  const byName = new Map();
  for (const c of checks) {
    const prev = byName.get(c.name);
    const stamp = (x) => (x.completedAt && !x.completedAt.startsWith('0001') ? Date.parse(x.completedAt) : Infinity);
    if (!prev || stamp(c) >= stamp(prev)) byName.set(c.name, c);
  }
  return [...byName.values()];
}

/**
 * Pure verdict.
 * @param {object} i
 * @param {Array<{name:string,bucket:string,workflow?:string,link?:string}>} i.checks collapsed checks of the PR head
 * @param {Set<string>|null} i.mainFailing failing job names on the compared main run (null: no baseline found)
 * @param {Set<string>} i.mainJobs every job name on the compared main run
 * @param {string[]} i.files changed files
 * @param {string} i.title PR title
 * @param {boolean} i.ciPresent a CI workflow run or check exists for this head
 */
export function evaluate({ checks, mainFailing, mainJobs = new Set(), files, title, ciPresent }) {
  const reasons = [];
  const byName = new Map(checks.map((c) => [c.name, c]));
  const required = {};
  for (const name of REQUIRED) {
    const c = byName.get(name);
    required[name] = c ? c.bucket : 'missing';
    if (!c) reasons.push(`required check "${name}" never reported`);
    else if (c.bucket !== 'pass') reasons.push(`required check "${name}" is ${c.bucket}`);
  }

  const failing = checks.filter((c) => FAIL_BUCKETS.has(c.bucket) && !REQUIRED.includes(c.name));
  const excusedOnMain = [];
  const knownRed = [];
  const newFailures = [];
  for (const c of failing) {
    const shardOk = SHARD_EXCUSED_BY_FULL && SHARDS.includes(c.name) && mainFailing?.has('Tests (full)');
    if (mainFailing?.has(c.name) || shardOk) excusedOnMain.push(c);
    else if (c.name in KNOWN_PR_ONLY_RED && !mainJobs.has(c.name)) knownRed.push(c);
    else newFailures.push(c);
  }
  if (newFailures.length) {
    const why = mainFailing === null ? 'no main baseline could be found' : 'not failing on the main run compared';
    reasons.push(`new failing check(s), ${why}: ${newFailures.map((c) => c.name).join(', ')}`);
  }

  let docsOnly = false;
  if (!ciPresent) {
    if (ciWouldRun(files)) reasons.push('CI never started although this PR changes code paths, so its tests did not run');
    else docsOnly = true;
  }

  const gate = evaluateGateFileRule(title, files);
  if (!gate.ok) reasons.push(`changes gate files without saying so in the title: ${gate.gateFiles.map((g) => g.file).join(', ')}`);

  return { pass: reasons.length === 0, reasons, required, excusedOnMain, knownRed, newFailures, docsOnly, gate };
}

/** The latest COMPLETED push run of ci.yml on main that really ran jobs. Cancelled and superseded runs are skipped. */
export async function selectMainRun(gh, repo, { maxCandidates = 12 } = {}) {
  const runs = ghJson(gh, [
    'run',
    'list',
    '-R',
    repo,
    '--branch',
    'main',
    '--workflow',
    'ci.yml',
    '--event',
    'push',
    '--status',
    'completed',
    '-L',
    '30',
    '--json',
    'databaseId,headSha,conclusion,createdAt,url',
  ]);
  let tried = 0;
  for (const run of runs) {
    if (run.conclusion !== 'success' && run.conclusion !== 'failure') continue; // cancelled, skipped, neutral
    if (++tried > maxCandidates) break;
    const jobs = ghJson(gh, ['run', 'view', String(run.databaseId), '-R', repo, '--json', 'jobs']).jobs;
    if (!jobs.some((j) => j.conclusion === 'success' || j.conclusion === 'failure')) continue; // ran no jobs
    return {
      run,
      jobs,
      failing: new Set(jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out').map((j) => j.name)),
      names: new Set(jobs.map((j) => j.name)),
    };
  }
  return null;
}

export function mergeCommand(pr, head, repo = REPO) {
  return `gh pr merge ${pr} --match-head-commit ${head} -R ${repo} --squash`;
}

const link = (c) => (c.link ? `[${c.name}](${c.link})` : c.name);

export function renderComment({ verdict, head, pr, main, checks, evalResult }) {
  const e = evalResult;
  const L = [`${MARKER}`, `**Merge gate: ${verdict}** for head \`${head.slice(0, 10)}\``, ''];
  L.push(`- **Required checks:** ${REQUIRED.map((n) => `${n} ${e.required[n]}`).join(', ')}.`);
  L.push(`- **Checks reported:** ${checks.length}.`);
  if (e.docsOnly) {
    L.push(
      '- **Docs-only PR:** CI is skipped by its path filter, so no tests ran. Passed on the required Gitleaks and Dependency audit checks only.',
    );
  }
  if (main) {
    L.push(
      `- **Compared against:** main CI push run [${main.run.databaseId}](${main.run.url}) at \`${main.run.headSha.slice(0, 10)}\` (${main.run.conclusion}).`,
    );
  } else if (!e.docsOnly) {
    L.push('- **Compared against:** no usable main run found.');
  }
  if (e.excusedOnMain.length)
    L.push(
      `- **Failing here and also failing on main (pre-existing red, not added by this PR):** ${e.excusedOnMain.map(link).join(', ')}.`,
    );
  if (e.knownRed.length) {
    L.push(`- **Known PR-only red, allowed:** ${e.knownRed.map((c) => `${link(c)} (${KNOWN_PR_ONLY_RED[c.name]})`).join('; ')}.`);
  }
  if (e.newFailures.length) L.push(`- **NEW failures (not on main):** ${e.newFailures.map(link).join(', ')}.`);
  if (e.gate.gateFiles.length) {
    L.push(
      `- **Gate files changed:** ${e.gate.gateFiles.map((g) => `\`${g.file}\``).join(', ')}${e.gate.declared ? ' (declared in the title)' : ' (NOT declared)'}.`,
    );
  }
  if (e.reasons.length) L.push('', 'Blocked because:', ...e.reasons.map((r) => `- ${r}`));
  if (verdict === 'PASS') L.push('', `Merge command: \`${mergeCommand(pr, head)}\``);
  return L.join('\n') + '\n';
}

function parseArgs(argv) {
  const o = { repo: REPO, timeoutMin: 150, pollSec: 30, comment: true, ciGraceSec: 300 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--head') o.head = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (a === '--poll-sec') o.pollSec = Number(argv[++i]);
    else if (a === '--ci-grace-sec') o.ciGraceSec = Number(argv[++i]);
    else if (a === '--no-comment') o.comment = false;
    else if (a.startsWith('--')) throw new GateError(`unknown argument: ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1 || !/^\d+$/.test(rest[0])) throw new GateError('usage: merge-gate.mjs <pr-number> --head <full-sha>');
  if (!/^[0-9a-f]{40}$/.test(o.head ?? '')) throw new GateError('--head must be the full 40-character commit sha you reviewed');
  for (const k of ['timeoutMin', 'pollSec', 'ciGraceSec']) if (!(o[k] > 0)) throw new GateError(`${k} must be a positive number`);
  o.pr = Number(rest[0]);
  return o;
}

/**
 * The whole gate, with every side effect injected so tests drive it with fixtures.
 * @returns {Promise<{code:number, verdict:string, evalResult?:object, comment?:string, mergeCommand?:string}>}
 */
export async function runGate(o, { gh, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const { pr, head, repo } = o;
  const viewPr = () =>
    ghJson(gh, ['pr', 'view', String(pr), '-R', repo, '--json', 'number,state,isDraft,headRefOid,baseRefName,title,mergeable,url']);
  const first = viewPr();
  if (first.headRefOid !== head)
    throw new GateError(`PR #${pr} head is ${first.headRefOid}, not the reviewed ${head}. Nothing was checked.`);
  if (first.state !== 'OPEN') throw new GateError(`PR #${pr} is ${first.state}, not OPEN.`);
  if (first.baseRefName !== 'main') throw new GateError(`PR #${pr} targets ${first.baseRefName}, not main.`);
  if (first.isDraft) throw new GateError(`PR #${pr} is a draft.`);
  const title = first.title;

  const files = gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename'])
    .stdout.split('\n')
    .filter(Boolean);
  if (!files.length) throw new GateError(`PR #${pr} lists no changed files.`);

  const start = now();
  const deadline = start + o.timeoutMin * 60_000;
  let stable = 0;
  let ciAbsentSince = null;
  let settled;
  for (;;) {
    const cur = viewPr();
    if (cur.headRefOid !== head)
      throw new GateError(`PR #${pr} head moved to ${cur.headRefOid} while waiting. Re-review and run the gate again.`);
    if (cur.state !== 'OPEN') throw new GateError(`PR #${pr} is ${cur.state}.`);

    const r = gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,state,bucket,workflow,link,completedAt'], { allowFail: true });
    let rawChecks = [];
    if (r.stdout.trim()) rawChecks = JSON.parse(r.stdout);
    else if (!/no checks reported/i.test(r.stderr))
      throw new GateError(`gh pr checks returned nothing (${r.status}): ${r.stderr.trim().slice(0, 300)}`);
    const checks = collapseChecks(rawChecks);
    const runs = ghJson(gh, [
      'run',
      'list',
      '-R',
      repo,
      '--commit',
      head,
      '-L',
      '50',
      '--json',
      'databaseId,workflowName,status,conclusion',
    ]);

    const pending = checks.filter((c) => c.bucket === 'pending').map((c) => c.name);
    const active = runs.filter((x) => x.status !== 'completed').map((x) => x.workflowName);
    const missingRequired = REQUIRED.filter((n) => !checks.some((c) => c.name === n));
    const ciPresent = checks.some((c) => c.workflow === CI_WORKFLOW_NAME) || runs.some((x) => x.workflowName === CI_WORKFLOW_NAME);

    let done = !pending.length && !active.length && !missingRequired.length;
    if (done && !ciPresent && ciWouldRun(files)) {
      // CI should exist but has not appeared yet. Give it a grace period, then judge (the verdict will say CI never started).
      ciAbsentSince ??= now();
      if (now() - ciAbsentSince < o.ciGraceSec * 1000) done = false;
    }
    const requiredOverdue = missingRequired.length && now() - start > o.ciGraceSec * 1000;
    stable = done ? stable + 1 : 0;
    if (stable >= 2 || requiredOverdue) {
      settled = { checks, ciPresent, mergeable: cur.mergeable };
      break;
    }
    if (now() > deadline) {
      throw new GateError(
        `checks not finished after ${o.timeoutMin} min. Still pending: ${[...pending, ...active].join(', ') || missingRequired.join(', ') || '(nothing listed)'}`,
      );
    }
    log(
      `waiting: ${pending.length} pending check(s), ${active.length} active run(s), missing required: ${missingRequired.join(', ') || 'none'}`,
    );
    await sleep(o.pollSec * 1000);
  }

  const failingNames = settled.checks.filter((c) => FAIL_BUCKETS.has(c.bucket) && !REQUIRED.includes(c.name));
  let main = null;
  if (settled.ciPresent) {
    main = await selectMainRun(gh, repo);
    if (!main && failingNames.length)
      throw new GateError('no completed main push run of ci.yml with jobs was found, so there is no baseline to compare failures against.');
  }

  const evalResult = evaluate({
    checks: settled.checks,
    mainFailing: main ? main.failing : settled.ciPresent ? null : new Set(),
    mainJobs: main ? main.names : new Set(),
    files,
    title,
    ciPresent: settled.ciPresent,
  });
  if (settled.mergeable === 'CONFLICTING') {
    evalResult.reasons.push('PR has merge conflicts with main');
    evalResult.pass = false;
  }
  const verdict = evalResult.pass ? 'PASS' : 'FAIL';
  let comment = renderComment({ verdict, head, pr, main, checks: settled.checks, evalResult });
  if (evalResult.gate.gateFiles.length && evalResult.gate.declared && evalResult.pass) {
    comment += `\nThis PR changes gate files. Run this gate from a checkout of main, not from this branch. Rule: ${RULE_TEXT}\n`;
  }
  if (o.comment) gh(['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], { input: comment });
  return {
    code: evalResult.pass ? 0 : 1,
    verdict,
    evalResult,
    comment,
    mergeCommand: evalResult.pass ? mergeCommand(pr, head, repo) : undefined,
  };
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    const result = await runGate(o, { gh: makeGh(), log: (m) => console.error(`merge-gate: ${m}`) });
    console.log(result.comment.replace(MARKER, '').trim());
    if (result.mergeCommand) console.log(`\nMERGE COMMAND (run it yourself, as its own step):\n${result.mergeCommand}`);
    else console.error('\nmerge-gate: FAIL. Do not merge.');
    return result.code;
  } catch (e) {
    console.error(`merge-gate: ${e.message}`);
    if (e instanceof GitHubRefusalError) return 3;
    return e instanceof GateError ? e.code : 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}

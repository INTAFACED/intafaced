/**
 * The concurrency shape of .github/workflows/*.yml (2026-11-07): CI drowned in runs for heads that had already been
 * superseded (47 Real-app journeys runs of 36 shards and 48 CI runs queued at 10:54 UTC), and one Journey seal re-check
 * queued per finished journeys run.
 *
 * It holds four rules, each evaluated on the workflow's own `concurrency:` expressions with the event contexts that
 * matter (a tiny evaluator of GitHub's expression syntax below, so a rewrite that keeps the meaning still passes):
 *   1. Every workflow a pull request triggers keeps only the newest run per pull request: its group is one per pull
 *      request and its run cancels the older one (cancel-in-progress true on that event). The exceptions are named in
 *      PR_EXCEPTIONS with the reason a cancel would lose a verdict.
 *   2. A Real-app journeys run on main is never cancelled, and every main run shares one group (OWNER 206).
 *   3. A manual Real-app journeys run on a branch cancels the older run with the same journey selection on that branch,
 *      and never a run of another branch or another selection.
 *   4. Journey seal re-check queues one re-check per pull request head for finished journeys runs, never cancels a
 *      running one, and an event whose job is skipped, a title or body edit, or arming auto-merge, never displaces a
 *      waiting re-check.
 *   5. CI merge seal (INTAFACED/project-state#1574 item 2): a push's or an open's first attempt cancels the older head's
 *      seal (rule 1), and nothing else is ever cancelled or cancels: an edit's or a reopen's seal runs on the head being
 *      merged, and a re-run (run_attempt above 1) keeps its run's own group, so re-running a seal never cancels a newer
 *      head's seal or an older red seal re-run beside it on the same head.
 *   6. Main first (item 3): Real-app journeys holds a run off main back while main's jobs wait for runners, in a step
 *      of the touch job that never runs on main and can't fail the run, inside the job's time limit.
 * Planted faults at the bottom prove each rule fails on the shape it forbids. Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_JOB } from './main-first.mjs';

const DIR = join(process.cwd(), '.github', 'workflows');
const read = (f) => readFileSync(join(DIR, f), 'utf8');

// ---- a minimal reader of the two top-level blocks this test needs -------------------------------------------------

/** The lines of a top-level YAML block (`on:` or `concurrency:`), without comments; null when absent. */
function block(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start < 0) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    out.push(line);
  }
  return out;
}

/** The workflow's trigger names. */
export function triggers(text) {
  return (block(text, 'on') ?? []).filter((l) => /^ {2}[a-z_]+:/.test(l)).map((l) => l.trim().split(':')[0]);
}

/** The top-level concurrency's raw `group` and `cancel-in-progress`, or null. */
export function concurrency(text) {
  const lines = block(text, 'concurrency');
  if (!lines) return null;
  const value = (k) => {
    const line = lines.find((l) => l.trim().startsWith(`${k}:`));
    if (!line) return undefined;
    const v = line
      .trim()
      .slice(k.length + 1)
      .trim();
    return /^'.*'$|^".*"$/.test(v) ? v.slice(1, -1) : v;
  };
  return { group: value('group'), cancel: value('cancel-in-progress') };
}

// ---- a minimal evaluator of GitHub's expression syntax -------------------------------------------------------------

function tokenize(src) {
  const re = /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||[!(),])|([A-Za-z_][A-Za-z0-9_.\-[\]]*)|(-?\d+))/y;
  const out = [];
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read the expression at: ${src.slice(re.lastIndex)}`);
    if (m[1] !== undefined) out.push({ t: 'str', v: m[1].slice(1, -1).replaceAll("''", "'") });
    else if (m[2] !== undefined) out.push({ t: 'op', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
    else out.push({ t: 'num', v: Number(m[4]) });
  }
  return out;
}

const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);
const eq = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null));
const str = (v) => (v === null || v === undefined ? '' : String(v));

export function evaluate(src, ctx) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = (v) => {
    const t = toks[i++];
    if (v !== undefined && t?.v !== v) throw new Error(`expected ${v} in: ${src}`);
    return t;
  };
  const primary = () => {
    const t = take();
    if (!t) throw new Error(`unexpected end of: ${src}`);
    if (t.t === 'op' && t.v === '!') return !truthy(primary());
    if (t.t === 'op' && t.v === '(') {
      const v = or();
      take(')');
      return v;
    }
    if (t.t === 'str' || t.t === 'num') return t.v;
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (peek()?.v === '(') {
        take('(');
        const args = [];
        while (peek()?.v !== ')') {
          args.push(or());
          if (peek()?.v === ',') take(',');
        }
        take(')');
        if (t.v === 'format') return args[0].replace(/\{(\d+)\}/g, (_, n) => str(args[1 + Number(n)]));
        throw new Error(`function ${t.v} is not known to this test`);
      }
      return t.v
        .split(/\.|(?=\[)/)
        .map((k) => k.replace(/^\[(\d+)\]$/, '$1'))
        .reduce((o, k) => (o === null || o === undefined ? null : (o[k] ?? null)), ctx);
    }
    throw new Error(`unexpected ${t.v} in: ${src}`);
  };
  const cmp = () => {
    let l = primary();
    while (peek()?.v === '==' || peek()?.v === '!=') {
      const op = take().v;
      const r = primary();
      l = op === '==' ? eq(l, r) : !eq(l, r);
    }
    return l;
  };
  const and = () => {
    let l = cmp();
    while (peek()?.v === '&&') {
      take();
      const r = cmp();
      l = truthy(l) ? r : l;
    }
    return l;
  };
  const or = () => {
    let l = and();
    while (peek()?.v === '||') {
      take();
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const v = or();
  if (i !== toks.length) throw new Error(`unread tokens in: ${src}`);
  return v;
}

/** A YAML value with `${{ }}` in it, as GitHub would read it: a lone expression keeps its type. */
export function interpolate(raw, ctx) {
  if (raw === undefined) return undefined;
  const lone = raw.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (lone && !lone[1].includes('}}')) return evaluate(lone[1], ctx);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => str(evaluate(e, ctx)));
}

/** The group and cancel-in-progress a run with this context gets. */
export function resolve(text, ctx) {
  const c = concurrency(text);
  if (!c) return null;
  return { group: interpolate(c.group, ctx), cancel: truthy(interpolate(c.cancel, ctx) ?? false) };
}

// ---- event contexts ------------------------------------------------------------------------------------------------

const REPO = 'INTAFACED/intafaced';
const prEvent = (event_name, n, sha, extra = {}) => ({
  github: {
    workflow: 'W',
    repository: REPO,
    event_name,
    run_id: Math.random(),
    run_attempt: extra.attempt ?? '1',
    // pull_request runs on the merge ref; pull_request_target on the base branch.
    ref: event_name === 'pull_request' ? `refs/pull/${n}/merge` : 'refs/heads/main',
    // GitHub sets the pull request's branch on both pull request events.
    head_ref: `branch-${n}`,
    event: {
      action: extra.action ?? 'synchronize',
      changes: extra.changes ?? null,
      pull_request: {
        number: extra.number ?? n,
        head: { sha, ref: `branch-${n}`, repo: { full_name: REPO } },
        base: { ref: 'main' },
      },
    },
  },
  inputs: {},
});

// ---- rule 1: one run per pull request ------------------------------------------------------------------------------

/**
 * Workflows a pull request triggers that don't cancel the older run, and why. Each keeps a bounded number of runs.
 *  - ci-review.yml: a change to the review job can't pass its own review and waits for the owner (intafaced AGENTS.md);
 *    its group is one per head, so an older head's review finishes but a newer one never waits for it.
 *  - journey-seal-recheck.yml: rule 4 below.
 * merge-seal.yml is no exception since INTAFACED/project-state#1574 item 2: a push cancels the older head's seal, and
 * rule 5 below holds that nothing else is cancelled.
 */
export const PR_EXCEPTIONS = new Set(['ci-review.yml', 'journey-seal-recheck.yml']);

/** Problems with rule 1 in one workflow's text, or []. */
export function prProblems(file, text) {
  const on = triggers(text);
  const events = ['pull_request', 'pull_request_target'].filter((e) => on.includes(e));
  if (!events.length || PR_EXCEPTIONS.has(file)) return [];
  if (!concurrency(text)) return [`${file}: a pull request triggers it, but it has no top-level concurrency group`];
  const problems = [];
  for (const e of events) {
    const a1 = resolve(text, prEvent(e, 101, 'aaa'));
    const a2 = resolve(text, prEvent(e, 101, 'bbb'));
    const b = resolve(text, prEvent(e, 202, 'ccc'));
    if (a1.group !== a2.group) problems.push(`${file}: two pushes to one pull request (${e}) land in different groups`);
    if (a1.group === b.group) problems.push(`${file}: two pull requests (${e}) share a group, so one would cancel the other`);
    if (!a2.cancel) problems.push(`${file}: a newer push to a pull request (${e}) doesn't cancel the older run`);
  }
  return problems;
}

// ---- rules 2 and 3: Real-app journeys ------------------------------------------------------------------------------

const journeysRun = (event_name, ref, journeys = '') => ({
  github: { workflow: 'Real-app journeys', repository: REPO, event_name, ref, run_id: Math.random() },
  inputs: { journeys },
});
const MAIN = 'refs/heads/main';

/** Problems with rules 2 and 3 in real-app-journeys.yml's text, or []. */
export function journeysProblems(text) {
  const problems = [];
  if (!concurrency(text)) return ['real-app-journeys.yml has no top-level concurrency group'];
  const mains = ['push', 'schedule', 'workflow_dispatch'].map((e) =>
    resolve(text, journeysRun(e, MAIN, e === 'workflow_dispatch' ? 'J-x.pw.mjs' : '')),
  );
  if (mains.some((m) => m.cancel)) problems.push('a Real-app journeys run on main could cancel the running main run (OWNER 206)');
  if (new Set(mains.map((m) => m.group)).size !== 1) problems.push('main runs of Real-app journeys are not all in one group (OWNER 206)');
  const branch = (j) => resolve(text, journeysRun('workflow_dispatch', 'refs/heads/b1', j));
  if (branch('').group === mains[0].group) problems.push('a branch run shares the main group');
  if (!branch('').cancel) problems.push('a newer manual run on a branch does not cancel the superseded one');
  if (branch('A.pw.mjs').group === branch('B.pw.mjs').group) problems.push('two journey selections on one branch share a group');
  if (branch('').group === resolve(text, journeysRun('workflow_dispatch', 'refs/heads/b2', '')).group)
    problems.push('two branches share a group');
  // A pull request's run (U4 C3) shares its branch's group with a manual full run there, so either replaces the other.
  const pr = resolve(text, {
    github: {
      workflow: 'Real-app journeys',
      repository: REPO,
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'b1',
      run_id: 1,
      event: { pull_request: { draft: false, head: { repo: { full_name: REPO } } } },
    },
    inputs: {},
  });
  if (pr.group !== branch('').group) problems.push("a pull request's run and a manual full run on its branch are in different groups");
  if (!pr.cancel) problems.push('a newer pull request run does not cancel the superseded one');
  // A fork's pull request or a draft runs nothing, in a group of its own, so it never cancels a branch's run (council
  // R1, R2/G2): a fork branch named like this repository's, or a draft push racing a manual run.
  for (const pull of [
    { draft: false, head: { repo: { full_name: 'someone/fork' } } },
    { draft: true, head: { repo: { full_name: REPO } } },
  ]) {
    const other = resolve(text, {
      github: {
        workflow: 'Real-app journeys',
        repository: REPO,
        event_name: 'pull_request',
        ref: 'refs/pull/8/merge',
        head_ref: 'b1',
        run_id: 2,
        event: { pull_request: pull },
      },
      inputs: {},
    });
    if (other.group === branch('').group) problems.push(`a ${pull.draft ? 'draft' : "fork's"} pull request run shares a branch's group`);
  }
  const run = (ref, j) => resolve(text, journeysRun('workflow_dispatch', ref, j)).group;
  if (run('refs/heads/x', 'J-a') === run('refs/heads/x-J', 'a'))
    problems.push('branch `x` with `J-a` and branch `x-J` with `a` share a group: nothing splits the branch from the selection');
  return problems;
}

// ---- rule 4: Journey seal re-check ---------------------------------------------------------------------------------

const finishedJourneys = (head_sha, extra = {}) => ({
  github: {
    workflow: 'Journey seal re-check',
    repository: REPO,
    event_name: 'workflow_run',
    run_id: Math.random(),
    ref: MAIN,
    event: {
      workflow_run: {
        head_sha,
        name: extra.name ?? 'Real-app journeys',
        head_branch: extra.head_branch ?? 'feature',
        head_repository: { full_name: extra.repo ?? REPO },
        pull_requests: 'pr' in extra ? (extra.pr === null ? [] : [{ number: extra.pr }]) : [{ number: 101 }],
      },
    },
  },
  inputs: {},
});

/** Problems with rule 4 in journey-seal-recheck.yml's text, or []. */
export function recheckProblems(text) {
  if (!concurrency(text)) return ['Journey seal re-check has no concurrency group, so every finished journeys run queues its own re-check'];
  const problems = [];
  const a1 = resolve(text, finishedJourneys('aaa'));
  const a2 = resolve(text, finishedJourneys('bbb'));
  if (a1.group !== a2.group) problems.push('two finished journeys runs on one pull request queue two re-checks');
  if (!a2.cancel) problems.push("a newer finished run doesn't cancel its pull request's older re-check");
  if (a1.group === resolve(text, finishedJourneys('aaa', { pr: 202 })).group) problems.push('re-checks of two pull requests share a group');
  if (a1.group === resolve(text, finishedJourneys('aaa', { name: 'CI' })).group)
    problems.push('a CI re-check and a journeys re-check of one pull request share a group, so one would cancel the other');
  // A finished run that names no pull request: one group per head, never cancelled.
  const n1 = resolve(text, finishedJourneys('aaa', { pr: null }));
  const n2 = resolve(text, finishedJourneys('aaa', { pr: null }));
  if (n1.group !== n2.group) problems.push('two finished runs on one head that name no pull request queue two re-checks');
  if (n1.group === resolve(text, finishedJourneys('bbb', { pr: null })).group) problems.push('re-checks of two heads share a group');
  if (n1.cancel) problems.push('a re-check of a head no pull request is named on could be cancelled');
  // Events whose job is skipped, edits (whose old title the script reads) and arming each get a group of their own.
  const others = [
    finishedJourneys('aaa', { head_branch: 'main' }),
    finishedJourneys('aaa', { repo: 'fork/intafaced' }),
    prEvent('pull_request_target', 101, 'aaa', { action: 'edited', changes: { title: { from: 'J-x #1' } } }),
    prEvent('pull_request_target', 101, 'aaa', { action: 'edited', changes: { base: { ref: { from: 'x' } } } }),
    prEvent('pull_request_target', 101, 'aaa', { action: 'auto_merge_enabled' }),
  ];
  for (const ctx of others) {
    const r = resolve(text, ctx);
    const again = resolve(text, { ...ctx, github: { ...ctx.github, run_id: Math.random() } });
    if (r.group === a1.group || r.group === n1.group || r.group === again.group || r.cancel)
      problems.push(
        `a ${ctx.github.event_name} event (${JSON.stringify(ctx.github.event.changes ?? ctx.github.event.workflow_run)}) could displace or cancel a re-check`,
      );
  }
  return problems;
}

// ---- rule 5: CI merge seal ----------------------------------------------------------------------------------------

/** Problems with rule 5 in merge-seal.yml's text, or []. */
export function sealProblems(text) {
  if (!concurrency(text)) return ['merge-seal.yml has no top-level concurrency group'];
  const problems = [];
  const at = (sha, extra) => resolve(text, prEvent('pull_request_target', 101, sha, extra));
  const opened = at('aaa', { action: 'opened' });
  const pushed = at('bbb', { action: 'synchronize' });
  if (opened.group !== pushed.group || !pushed.cancel) problems.push("a push doesn't cancel the seal of the head it replaced");
  if (pushed.group === at('ccc', { action: 'synchronize', number: 202 }).group) problems.push('two pull requests share a group');
  // Runs on the head being merged: an edit or a reopen joins the pull request's group (a newer one replaces it while it
  // waits, before it has a job) but never cancels a running seal; a re-run is in no group a push or an open cancels in.
  const onHead = {
    'an edit': at('bbb', { action: 'edited', changes: { title: { from: 'x' } } }),
    'a base change': at('bbb', { action: 'edited', changes: { base: { ref: { from: 'x' } } } }),
    'a reopen': at('bbb', { action: 'reopened' }),
  };
  for (const [what, r] of Object.entries(onHead)) {
    if (r.cancel) problems.push(`${what} cancels a running seal on the head being merged`);
    if (r.group !== pushed.group) problems.push(`${what} is not in the pull request's group, so its runs pile up on one head`);
  }
  const reruns = {
    "a push's re-run": at('bbb', { action: 'synchronize', attempt: '2' }),
    "an open's re-run": at('aaa', { action: 'opened', attempt: '3' }),
    "an edit's re-run": at('bbb', { action: 'edited', attempt: '2' }),
  };
  for (const [what, r] of Object.entries(reruns)) {
    if (r.cancel) problems.push(`${what} cancels another seal`);
    if (r.group === pushed.group) problems.push(`${what} shares the pull request's group, so a push or an open could cancel it`);
  }
  return problems;
}

// ---- rule 6: main first --------------------------------------------------------------------------------------------

/** The text of one job of a workflow (from its key to the next job key), or ''. */
function job(text, key) {
  const start = text.indexOf(`\n  ${key}:\n`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The text of one step of a job, from its `- name:` to the next step, or ''. */
function step(jobText, name) {
  const start = jobText.indexOf(`      - name: ${name}\n`);
  if (start < 0) return '';
  const rest = jobText.slice(start);
  const next = rest.slice(1).search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Problems with rule 6 in real-app-journeys.yml's text, or []. */
export function mainFirstProblems(text) {
  const touch = job(text, 'touch');
  const wait = step(touch, "Main's journeys first");
  if (!wait) return ["real-app-journeys.yml's touch job has no step `Main's journeys first`, so branch runs queue ahead of main"];
  const problems = [];
  const cond = /\n {8}if: (.*)\n/.exec(wait)?.[1] ?? '';
  const runsOn = (ref) => cond && evaluate(cond, { github: { ref }, steps: { touch: { outputs: { mode: 'run' } } } });
  if (runsOn(MAIN)) problems.push('the main-first step runs on main, so it could hold a main run');
  if (!runsOn('refs/pull/7/merge') || !runsOn('refs/heads/b1')) problems.push('the main-first step does not run off main');
  if (!/node "\$script"/.test(wait) || !/script=\.base\/tooling\/ci\/main-first\.mjs/.test(wait))
    problems.push("the main-first step does not run the default branch's main-first.mjs");
  if (!/\n {8}continue-on-error: true\n/.test(wait)) problems.push("the main-first step's wait can fail the run");
  const stepLimit = Number(/\n {8}timeout-minutes: (\d+)/.exec(wait)?.[1]);
  const jobLimit = Number(/\n {4}timeout-minutes: (\d+)/.exec(touch)?.[1]);
  if (!(stepLimit >= 31 && jobLimit > stepLimit + 1))
    problems.push(`the touch job's limit (${jobLimit} min) can end the run before the wait's own limit (${stepLimit} min)`);
  if (!new RegExp(`name: ${PLAN_JOB.replace(/[()]/g, '\\$&')}\n`).test(text))
    problems.push(`no job is named "${PLAN_JOB}", the name main-first.mjs reads to know main's shards are queued`);
  return problems;
}

// ---- the workflows on this tree ------------------------------------------------------------------------------------

test('every workflow a pull request triggers keeps only the newest run per pull request (or is a named exception)', () => {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 5, 'no workflows found');
  const covered = files.filter((f) => triggers(read(f)).some((t) => t === 'pull_request' || t === 'pull_request_target'));
  assert.ok(covered.length >= 5, `only ${covered.length} pull-request workflows found: the trigger reader is broken`);
  for (const f of PR_EXCEPTIONS) assert.ok(covered.includes(f), `PR_EXCEPTIONS names ${f}, which no pull request triggers`);
  assert.deepEqual(
    files.flatMap((f) => prProblems(f, read(f))),
    [],
  );
});

test('Real-app journeys: main is never cancelled and shares one group; a superseded branch run is cancelled', () => {
  assert.deepEqual(journeysProblems(read('real-app-journeys.yml')), []);
});

test('CI: a run on main is never cancelled', () => {
  const ci = read('ci.yml');
  for (const e of ['push', 'workflow_dispatch']) assert.equal(resolve(ci, journeysRun(e, MAIN)).cancel, false, e);
});

test('Journey seal re-check: one waiting re-check per head, never a running one cancelled', () => {
  assert.deepEqual(recheckProblems(read('journey-seal-recheck.yml')), []);
});

test("CI merge seal: a push cancels the older head's seal; edits, reopens and re-runs are never cancelled and cancel nothing", () => {
  assert.deepEqual(sealProblems(read('merge-seal.yml')), []);
});

test("Real-app journeys: a run off main waits for main's jobs to get runners, and never fails or holds main", () => {
  assert.deepEqual(mainFirstProblems(read('real-app-journeys.yml')), []);
});

// ---- planted faults ------------------------------------------------------------------------------------------------

const drop = (text) => text.replace(/^concurrency:\n(?:[ #].*\n|\n)*/m, '');

test('planted: a pull-request workflow without its concurrency group fails rule 1', () => {
  assert.ok(concurrency(read('look-gate.yml')), 'look-gate.yml has a group to remove');
  assert.match(prProblems('look-gate.yml', drop(read('look-gate.yml')))[0], /no top-level concurrency group/);
});

test('planted: a pull-request workflow that never cancels, or keys on the base ref, fails rule 1', () => {
  const t = read('gate-file-guard.yml');
  assert.match(
    prProblems('gate-file-guard.yml', t.replace('cancel-in-progress: true', 'cancel-in-progress: false')).join(),
    /doesn't cancel/,
  );
  const target = `on:\n  pull_request_target:\n\nconcurrency:\n  group: x-\${{ github.ref }}\n  cancel-in-progress: true\n`;
  assert.match(prProblems('x.yml', target).join(), /share a group/);
});

test('planted: a main journeys run that could be cancelled fails rule 2', () => {
  const t = read('real-app-journeys.yml');
  const c = concurrency(t);
  const planted = t.replace(`cancel-in-progress: ${c.cancel}`, 'cancel-in-progress: true');
  assert.notEqual(planted, t);
  assert.ok(journeysProblems(planted).some((p) => /OWNER 206/.test(p)));
});

test("planted: today's branch rule (a newer branch run waits) and a missing selection key fail rule 3", () => {
  const t = read('real-app-journeys.yml');
  const c = concurrency(t);
  const waits = t.replace(`cancel-in-progress: ${c.cancel}`, 'cancel-in-progress: false');
  assert.ok(journeysProblems(waits).some((p) => /does not cancel the superseded/.test(p)));
  const noInput = t.replace(
    c.group,
    "${{ github.ref == 'refs/heads/main' && 'real-app-journeys-main' || format('real-app-journeys-{0}', github.ref) }}",
  );
  assert.ok(journeysProblems(noInput).some((p) => /selections/.test(p)));
});

test("planted: today's re-check (no group) and a group edits share fail rule 4", () => {
  const t = read('journey-seal-recheck.yml');
  assert.match(recheckProblems(drop(t))[0], /no concurrency group/);
  const shared = t.replace(
    concurrency(t).group,
    'journey-seal-recheck-${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha }}',
  );
  assert.ok(recheckProblems(shared).some((p) => /displace/.test(p)));
  const c = concurrency(t);
  const always = t.replace(`cancel-in-progress: ${c.cancel}`, 'cancel-in-progress: true');
  assert.notEqual(always, t);
  assert.ok(recheckProblems(always).some((p) => /no pull request is named on could be cancelled/.test(p)));
  assert.ok(recheckProblems(always).some((p) => /displace or cancel/.test(p)));
  const never = t.replace(`cancel-in-progress: ${c.cancel}`, 'cancel-in-progress: false');
  assert.ok(recheckProblems(never).some((p) => /doesn't cancel its pull request's older re-check/.test(p)));
  const noName = t.replace(
    ', github.event.workflow_run.pull_requests[0].number, github.event.workflow_run.name)',
    ", github.event.workflow_run.pull_requests[0].number, 'x')",
  );
  assert.notEqual(noName, t);
  assert.ok(recheckProblems(noName).some((p) => /CI re-check and a journeys re-check/.test(p)));
});

test('the evaluator reads the expressions it is used on', () => {
  assert.equal(
    evaluate("github.ref == 'refs/heads/main' && 'm' || format('b-{0}', github.ref)", { github: { ref: 'refs/heads/x' } }),
    'b-refs/heads/x',
  );
  assert.equal(evaluate("github.ref != 'refs/heads/main'", { github: { ref: 'refs/heads/main' } }), false);
  assert.equal(evaluate('!(a.b)', { a: { b: '' } }), true);
  assert.equal(interpolate('g-${{ a }}-${{ b.c }}', { a: 1, b: { c: 'z' } }), 'g-1-z');
});

test('planted: branch `x` + `J-a` and branch `x-J` + `a` in one group fail rule 3', () => {
  const t = read('real-app-journeys.yml');
  const dash = t.replace("format('real-app-journeys-{0}:{1}'", "format('real-app-journeys-{0}-{1}'");
  assert.notEqual(dash, t);
  assert.ok(journeysProblems(dash).some((p) => /share a group: nothing splits/.test(p)));
});

test("planted: yesterday's seal (never cancelled), and one where every run joins the pull request's group, fail rules 1 and 5", () => {
  const t = read('merge-seal.yml');
  const c = concurrency(t);
  const old = t.replace(c.group, 'merge-seal-${{ github.run_id }}').replace(`cancel-in-progress: ${c.cancel}`, 'cancel-in-progress: false');
  assert.notEqual(old, t);
  assert.match(prProblems('merge-seal.yml', old).join(), /doesn't cancel/);
  assert.ok(sealProblems(old).some((p) => /a push doesn't cancel/.test(p)));
  const all = t
    .replace(c.group, 'merge-seal-pr-${{ github.event.pull_request.number }}')
    .replace(`cancel-in-progress: ${c.cancel}`, 'cancel-in-progress: true');
  const p = sealProblems(all);
  for (const what of ['an edit', 'a reopen', "a push's re-run"])
    assert.ok(
      p.some((x) => x.startsWith(`${what} `)),
      `${what}: ${p}`,
    );
  // Keyed on the event alone (no run_attempt), a re-run of an old head's push joins the group and cancels the new head's seal.
  const noAttempt = t.replaceAll("github.run_attempt == '1' && ", '');
  assert.notEqual(noAttempt, t);
  assert.ok(sealProblems(noAttempt).some((x) => x.startsWith("a push's re-run ")));
});

test('planted: a main-first step that runs on main, can fail the run, outlives its job, or reads a renamed planner, fails rule 6', () => {
  const t = read('real-app-journeys.yml');
  const onMain = t.replace(
    "if: github.ref != 'refs/heads/main' && steps.touch.outputs.mode == 'run'",
    "if: steps.touch.outputs.mode == 'run'",
  );
  assert.notEqual(onMain, t);
  assert.ok(mainFirstProblems(onMain).some((p) => /runs on main/.test(p)));
  const hard = t.replace(/(- name: Main's journeys first\n(?: {8}.*\n)*?) {8}continue-on-error: true\n/, '$1');
  assert.notEqual(hard, t);
  assert.ok(mainFirstProblems(hard).some((p) => /can fail the run/.test(p)));
  const short = t.replace(/(\n  touch:\n(?: {4}.*\n)*? {4})timeout-minutes: \d+/, '$1timeout-minutes: 5');
  assert.notEqual(short, t);
  assert.ok(mainFirstProblems(short).some((p) => /can end the run/.test(p)));
  const renamed = t.replace('name: Plan the shards\n', 'name: Plan shards\n');
  assert.notEqual(renamed, t);
  assert.ok(mainFirstProblems(renamed).some((p) => /Plan the shards/.test(p)));
  assert.match(mainFirstProblems(t.replace("- name: Main's journeys first", '- name: Something else'))[0], /no step/);
});

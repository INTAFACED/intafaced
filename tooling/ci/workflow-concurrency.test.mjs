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
 *      running one, and an event whose job is skipped, or a title or body edit, never displaces a waiting re-check.
 * Planted faults at the bottom prove each rule fails on the shape it forbids. Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  const re = /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||[!(),])|([A-Za-z_][A-Za-z0-9_.-]*)|(-?\d+))/y;
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
      return t.v.split('.').reduce((o, k) => (o === null || o === undefined ? null : (o[k] ?? null)), ctx);
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
    // pull_request runs on the merge ref; pull_request_target on the base branch.
    ref: event_name === 'pull_request' ? `refs/pull/${n}/merge` : 'refs/heads/main',
    // GitHub sets the pull request's branch on both pull request events.
    head_ref: `branch-${n}`,
    event: {
      action: extra.action ?? 'synchronize',
      changes: extra.changes ?? null,
      pull_request: { number: n, head: { sha, ref: `branch-${n}`, repo: { full_name: REPO } }, base: { ref: 'main' } },
    },
  },
  inputs: {},
});

// ---- rule 1: one run per pull request ------------------------------------------------------------------------------

/**
 * Workflows a pull request triggers that don't cancel the older run, and why. Each keeps a bounded number of runs.
 *  - ci-review.yml: a change to the review job can't pass its own review and waits for the owner (intafaced AGENTS.md);
 *    its group is one per head, so an older head's review finishes but a newer one never waits for it.
 *  - review-signoff.yml: GitHub keeps one pending run per group, so a group would drop a queued sign-off; one run per
 *    push or sign-off comment, seconds each.
 *  - journey-seal-recheck.yml: rule 4 below.
 */
export const PR_EXCEPTIONS = new Set(['ci-review.yml', 'review-signoff.yml', 'journey-seal-recheck.yml']);

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
    },
    inputs: {},
  });
  if (pr.group !== branch('').group) problems.push("a pull request's run and a manual full run on its branch are in different groups");
  if (!pr.cancel) problems.push('a newer pull request run does not cancel the superseded one');
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
      workflow_run: { head_sha, head_branch: extra.head_branch ?? 'feature', head_repository: { full_name: extra.repo ?? REPO } },
    },
  },
  inputs: {},
});

/** Problems with rule 4 in journey-seal-recheck.yml's text, or []. */
export function recheckProblems(text) {
  if (!concurrency(text)) return ['Journey seal re-check has no concurrency group, so every finished journeys run queues its own re-check'];
  const problems = [];
  const a1 = resolve(text, finishedJourneys('aaa'));
  const a2 = resolve(text, finishedJourneys('aaa'));
  if (a1.group !== a2.group) problems.push('two finished journeys runs on one head queue two re-checks');
  if (a1.group === resolve(text, finishedJourneys('bbb')).group) problems.push('re-checks of two heads share a group');
  if (a1.cancel) problems.push('a re-check waiting out a running seal could be cancelled');
  // Events whose job is skipped, and edits (whose old title the script reads), each get a group of their own.
  const others = [
    finishedJourneys('aaa', { head_branch: 'main' }),
    finishedJourneys('aaa', { repo: 'fork/intafaced' }),
    prEvent('pull_request_target', 101, 'aaa', { action: 'edited', changes: { title: { from: 'J-x #1' } } }),
    prEvent('pull_request_target', 101, 'aaa', { action: 'edited', changes: { base: { ref: { from: 'x' } } } }),
  ];
  for (const ctx of others) {
    const r = resolve(text, ctx);
    const again = resolve(text, { ...ctx, github: { ...ctx.github, run_id: Math.random() } });
    if (r.group === a1.group || r.group === again.group)
      problems.push(
        `a ${ctx.github.event_name} event (${JSON.stringify(ctx.github.event.changes ?? ctx.github.event.workflow_run)}) could displace a waiting re-check`,
      );
  }
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
  const cancels = t.replace('cancel-in-progress: false', 'cancel-in-progress: true');
  assert.ok(recheckProblems(cancels).some((p) => /could be cancelled/.test(p)));
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

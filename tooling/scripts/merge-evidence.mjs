/**
 * Head-bound merge-result / main-tip evidence for non-required checks. No recent-main window.
 *
 * PR body/comment declaration (one per check, plain line):
 * Inherited-Failure: CI/Tests (full) | owner=@team | evidence=https://.../issues/123
 * The declaration is accountability, never evidence by itself. GitHub run/job logs
 * must independently prove the same complete failure at the tested main tip and bound merge result.
 * Environmental failures remain blocked: a stopped runner does not prove tests ran.
 */
import { ghJson } from './gate-gh.mjs';
import { isProtectedPath } from './merge-review.mjs';
import { FULL_TRIGGERS, SHARDS } from '../ci/ci-affected.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REQUIRED = new Set(['Gitleaks/Gitleaks', 'Supply chain/Dependency audit']);
const SHA = /^[0-9a-f]{40}$/;
const keyOf = (c) => `${c.workflow ?? ''}/${c.name}`;
const isFailed = (c) =>
  ['fail', 'cancel'].includes(c.bucket) ||
  ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale'].includes(c.conclusion ?? c.state?.toLowerCase());
const completed = (j) => j.status === 'completed';

/** No execution or evaluation of declarations. Duplicate/ambiguous declarations fail closed. */
export function parseInheritedDeclarations(input) {
  const found = new Map();
  let fence;
  for (const line of (Array.isArray(input) ? input.join('\n') : String(input ?? '')).split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^Inherited-Failure: (.+?) \| owner=([^|\s][^|]*?) \| evidence=(https:\/\/\S+)\s*$/.exec(line);
    if (!m) continue;
    const declaration = { check: m[1], owner: m[2].trim(), evidence: m[3] };
    try {
      const url = new URL(declaration.evidence);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) continue;
    } catch {
      continue;
    }
    found.set(declaration.check, found.has(declaration.check) ? null : declaration);
  }
  return found;
}

function linesOf(log) {
  return String(log)
    .split(/\r?\n/)
    .map((raw) => {
      const parts = raw.split('\t');
      const step = parts.length >= 3 ? parts[1] : '';
      const text = (parts.length >= 3 ? parts.slice(2).join('\t') : raw)
        .replace(/^\uFEFF/, '')
        .replace(/^\d{4}-\d\d-\d\dT\S+Z\s?/, '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/\^\[\[[0-9;]*m/g, '');
      return { step, text };
    });
}

/** Read checkout's own full SHA, not the workflow-run headSha (PR merge refs differ). */
export function actualCheckoutSha(log) {
  const hashes = [];
  let awaiting = false;
  for (const { step, text } of linesOf(log)) {
    if (!/checkout/i.test(step)) continue;
    if (/\bgit log -1 --format=(?:['"])?%H(?:['"])?\s*$/.test(text)) {
      awaiting = true;
      continue;
    }
    if (awaiting && SHA.test(text.trim())) {
      hashes.push(text.trim());
      awaiting = false;
    }
  }
  return hashes.length === 1 ? hashes[0] : null;
}

const HEADER = /^(?:##\[group\])?((?:@[\w.-]+\/)?[A-Za-z][\w.-]*):test\s*$/;
const PREFIX = /^((?:@[\w.-]+\/)?[A-Za-z][\w.-]*):test: (.*)$/;
const FAIL = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+\.[cm]?[jt]sx?)(?:\s+(>\s.*|\[.*))?\s*$/;
const ERROR = /\b(?:AssertionError|(?:[A-Za-z]+)?Error):/;
const LOCATION = /(?:^|\s|\()(?:\/?(?:[\w@.-]+\/)*[\w.-]+\.[cm]?[jt]sx?):\d+(?::\d+)?(?:\)|\s|$)/;
const BOUNDARY = /^\s*(?:⎯|Test Files\s|Tests\s+\d|Errors\s+\d|Start at\s|Duration\s|Failed:\s|##\[endgroup\])/;

// Totals are part of the proof: a visible failure block alone cannot establish
// that another failing test/file was not omitted from a downloaded log.
function failureSummary(text) {
  const match = /^\s*(Test Files|Tests)\s+(.*?)\s*$/.exec(text);
  if (!match) return undefined;
  if (match[1] === 'Tests' && match[2] === 'no tests') return { type: match[1], failed: 0, passed: 0, skipped: 0, todo: 0, total: 0 };
  const total = /^(.*?)\s+\((\d+)\)$/.exec(match[2]);
  if (!total) return { type: match[1], invalid: true };
  const counts = new Map();
  for (const part of total[1].split(/\s*\|\s*/)) {
    const count = /^(\d+) (failed|passed|skipped|todo)$/.exec(part.trim());
    if (!count || counts.has(count[2]) || !Number.isSafeInteger(Number(count[1]))) return { type: match[1], invalid: true };
    counts.set(count[2], Number(count[1]));
  }
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum) || sum !== Number(total[2])) return { type: match[1], invalid: true };
  return {
    type: match[1],
    failed: counts.get('failed') ?? 0,
    passed: counts.get('passed') ?? 0,
    skipped: counts.get('skipped') ?? 0,
    todo: counts.get('todo') ?? 0,
    total: sum,
  };
}

/** Per-workspace execution is independent of a runner's exit status. */
export function parseTestExecution(log) {
  const tasks = new Map(),
    issues = [];
  let task;
  const record = (name) => {
    if (!tasks.has(name)) tasks.set(name, { summaries: new Map(), tap: new Map(), issues: [] });
    return tasks.get(name);
  };
  for (const { text: raw } of linesOf(log)) {
    const prefix = PREFIX.exec(raw),
      text = prefix ? prefix[2] : raw;
    const header = HEADER.exec(raw);
    if (header) {
      task = `${header[1]}#test`;
      record(task);
      continue;
    }
    const own = prefix ? `${prefix[1]}#test` : task;
    if (/Unhandled (?:Error|Rejection)|^\s*Errors\s+[1-9]/.test(text)) issues.push('unhandled errors make execution incomplete');
    const summary = failureSummary(text);
    const tap = /^\s*(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(text);
    if (summary || tap) {
      if (!own) {
        issues.push('test execution summary has no attributable workspace');
        continue;
      }
      const value = record(own);
      if (summary) {
        if (value.summaries.has(summary.type)) value.issues.push(`duplicate ${summary.type} execution summary`);
        if (summary.invalid) value.issues.push(`invalid ${summary.type} execution summary`);
        value.summaries.set(summary.type, summary);
      } else {
        if (value.tap.has(tap[1])) value.issues.push(`duplicate Node ${tap[1]} summary`);
        if (!Number.isSafeInteger(Number(tap[2]))) value.issues.push('invalid Node execution count');
        value.tap.set(tap[1], Number(tap[2]));
      }
    }
    if (raw.trim() === '##[endgroup]') task = undefined;
  }
  for (const [name, value] of tasks) {
    if (value.summaries.size && value.tap.size) value.issues.push('ambiguous mixed test reporters');
    if (value.summaries.size) {
      value.files = value.summaries.get('Test Files');
      value.tests = value.summaries.get('Tests');
      if (!value.files || !value.tests || value.files.invalid || value.tests.invalid)
        value.issues.push('missing complete file/test execution summaries');
      else if (value.files.passed + value.files.failed < 1 || value.tests.passed + value.tests.failed < 1)
        value.issues.push('no tests actually executed');
    } else if (['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every((key) => value.tap.has(key))) {
      const get = (key) => value.tap.get(key);
      if (
        get('pass') + get('fail') + get('cancelled') + get('skipped') + get('todo') !== get('tests') ||
        get('pass') + get('fail') < 1 ||
        get('cancelled')
      )
        value.issues.push('incomplete Node test execution totals');
      value.tests = { passed: get('pass'), failed: get('fail'), skipped: get('skipped'), todo: get('todo'), total: get('tests') };
    } else value.issues.push('missing attributable test execution summaries');
    value.valid = value.issues.length === 0;
    value.task = name;
  }
  return { tasks, issues };
}

/**
 * Strict vitest summary parser. Signatures include every line of the error block,
 * including assertion diff and source locations. No number/path/random-ID scrubbing.
 * Unknown/orphan failures and missing error/location make the whole log unreadable.
 */
export function parseFailureSignatures(log) {
  const lines = linesOf(log).map((l) => l.text);
  const tasks = new Set();
  for (const line of lines) {
    const m = /^\s*Failed:\s+(.+?)\s*$/.exec(line);
    if (m) for (const t of m[1].split(/,\s*/)) tasks.add(t);
  }
  const failures = [];
  const issues = [];
  const summaries = new Map();
  let task = null;
  let pending = null;
  const finish = () => {
    if (!pending) return;
    const body = pending.body.join('\n').trimEnd();
    if (!pending.task || !tasks.has(pending.task)) issues.push(`failure has no failing task: ${pending.name}`);
    if (!ERROR.test(body)) issues.push(`failure has no error/assertion: ${pending.name}`);
    if (!LOCATION.test(body)) issues.push(`failure has no source location: ${pending.name}`);
    failures.push({
      task: pending.task,
      file: pending.file,
      name: pending.name,
      kind: pending.kind,
      signature: JSON.stringify([pending.task, pending.kind, pending.name, body]),
    });
    pending = null;
  };
  for (const raw of lines) {
    const prefix = PREFIX.exec(raw);
    const text = prefix ? prefix[2] : raw;
    const ownTask = prefix ? `${prefix[1]}#test` : task;
    const header = HEADER.exec(raw);
    if (header && (raw.startsWith('##[group]') || tasks.has(`${header[1]}#test`))) {
      finish();
      task = `${header[1]}#test`;
      continue;
    }
    const m = FAIL.exec(text);
    if (m) {
      finish();
      if (summaries.has(ownTask)) issues.push(`failure follows its task summary: ${ownTask}`);
      pending = {
        task: ownTask,
        file: m[1],
        name: `${m[1]} ${m[2] ?? ''}`.trim(),
        kind: m[2]?.startsWith('>') ? 'test' : 'suite',
        body: [],
      };
      continue;
    }
    const summary = failureSummary(text);
    if (summary) {
      finish();
      if (!ownTask || !tasks.has(ownTask)) {
        if (summary.failed || summary.invalid) issues.push('failed summary has no failing task');
      } else {
        if (!summaries.has(ownTask)) summaries.set(ownTask, new Map());
        const counts = summaries.get(ownTask);
        if (counts.has(summary.type)) issues.push(`duplicate ${summary.type} summary: ${ownTask}`);
        if (summary.invalid) issues.push(`invalid ${summary.type} summary: ${ownTask}`);
        counts.set(summary.type, summary);
      }
      continue;
    }
    if (/^\s*FAIL(?:\s|$)/.test(text)) issues.push(`unparsed FAIL line: ${text.trim()}`);
    if (/Unhandled (?:Error|Rejection)|^\s*Errors\s+[1-9]/.test(text)) issues.push('unhandled errors are not fully attributable');
    if (BOUNDARY.test(text)) finish();
    else if (pending) {
      if (ownTask !== pending.task) issues.push('interleaved failure output');
      pending.body.push(text);
    } else if (ERROR.test(text) && !/^\s*(?:\[command\]|::error|>)/.test(text)) {
      issues.push('error outside a parsed failure block');
    }
    if (text.trim() === '##[endgroup]') task = null;
  }
  finish();
  for (const t of tasks) {
    const parsed = failures.filter((f) => f.task === t);
    if (!parsed.length) issues.push(`task has no complete failure: ${t}`);
    const summary = summaries.get(t);
    if (!summary?.has('Test Files') || !summary?.has('Tests')) issues.push(`task has no complete failed file/test summaries: ${t}`);
    const files = new Set(parsed.map((f) => f.file));
    if (summary?.get('Test Files')?.failed !== files.size) issues.push(`failed file count does not match parsed failures: ${t}`);
    if (summary?.get('Tests')?.failed !== parsed.filter((f) => f.kind === 'test').length)
      issues.push(`failed test count does not match parsed failures: ${t}`);
    const suites = parsed.filter((f) => f.kind === 'suite').map((f) => f.file);
    if (new Set(suites).size !== suites.length || suites.some((file) => parsed.some((f) => f.file === file && f.kind === 'test')))
      issues.push(`inconsistent suite/test failures: ${t}`);
  }
  if (!tasks.size || !failures.length) issues.push('no attributable failures found');
  return { failures, issues, readable: issues.length === 0 };
}

let workspacePaths;
let testWorkspacePaths;
function knownWorkspaces() {
  if (workspacePaths) return workspacePaths;
  workspacePaths = new Map();
  testWorkspacePaths = new Map();
  for (const root of ['apps', 'services', 'packages']) {
    const url = new URL(`../../${root}/`, import.meta.url);
    let entries;
    try {
      entries = readdirSync(fileURLToPath(url), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, url), 'utf8'));
        if (typeof manifest.name !== 'string') continue;
        workspacePaths.set(manifest.name, workspacePaths.has(manifest.name) ? null : `${root}/${entry.name}`);
        if (typeof manifest.scripts?.test === 'string' && manifest.scripts.test.trim())
          testWorkspacePaths.set(manifest.name, testWorkspacePaths.has(manifest.name) ? null : `${root}/${entry.name}`);
      } catch {
        /* Unknown/missing manifest cannot establish provenance. */
      }
    }
  }
  return workspacePaths;
}

/** A task-relative path has known provenance only for an actual local main workspace. */
function protectedFailure(f, workspaceRoots) {
  if (!/^@intafaced\/[\w.-]+#test$/.test(f.task ?? '')) return true;
  const root = (workspaceRoots ?? knownWorkspaces()).get(f.task.slice(0, -'#test'.length));
  if (!root) return true;
  const path = f.file.replace(/^\.\//, '');
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return true;
  if (/^(?:apps|services|packages|tooling)\//.test(path)) return !path.startsWith(`${root}/`) || isProtectedPath(path);
  return isProtectedPath(`${root}/${path}`);
}

function protectedCheck(check, failures, workspaceRoots) {
  return (
    /doctrine|security|gitleaks|secret|dependency audit|money|pay.bank|protocol|trade/i.test(keyOf(check)) ||
    failures.some((f) => protectedFailure(f, workspaceRoots))
  );
}

export const TEST_JOB_POLICY = {
  'Tests (full)': { step: 'Run pnpm test --continue', command: 'pnpm test --continue' },
  'Tests (protocol)': {
    step: 'Protocol package tests',
    command: 'pnpm --no-bail --filter @intafaced/svc-protocol... --filter @intafaced/svc-dex... --filter @intafaced/svc-indexer... test',
    pnpm: true,
  },
  'Tests (money)': {
    step: 'Money package tests',
    command:
      'pnpm --no-bail --filter @intafaced/ledger-client --filter @intafaced/svc-ledger --filter @intafaced/svc-identity --filter @intafaced/svc-token --filter @intafaced/config test',
    pnpm: true,
  },
  'Tests (trade)': {
    step: 'Trade package tests',
    command:
      'pnpm --no-bail --filter @intafaced/svc-trade --filter @intafaced/svc-matching --filter @intafaced/svc-execution --filter @intafaced/venue-adapter --filter @intafaced/svc-ws test',
    pnpm: true,
  },
  'Tests (pay-bank)': {
    step: 'Pay/bank package tests',
    command: 'pnpm turbo run test --filter=@intafaced/svc-pay --filter=@intafaced/svc-bank --filter=@intafaced/svc-p2p --continue',
  },
};

/** pnpm's workspace stream is attributed using main's manifests, never guessed from a test name. */
export function normalizeTestLog(log, jobName, workspaceRoots) {
  if (!TEST_JOB_POLICY[jobName]?.pnpm) return log;
  const names = new Map();
  for (const [name, path] of workspaceRoots ?? knownWorkspaces()) if (path) names.set(path, names.has(path) ? null : name);
  const failed = new Set();
  const normalized = linesOf(log).map(({ text, step }) => {
    const match = /^(\S+) test(?::|\$)\s?(.*)$/.exec(text);
    if (!match) return step ? `job\t${step}\t${text}` : text;
    const name = names.get(match[1]);
    if (!name) return `UNATTRIBUTED WORKSPACE ${text}`;
    if (/^\s*FAIL\b|Unhandled (?:Error|Rejection)/.test(match[2]) || (failureSummary(match[2])?.failed ?? 0) > 0)
      failed.add(`${name}#test`);
    return `${name}:test: ${match[2]}`;
  });
  if (failed.size) normalized.push(`Failed: ${[...failed].join(', ')}`);
  return normalized.join('\n');
}

const inRoot = (file, root) => file === root.replace(/\/$/, '') || file.startsWith(root.endsWith('/') ? root : `${root}/`);
function requiredCoverage(files, roots) {
  const affected = [...roots].filter(([, root]) => root && files.some((file) => inRoot(file, root)));
  const broad = !affected.length || files.some((file) => FULL_TRIGGERS.some((root) => inRoot(file, root)));
  return { broad, tasks: (broad ? [...roots] : affected).map(([name]) => `${name}#test`) };
}
function selectedByJob(name, root, jobName) {
  if (jobName === 'Tests (full)') return true;
  const scope = { 'Tests (protocol)': 'protocol', 'Tests (money)': 'money', 'Tests (trade)': 'trade', 'Tests (pay-bank)': 'paybank' }[
    jobName
  ];
  return (
    (SHARDS[scope] ?? []).some((prefix) => inRoot(root, prefix)) ||
    TEST_JOB_POLICY[jobName]?.command.split(/\s+/).some((word) => word === name || word === `--filter=${name}`)
  );
}

/** Commands, test totals and the actual infrastructure report must all support coverage. */
function testExecutionProof(job, log, files, workspaceRoots) {
  const fail = (problem) => ({ problem });
  const policy = TEST_JOB_POLICY[job?.name];
  if (!policy) return fail('test job has no trusted changed-path coverage policy');
  const step = (job.steps ?? []).filter((s) => s.name === policy.step);
  if (step.length !== 1 || step[0].status !== 'completed' || !['success', 'failure'].includes(step[0].conclusion))
    return fail('the expected test command did not finish');
  if (job.conclusion === 'success' && step[0].conclusion !== 'success') return fail('green job masks a failed test command step');
  const commands = linesOf(log).filter((l) => l.step === policy.step && l.text.startsWith('##[group]Run '));
  if (commands.length !== 1 || commands[0].text !== `##[group]Run ${policy.command}`)
    return fail('job log does not prove the trusted test command');
  const backstops = (job.steps ?? []).filter((s) => s.name === 'Every infrastructure-backed suite actually ran');
  if (backstops.length !== 1 || backstops[0].status !== 'completed' || backstops[0].conclusion !== 'success')
    return fail('no successful infrastructure execution backstop at the exact commit');
  const report = linesOf(log)
    .filter((l) => l.step === 'Every infrastructure-backed suite actually ran')
    .map((l) => l.text)
    .join('\n');
  if (
    !/✓ (?:COMPLETE — every infrastructure-backed suite executed\.|every suite that reports in, ran — and every one of them passed its probe\.)/.test(
      report,
    )
  )
    return fail('infrastructure backstop output is absent or reports unknown execution');
  const execution = parseTestExecution(log),
    roots = workspaceRoots ?? knownWorkspaces();
  if (execution.issues.length) return fail(execution.issues.join('; '));
  // The denominator comes from main's manifests, never from whichever tasks
  // happened to emit output. Fixture maps explicitly supply that same inventory.
  const testRoots = workspaceRoots ?? (knownWorkspaces(), testWorkspacePaths);
  const required = requiredCoverage(files, testRoots);
  if (required.broad && job.name !== 'Tests (full)') return fail('broad changes require full-suite coverage');
  const needed = required.tasks.filter((task) =>
    selectedByJob(task.replace(/#test$/, ''), roots.get(task.replace(/#test$/, '')) ?? '', job.name),
  );
  if (!needed.length) return fail('no attributable test execution output at the exact commit');
  const evidence = [];
  for (const name of needed) {
    const observed = execution.tasks.get(name),
      root = roots.get(name.replace(/#test$/, ''));
    if (!observed?.valid || !root) return fail(`${name}: missing or incomplete workspace execution summary`);
    if (job.conclusion === 'success' && ((observed.tests?.failed ?? 0) || (observed.files?.failed ?? 0)))
      return fail(`${name}: green status conflicts with failed test execution totals`);
    if (
      isProtectedPath(root) &&
      (observed.tests?.skipped ?? 0) + (observed.tests?.todo ?? 0) + (observed.files?.skipped ?? 0) + (observed.files?.todo ?? 0)
    )
      return fail(`${name}: protected tests were skipped or pending`);
    if (isProtectedPath(root) && report.split('\n').some((line) => line.trim().startsWith('· ') && line.includes(`${root}/`)))
      return fail(`${name}: an affected protected suite cannot report whether it executed`);
    evidence.push({ task: name, tests: observed.tests, files: observed.files ?? null });
  }
  return { tasks: evidence };
}

/** Classification describes evidence; allowance separately enforces the invariant policy. */
export function classifyFailure({ check, headJob, baseJob, headLog, baseLog, declaration, coverageProblem, workspaceRoots, files = [] }) {
  const result = (classification, allowed, reason, extra = {}) => ({ check: keyOf(check), classification, allowed, reason, ...extra });
  if (!headJob || !completed(headJob) || !isFailed(headJob))
    return result('unknown', false, 'no finished failing job bound to the head check');
  if (headJob.conclusion === 'startup_failure' && !(headJob.steps ?? []).some((s) => s.status === 'completed'))
    return result('environmental', false, 'GitHub reports runner startup failure; rerun required because tests did not execute');
  if (!baseJob || !completed(baseJob) || !['success', 'failure'].includes(baseJob.conclusion))
    return result('unknown', false, 'no finished comparable job at the exact base');
  if (coverageProblem) return result('unknown', false, coverageProblem);
  if (baseJob.conclusion === 'success')
    return result('introduced', false, 'covered tests passed at the exact base and fail at the exact head');
  const head = parseFailureSignatures(headLog),
    base = parseFailureSignatures(baseLog);
  if (!head.readable || !base.readable)
    return result('unknown', false, `incomplete failure signatures: ${[...head.issues, ...base.issues].join('; ')}`);
  const before = new Map();
  for (const failure of base.failures) before.set(failure.signature, (before.get(failure.signature) ?? 0) + 1);
  const added = head.failures.filter((failure) => {
    const count = before.get(failure.signature) ?? 0;
    if (!count) return true;
    before.set(failure.signature, count - 1);
    return false;
  });
  if (added.length)
    return result('introduced', false, 'failure error/assertion/location or occurrence count differs from the exact base', {
      failures: added,
    });
  if (!declaration) return result('unknown', false, 'identical exact-base failure lacks a unique owner/evidence declaration');
  const inherited = { failures: head.failures, owner: declaration.owner, evidence: declaration.evidence };
  const fullSuite = check.workflow === 'CI' && check.name === 'Tests (full)' && headJob.name === baseJob.name;
  // Main is already red here. A protected workspace is excused only when this PR changes no file in it (D-129a).
  if (fullSuite && failingWorkspacesSubset(head.failures, base.failures, workspaceRoots)) {
    const stepProblem = testStepProblem(headJob, baseJob);
    if (stepProblem) return result('unknown', false, stepProblem, inherited);
    const touched = touchedProtectedWorkspaces(head.failures, files, workspaceRoots);
    if (touched.length)
      return result(
        'inherited',
        false,
        `identical exact-base protected failure in ${touched.join(', ')}; the PR changes a file in that workspace; owner ${declaration.owner}; evidence ${declaration.evidence}`,
        inherited,
      );
    return result(
      'inherited',
      true,
      `no new failing workspaces versus the tested main tip; owner ${declaration.owner}; evidence ${declaration.evidence}`,
      { ...inherited, noNewFailures: true },
    );
  }
  if (protectedCheck(check, head.failures, workspaceRoots))
    return result(
      'inherited',
      false,
      `identical exact-base protected invariant; owner ${declaration.owner}; evidence ${declaration.evidence}; money/security failures are never excused`,
      inherited,
    );
  // Full coverage can diagnose a shard, but differing harnesses never authorize a failure exception.
  if (!fullSuite)
    return result(
      'inherited',
      false,
      'identical exact-base failure; only equivalent full-suite jobs may receive a non-protected exception',
      inherited,
    );
  return result('unknown', false, 'failing workspaces are not a subset of the tested main tip', inherited);
}

function checkLink(check, repo) {
  try {
    const u = new URL(check.link);
    if (u.origin !== 'https://github.com') return null;
    const m = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(u.pathname);
    return m && m[1] === repo ? { runId: m[2], jobId: m[3] } : null;
  } catch {
    return null;
  }
}

const INFRA_SELECTION =
  /^(?:\.github\/|tooling\/ci\/)|(?:^|\/)(?:package\.json|vitest[^/]*|vite\.config\.[^/]+|turbo\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/;

/** package.json, the lockfile, vitest/turbo config, .github and tooling/ci. Affected-only tests cannot prove these. */
export function touchesInfraSelection(files) {
  return (files ?? []).some((file) => INFRA_SELECTION.test(file));
}

function plainDeclarationLines(input) {
  let fence;
  const lines = [];
  for (const line of String(input ?? '').split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    lines.push(line.trim());
  }
  return lines;
}

/**
 * One plain Patch-Hash line for this patch. Lines for any other hash are stale and ignored.
 * Two lines that both name the current hash still refuse. A fenced example does not count.
 */
export function opusPatchQuoted(declarations, patchHash) {
  if (!/^[a-f0-9]{64}$/.test(patchHash ?? '')) return false;
  const found = plainDeclarationLines(declarations).filter((line) => line === `Patch-Hash: ${patchHash}`);
  return found.length === 1;
}

function workspaceOfFailure(failure, workspaceRoots) {
  if (!/^@intafaced\/[\w.-]+#test$/.test(failure?.task ?? '')) return null;
  const root = (workspaceRoots ?? knownWorkspaces()).get(failure.task.slice(0, -'#test'.length));
  if (!root) return null;
  const path = String(failure.file ?? '').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return null;
  if (/^(?:apps|services|packages|tooling)\//.test(path)) return path.startsWith(`${root}/`) ? root : null;
  return root;
}

/** Protected workspaces this PR edits. D-129a excuses a matching failure only when this set is empty. */
function touchedProtectedWorkspaces(headFailures, files, workspaceRoots) {
  const touched = new Set();
  for (const failure of headFailures) {
    const root = workspaceOfFailure(failure, workspaceRoots);
    if (!root || !isProtectedPath(root)) continue;
    if ((files ?? []).some((file) => file === root || file.startsWith(`${root}/`))) touched.add(root);
  }
  return [...touched];
}

/** Every failing head workspace already fails on the tested main tip. Unknown provenance fails closed. */
function failingWorkspacesSubset(headFailures, baseFailures, workspaceRoots) {
  const base = new Set();
  for (const failure of baseFailures) {
    const root = workspaceOfFailure(failure, workspaceRoots);
    if (!root) return false;
    base.add(root);
  }
  if (!headFailures.length) return false;
  for (const failure of headFailures) {
    const root = workspaceOfFailure(failure, workspaceRoots);
    if (!root || !base.has(root)) return false;
  }
  return true;
}

function failedProofRoots(proof, workspaceRoots) {
  const roots = workspaceRoots ?? knownWorkspaces();
  const failed = [];
  for (const task of proof?.tasks ?? []) {
    if (!((task.tests?.failed ?? 0) || (task.files?.failed ?? 0))) continue;
    const root = roots.get(String(task.task ?? '').replace(/#test$/, ''));
    if (!root) return null;
    failed.push(root);
  }
  return failed;
}

function proofHasNoNewFailures(headProof, baseProof, workspaceRoots) {
  const head = failedProofRoots(headProof, workspaceRoots);
  const base = failedProofRoots(baseProof, workspaceRoots);
  if (!head || !base) return false;
  const baseSet = new Set(base);
  return head.every((root) => baseSet.has(root));
}

/**
 * Full-suite comparison is intentionally narrow. Arbitrary jobs do not prove
 * changed-path coverage. Infra selection is not an absolute refusal: Tests (full)
 * continues into the no-new-failures path. A shard still cannot prove it.
 */
function coverageProblem(check, files) {
  if (check.workflow !== 'CI' || !TEST_JOB_POLICY[check.name])
    return 'changed-path coverage is unknown for this job; no inherited exception';
  if (touchesInfraSelection(files) && check.name !== 'Tests (full)')
    return 'CI/test selection changed; affected-only jobs cannot prove coverage';
  return null;
}

function testStepProblem(headJob, baseJob) {
  const headSteps = (headJob.steps ?? []).filter((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion)).map((s) => s.name);
  const baseSteps = new Set(
    (baseJob.steps ?? []).filter((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion)).map((s) => s.name),
  );
  if (!headSteps.length || headSteps.some((name) => name !== TEST_JOB_POLICY['Tests (full)'].step || !baseSteps.has(name)))
    return 'a non-test step or infrastructure invariant failed; test signatures cannot excuse it';
  for (const job of [headJob, baseJob]) {
    if (
      !(job.steps ?? []).some(
        (s) => s.name === 'Every infrastructure-backed suite actually ran' && s.status === 'completed' && s.conclusion === 'success',
      )
    )
      return 'no successful infrastructure execution backstop at both exact commits';
  }
  return null;
}

// workspaceRoots injects manifest fixtures for tooling-only offline test copies.
// Production callers omit it and use manifests from the trusted gate checkout.
export async function collectEvidence({
  gh,
  repo,
  head,
  base,
  mergeSha,
  checks,
  files = [],
  declarations = '',
  workspaceRoots,
  patchHash,
}) {
  const failed = checks.filter(
    (c) => (isFailed(c) && !REQUIRED.has(keyOf(c))) || (c.workflow === 'CI' && TEST_JOB_POLICY[c.name] && c.bucket === 'pass'),
  );
  const classifications = [];
  const coverage = [];
  const owners = parseInheritedDeclarations(declarations);
  const runCache = new Map();
  const logCache = new Map();
  const listCache = new Map();
  const getRun = (id) => {
    if (!runCache.has(String(id)))
      runCache.set(
        String(id),
        ghJson(gh, [
          'run',
          'view',
          String(id),
          '-R',
          repo,
          '--json',
          'databaseId,headSha,headBranch,event,workflowName,workflowDatabaseId,status,conclusion,jobs,url',
        ]),
      );
    return runCache.get(String(id));
  };
  const getLog = (id) => {
    if (!logCache.has(String(id))) logCache.set(String(id), gh(['run', 'view', '--job', String(id), '-R', repo, '--log']).stdout);
    return logCache.get(String(id));
  };
  const getList = (sha) => {
    if (!listCache.has(sha))
      listCache.set(
        sha,
        ghJson(gh, [
          'run',
          'list',
          '-R',
          repo,
          '--commit',
          sha,
          '-L',
          '100',
          '--json',
          'databaseId,headSha,workflowName,workflowDatabaseId,status,conclusion,url',
        ]),
      );
    return listCache.get(sha);
  };
  for (const check of failed) {
    let headRunId;
    let baseRunId;
    try {
      if (!SHA.test(head ?? '') || !SHA.test(base ?? '')) throw new Error('base/head must be exact full commit SHAs');
      const link = checkLink(check, repo);
      if (!link) throw new Error('check has no trusted repository run/job link');
      headRunId = link.runId;
      const headRun = getRun(headRunId);
      if (
        String(headRun.databaseId) !== headRunId ||
        headRun.headSha !== head ||
        headRun.workflowName !== check.workflow ||
        !headRun.workflowDatabaseId ||
        headRun.status !== 'completed'
      )
        throw new Error('head run SHA/workflow/status does not match the check');
      if (!(headRun.jobs ?? []).every(completed)) throw new Error('head run still has unfinished jobs');
      const matches = headRun.jobs.filter((j) => j.name === check.name && String(j.databaseId) === link.jobId);
      if (matches.length !== 1) throw new Error('head check job identity is ambiguous or absent');
      const headJob = matches[0];
      if (headJob.conclusion === 'startup_failure') {
        classifications.push({ ...classifyFailure({ check, headJob }), headRunId });
        continue;
      }
      const candidates = getList(base)
        .filter(
          (r) =>
            r.headSha === base &&
            r.workflowDatabaseId === headRun.workflowDatabaseId &&
            r.workflowName === check.workflow &&
            r.status === 'completed',
        )
        .sort((a, b) => b.databaseId - a.databaseId);
      if (!candidates.length) throw new Error('no workflow run at the exact base; historical main runs are not evidence');
      baseRunId = String(candidates[0].databaseId);
      const baseRun = getRun(baseRunId);
      if (
        String(baseRun.databaseId) !== baseRunId ||
        baseRun.headSha !== base ||
        baseRun.workflowName !== check.workflow ||
        baseRun.workflowDatabaseId !== headRun.workflowDatabaseId ||
        baseRun.status !== 'completed' ||
        !(baseRun.jobs ?? []).every(completed)
      )
        throw new Error('base run SHA/workflow/finished jobs do not match');
      let baseMatches = baseRun.jobs.filter((j) => j.name === check.name && ['success', 'failure'].includes(j.conclusion));
      if (!baseMatches.length && check.bucket === 'pass' && check.workflow === 'CI' && TEST_JOB_POLICY[check.name])
        baseMatches = baseRun.jobs.filter((j) => j.name === 'Tests (full)' && ['success', 'failure'].includes(j.conclusion));
      if (baseMatches.length !== 1)
        throw new Error('comparable covered job missing or ambiguous at exact base; failed jobs main does not run block');
      const baseJob = baseMatches[0];
      const headLog = normalizeTestLog(getLog(headJob.databaseId), headJob.name, workspaceRoots);
      const baseLog = normalizeTestLog(getLog(baseJob.databaseId), baseJob.name, workspaceRoots);
      const testedSha = actualCheckoutSha(headLog);
      if (
        !SHA.test(mergeSha ?? '') ||
        testedSha !== mergeSha ||
        testedSha === head ||
        actualCheckoutSha(baseLog) !== base ||
        headRun.event !== 'pull_request'
      )
        throw new Error('checkout logs do not prove a PR merge result and the exact tested main tip');
      const merge = ghJson(gh, ['api', `repos/${repo}/commits/${testedSha}`]);
      if (merge.sha !== testedSha || merge.parents?.length !== 2 || merge.parents[0]?.sha !== base || merge.parents[1]?.sha !== head)
        throw new Error('tested merge parents do not match target-main tip and exact PR head');
      if (TEST_JOB_POLICY[check.name]) {
        const scopeProblem = coverageProblem(check, files);
        if (scopeProblem) throw new Error(scopeProblem);
        if (touchesInfraSelection(files)) {
          if (check.name !== 'Tests (full)') throw new Error('CI/test selection changed; affected-only jobs cannot prove coverage');
          if (!opusPatchQuoted(declarations, patchHash))
            throw new Error('CI/test selection changes require an Opus evidence comment quoting the canonical patch hash');
        }
        const headProof = testExecutionProof(headJob, headLog, files, workspaceRoots),
          baseProof = testExecutionProof(baseJob, baseLog, files, workspaceRoots);
        if (headProof.problem || baseProof.problem) throw new Error(headProof.problem || baseProof.problem);
        if (touchesInfraSelection(files) && !proofHasNoNewFailures(headProof, baseProof, workspaceRoots))
          throw new Error('new failing workspaces versus the tested main tip');
        if (check.bucket === 'pass' && headJob.conclusion !== 'success')
          throw new Error('green check does not match its actual job conclusion');
        coverage.push({
          check: keyOf(check),
          head: {
            sha: head,
            testedSha,
            runId: headRunId,
            jobId: headJob.databaseId,
            job: headJob.name,
            conclusion: headJob.conclusion,
            tasks: headProof.tasks,
          },
          base: {
            sha: base,
            runId: baseRunId,
            jobId: baseJob.databaseId,
            job: baseJob.name,
            conclusion: baseJob.conclusion,
            tasks: baseProof.tasks,
          },
        });
        if (check.bucket === 'pass') continue;
      }
      classifications.push({
        ...classifyFailure({
          check,
          headJob,
          baseJob,
          headLog,
          baseLog,
          declaration: owners.get(keyOf(check)),
          coverageProblem: coverageProblem(check, files),
          workspaceRoots,
          files,
        }),
        headRunId,
        baseRunId,
      });
    } catch (error) {
      if (error?.name === 'GitHubRefusalError') throw error;
      classifications.push({ check: keyOf(check), classification: 'unknown', allowed: false, reason: error.message, headRunId, baseRunId });
    }
  }
  const fullSuiteClear = classifications.some((c) => c.allowed && c.noNewFailures && c.check === 'CI/Tests (full)');
  if (fullSuiteClear) {
    for (const item of classifications) {
      if (item.check !== 'CI/CI merge seal' || item.allowed) continue;
      item.classification = 'inherited';
      item.allowed = true;
      item.reason = 'CI merge seal follows Tests (full) with no new failures versus main';
    }
  }
  const reasons = classifications.filter((c) => !c.allowed).map((c) => `${c.check}: ${c.classification} — ${c.reason}`);
  if (!coverage.length) reasons.push('No finished changed-path test coverage proved at both exact commits.');
  const expectedRoots = workspaceRoots ?? (knownWorkspaces(), testWorkspacePaths);
  const required = requiredCoverage(files, expectedRoots).tasks;
  const changedRoots = new Set(files.map((file) => /^(?:apps|services|packages)\/[^/]+/.exec(file)?.[0]).filter(Boolean));
  const trustedTestRoots = new Set([...expectedRoots.values()].filter(Boolean));
  for (const root of changedRoots)
    if (!trustedTestRoots.has(root)) reasons.push(`${root}: unknown workspace test coverage in trusted main manifests`);
  for (const side of ['head', 'base']) {
    const proven = new Set(coverage.flatMap((entry) => entry[side].tasks.map((task) => task.task)));
    for (const task of required) if (!proven.has(task)) reasons.push(`${task}: missing ${side} changed-path coverage across finished jobs`);
  }
  return {
    pass: reasons.length === 0,
    reasons,
    classifications,
    coverage,
    summary: [
      ...coverage.map(
        (c) =>
          `${c.check}: head ${c.head.sha} in tested merge ${c.head.testedSha}, versus main tip ${c.base.sha} (${c.head.job} / ${c.base.job})`,
      ),
      ...classifications.map(
        (c) => `${c.check}: ${c.classification}${c.allowed ? ' (owner/evidence recorded)' : ' (blocks)'}; ${c.reason}`,
      ),
    ],
  };
}

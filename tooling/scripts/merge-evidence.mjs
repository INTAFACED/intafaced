/**
 * Exact-commit evidence for failed non-required checks. No recent-main window.
 *
 * PR body/comment declaration (one per check, plain line):
 * Inherited-Failure: CI/Tests (full) | owner=@team | evidence=https://.../issues/123
 * The declaration is accountability, never evidence by itself. GitHub run/job logs
 * must independently prove the same complete failure at the actual base/head.
 * Environmental failures remain blocked: a stopped runner does not prove tests ran.
 */
import { ghJson } from './gate-gh.mjs';
import { isProtectedPath } from './merge-review.mjs';
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
        .replace(/\u001b\[[0-9;]*m/g, '');
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
      signature: JSON.stringify([pending.task, pending.name, body]),
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
      pending = { task: ownTask, file: m[1], name: `${m[1]} ${m[2] ?? ''}`.trim(), body: [] };
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
  for (const t of tasks) if (!failures.some((f) => f.task === t)) issues.push(`task has no complete failure: ${t}`);
  if (!tasks.size || !failures.length) issues.push('no attributable failures found');
  return { failures, issues, readable: issues.length === 0 };
}

let workspacePaths;
function knownWorkspaces() {
  if (workspacePaths) return workspacePaths;
  workspacePaths = new Map();
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

/** Pure classification; every outcome explicitly says whether it may be excused. */
export function classifyFailure({ check, headJob, baseJob, headLog, baseLog, declaration, coverageProblem, workspaceRoots }) {
  const result = (classification, allowed, reason, extra = {}) => ({ check: keyOf(check), classification, allowed, reason, ...extra });
  if (/doctrine|security|gitleaks|secret|dependency audit|money|pay.bank|protocol|trade/i.test(keyOf(check)))
    return result('unknown', false, 'money/security/doctrine failures can never be excused, even when identical at base');
  if (!headJob || !completed(headJob) || !isFailed(headJob))
    return result('unknown', false, 'no finished failing job bound to the head check');
  if (headJob.conclusion === 'startup_failure' && !(headJob.steps ?? []).some((s) => s.status === 'completed'))
    return result('environmental', false, 'GitHub reports runner startup failure; rerun required because tests did not execute');
  if (!baseJob || !completed(baseJob) || !['success', 'failure'].includes(baseJob.conclusion))
    return result('unknown', false, 'no finished comparable job at the exact base');
  if (coverageProblem) return result('unknown', false, coverageProblem);
  if (baseJob.conclusion === 'success')
    return result('introduced', false, 'the same covered job passed at the exact base and fails at the exact head');
  const head = parseFailureSignatures(headLog);
  const base = parseFailureSignatures(baseLog);
  if (!head.readable || !base.readable)
    return result('unknown', false, `incomplete failure signatures: ${[...head.issues, ...base.issues].join('; ')}`);
  if (protectedCheck(check, head.failures, workspaceRoots))
    return result('unknown', false, 'protected or unknown failure provenance cannot be excused', { failures: head.failures });
  const before = new Set(base.failures.map((f) => f.signature));
  const added = head.failures.filter((f) => !before.has(f.signature));
  if (added.length) return result('introduced', false, 'failure error/assertion/location differs from the exact base', { failures: added });
  const headSteps = (headJob.steps ?? []).filter((s) => ['failure', 'timed_out'].includes(s.conclusion)).map((s) => s.name);
  const baseSteps = new Set((baseJob.steps ?? []).filter((s) => ['failure', 'timed_out'].includes(s.conclusion)).map((s) => s.name));
  if (!headSteps.length || headSteps.some((s) => !baseSteps.has(s)))
    return result('unknown', false, 'failing steps are absent or differ from the exact base');
  if (headSteps.some((s) => s !== 'Run pnpm test --continue'))
    return result('unknown', false, 'a non-test step or infrastructure invariant failed; test signatures cannot excuse it');
  for (const job of [headJob, baseJob]) {
    if (
      !(job.steps ?? []).some(
        (s) => s.name === 'Every infrastructure-backed suite actually ran' && s.status === 'completed' && s.conclusion === 'success',
      )
    )
      return result('unknown', false, 'no successful infrastructure execution backstop at both exact commits');
  }
  if (!declaration) return result('inherited', false, 'identical exact-base failure lacks a unique owner/evidence declaration');
  return result('inherited', true, `identical exact-base failure; owner ${declaration.owner}; evidence ${declaration.evidence}`, {
    failures: head.failures,
    owner: declaration.owner,
    evidence: declaration.evidence,
  });
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

/**
 * Full-suite comparison is intentionally narrow. Arbitrary jobs do not prove
 * changed-path coverage. Changes to CI/test selection invalidate this proof.
 */
function coverageProblem(check, files) {
  if (keyOf(check) !== 'CI/Tests (full)') return 'changed-path coverage is unknown for this job; no inherited exception';
  if (
    files.some((f) =>
      /^(?:\.github\/|tooling\/ci\/)|(?:^|\/)(?:package\.json|vitest[^/]*|vite\.config\.[^/]+|turbo\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/.test(
        f,
      ),
    )
  )
    return 'CI/test selection changed, so matching job names do not prove identical changed-path coverage';
  return null;
}

/**
 * CI's seal reports upstream results rather than testing product behavior. Its
 * sole permitted derived failure is the already-proven inherited full test job.
 * The exact upstream owner/evidence is retained; this is not a new exception.
 */
export function classifyDerivedSeal({ check, headJob, headLog, headRun, head, classifications }) {
  const unknown = (reason) => ({ check: keyOf(check), classification: 'unknown', allowed: false, reason });
  const upstream = classifications.find((c) => c.check === 'CI/Tests (full)');
  if (
    classifications.length !== 1 ||
    !upstream?.allowed ||
    upstream.classification !== 'inherited' ||
    upstream.headRunId !== String(headRun.databaseId)
  )
    return unknown('seal has no sole allowed inherited full-test result from this same head run');
  if (!completed(headJob) || headJob.conclusion !== 'failure') return unknown('seal is not a finished failing job');
  const failedSteps = (headJob.steps ?? []).filter((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion));
  if (failedSteps.length !== 1 || failedSteps[0].name !== 'Require needed jobs' || failedSteps[0].conclusion !== 'failure')
    return unknown('seal failed outside its sole upstream-result step');
  if (actualCheckoutSha(headLog) !== head) return unknown('seal checkout does not prove the actual exact head');
  const jobs = headRun.jobs ?? [];
  for (const name of ['Affected shards', 'Doctrine gates', 'Format', 'Typecheck & build']) {
    const matches = jobs.filter((j) => j.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') return unknown(`seal upstream ${name} is not uniquely successful`);
  }
  const full = jobs.filter((j) => j.name === 'Tests (full)');
  if (full.length !== 1 || full[0].conclusion !== 'failure') return unknown('seal full-test upstream is missing or ambiguous');
  if (jobs.some((j) => isFailed(j) && j.name !== 'Tests (full)' && String(j.databaseId) !== String(headJob.databaseId)))
    return unknown('seal has another failed upstream job');
  const stepLines = linesOf(headLog)
    .filter((l) => l.step === 'Require needed jobs')
    .map((l) => l.text);
  const expected = 'tests-full was failure (full run required)';
  const reasons = stepLines.flatMap((l) => /^\s*- (.+)$/.exec(l)?.slice(1) ?? []);
  const isExpectedAnnotation = (line) => line === `::error title=CI merge seal::${expected}` || line === `##[error]${expected}`;
  const exitAnnotation = '##[error]Process completed with exit code 1.';
  const annotations = stepLines.filter((l) => /^::error|^##\[error\]/.test(l) && l !== exitAnnotation);
  const headers = stepLines.filter((l) => l === '✖ CI merge seal failed:');
  if (
    reasons.length !== 1 ||
    reasons[0] !== expected ||
    annotations.length !== 1 ||
    !isExpectedAnnotation(annotations[0]) ||
    headers.length !== 1
  )
    return unknown('seal log does not contain exactly the sole full-test failure reason');
  if (!stepLines.some((l) => /^(?:##\[group\]Run )?node tooling\/ci\/ci-affected\.mjs --seal$/.test(l)))
    return unknown('seal log does not prove the expected result-checking command');
  if (
    stepLines.some(
      (l) => /\b(?:AssertionError|[A-Za-z]*Error):/.test(l) || (/^##\[error\]/.test(l) && l !== exitAnnotation && !isExpectedAnnotation(l)),
    )
  )
    return unknown('seal log has an additional error');
  return {
    check: keyOf(check),
    classification: 'inherited',
    allowed: true,
    derived: true,
    derivedFrom: upstream.check,
    owner: upstream.owner,
    evidence: upstream.evidence,
    baseRunId: upstream.baseRunId,
    reason: `derived solely from the allowed inherited full-test failure; owner ${upstream.owner}; evidence ${upstream.evidence}`,
  };
}

// workspaceRoots injects manifest fixtures for tooling-only offline test copies.
// Production callers omit it and use manifests from the trusted gate checkout.
export async function collectEvidence({ gh, repo, head, base, checks, files = [], declarations = '', workspaceRoots }) {
  // Evaluate the seal after its dependency regardless of GitHub's check order.
  const failed = checks
    .filter((c) => isFailed(c) && !REQUIRED.has(keyOf(c)))
    .sort((a, b) => Number(keyOf(a) === 'CI/CI merge seal') - Number(keyOf(b) === 'CI/CI merge seal'));
  if (!failed.length) return { pass: true, reasons: [], classifications: [], summary: [] };
  const classifications = [];
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
          'databaseId,headSha,workflowName,workflowDatabaseId,status,conclusion,jobs,url',
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
      if (keyOf(check) === 'CI/CI merge seal') {
        classifications.push({
          ...classifyDerivedSeal({ check, headJob, headLog: getLog(headJob.databaseId), headRun, head, classifications }),
          headRunId,
        });
        continue;
      }
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
      const baseMatches = baseRun.jobs.filter((j) => j.name === check.name);
      if (baseMatches.length !== 1) throw new Error('same workflow/job missing or ambiguous at exact base');
      const baseJob = baseMatches[0];
      const headLog = getLog(headJob.databaseId);
      const baseLog = getLog(baseJob.databaseId);
      if (actualCheckoutSha(headLog) !== head || actualCheckoutSha(baseLog) !== base)
        throw new Error('checkout logs do not prove execution at the actual exact head and base (merge refs do not qualify)');
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
        }),
        headRunId,
        baseRunId,
      });
    } catch (error) {
      if (error?.name === 'GitHubRefusalError') throw error;
      classifications.push({ check: keyOf(check), classification: 'unknown', allowed: false, reason: error.message, headRunId, baseRunId });
    }
  }
  const reasons = classifications.filter((c) => !c.allowed).map((c) => `${c.check}: ${c.classification} — ${c.reason}`);
  return {
    pass: reasons.length === 0,
    reasons,
    classifications,
    summary: classifications.map(
      (c) => `${c.check}: ${c.classification}${c.allowed ? ' (owner/evidence recorded)' : ' (blocks)'}; ${c.reason}`,
    ),
  };
}

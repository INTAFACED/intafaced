#!/usr/bin/env node
/**
 * Merge gate: exact PR head/base evidence, mandatory green security checks and independent protected-path review.
 * Run from a clean, fetched origin/main checkout. The CLI alone writes the version-bound PASS receipt; it never merges.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGateFileRule } from './gate-file-guard.mjs';
import { GitHubRefusalError, ghJson, makeGh } from './gate-gh.mjs';
import { classify } from '../ci/ci-affected.mjs';
import { collectEvidence } from './merge-evidence.mjs';
import { isProtectedPath, validateOpusReview, writePassReceipt, invalidateReceipt } from './merge-review.mjs';

export const REPO = 'Phantom-X-007/intafaced';
export const MARKER = '<!-- merge-gate -->';

/**
 * Checks that must run and pass on every PR (branch protection requires the same two). Never excused by main.
 * Identified by workflow + name, which is the `workflow` and `name` that `gh pr checks --json` reports.
 */
export const REQUIRED = [
  { workflow: 'Gitleaks', name: 'Gitleaks' },
  { workflow: 'Supply chain', name: 'Dependency audit' },
];

/** Identity of a check or job: "<workflow>/<job name>". */
export const keyOf = (c) => `${c.workflow ?? ''}/${c.name}`;
export const REQUIRED_KEYS = REQUIRED.map(keyOf);
export const CI_WORKFLOW_NAME = 'CI';
/**
 * Files whose change must run the full CI (including the agent-autoload scan) even though they are markdown.
 * ci.yml's `on.pull_request.paths` lists the same patterns after its markdown exclusion; merge-gate.test.mjs fails on drift.
 */
export const AGENT_RULE_PATTERNS = [
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/AGENT_PROTOCOL.md',
  '**/SKILL.md',
  'tooling/agent-protocol/**',
  '.agents/**',
  '.cursor/rules/**',
];

/** Mirror of `on.pull_request.paths` in .github/workflows/ci.yml (merge-gate.test.mjs fails if they drift). */
export const CI_PR_PATHS = ['**', '!docs/**', '!**/*.md', '!NOTICE', '!LICENSE', 'INTAFACED_DEFINITIVE_BUILD.md', ...AGENT_RULE_PATTERNS];

const FAIL_BUCKETS = new Set(['fail', 'cancel']);
const LIVE_CLI = Symbol('verified live CLI');
const trustedComments = (comments) => comments.filter((c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association));
const trustedBody = (pr) => (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.authorAssociation) ? String(pr.body ?? '') : '');
const bodyFingerprint = (pr) => JSON.stringify([['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.authorAssociation), trustedBody(pr)]);
function readPrSnapshot(gh, repo, pr, fields) {
  const value = ghJson(gh, ['pr', 'view', String(pr), '-R', repo, '--json', fields]);
  const metadata = ghJson(gh, ['api', `repos/${repo}/pulls/${pr}`]);
  if (metadata.number !== pr || metadata.head?.sha !== value.headRefOid)
    throw new GateError('PR author metadata does not match the live head.');
  return { ...value, authorAssociation: metadata.author_association, mergeCommitSha: metadata.merge_commit_sha };
}

const declarationCommentsFingerprint = (comments) =>
  JSON.stringify(
    trustedComments(comments)
      .map((c) => ({
        id: c.id ?? null,
        // Markdown context changes whether a marker is a declaration or a quoted example.
        text: String(c.body ?? ''),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  );
const checkFingerprint = (checks) => JSON.stringify(checks.map((c) => [keyOf(c), c.bucket, c.state, c.completedAt, c.link]).sort());

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
  const agentRule = AGENT_RULE_PATTERNS.map(pathGlob);
  if (files.some((f) => agentRule.some((re) => re.test(f)))) return true; // never docs-only, whatever the mirror says
  const compiled = patterns.map((p) => ({ neg: p.startsWith('!'), re: pathGlob(p.replace(/^!/, '')) }));
  return files.some((f) => {
    let included = false;
    for (const p of compiled) if (p.re.test(f)) included = !p.neg;
    return included;
  });
}

/** One entry per workflow+name (a re-run leaves several): keep the latest by completedAt, a pending entry counts as latest. */
export function collapseChecks(checks) {
  const byName = new Map();
  for (const c of checks) {
    const prev = byName.get(keyOf(c));
    const stamp = (x) => (x.completedAt && !x.completedAt.startsWith('0001') ? Date.parse(x.completedAt) : Infinity);
    if (!prev || stamp(c) >= stamp(prev)) byName.set(keyOf(c), c);
  }
  return [...byName.values()];
}

export function mergeCommand(pr, head, repo = REPO) {
  return `gh pr merge ${pr} --match-head-commit ${head} -R ${repo} --squash`;
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
export async function runGate(
  o,
  {
    gh,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
    evidenceCollector = collectEvidence,
    reviewValidator = validateOpusReview,
  } = {},
) {
  const { pr, head, repo } = o;
  const viewPr = () =>
    readPrSnapshot(gh, repo, pr, 'number,state,isDraft,headRefOid,baseRefOid,baseRefName,title,body,changedFiles,mergeable,url');
  const first = viewPr();
  const targetBase = first.baseRefOid;
  const assertSnapshot = (cur, initial = false) => {
    if (cur.headRefOid !== head)
      throw new GateError(
        initial
          ? `PR #${pr} head is ${cur.headRefOid}, not the reviewed ${head}. Nothing was checked.`
          : `PR #${pr} head moved to ${cur.headRefOid}. Re-review and run the gate again.`,
      );
    if (cur.state !== 'OPEN') throw new GateError(`PR #${pr} is ${cur.state}, not OPEN.`);
    if (cur.isDraft) throw new GateError(`PR #${pr} is a draft.`);
    if (cur.baseRefName !== 'main') throw new GateError(`PR #${pr} targets ${cur.baseRefName}, not main.`);
    if (!/^[0-9a-f]{40}$/.test(cur.baseRefOid ?? '')) throw new GateError('PR target base commit could not be read.');
    if (cur.baseRefOid !== targetBase) throw new GateError('PR base moved while checking; run the gate again against its current base.');
    if (cur.mergeCommitSha !== first.mergeCommitSha)
      throw new GateError('PR merge result changed while checking; rerun against its current main parent.');
    if (cur.title !== first.title || bodyFingerprint(cur) !== bodyFingerprint(first))
      throw new GateError('PR title or declarations changed while checking; run the gate again.');
  };
  assertSnapshot(first, true);
  const pages = ghJson(gh, ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/files`]);
  const entries = pages.flat();
  if (!entries.length || entries.some((f) => typeof f.filename !== 'string'))
    throw new GateError(`PR #${pr} lists no usable changed files.`);
  if (!Number.isInteger(first.changedFiles) || entries.length !== first.changedFiles)
    throw new GateError('Changed-file list is incomplete; cannot prove scope (GitHub limits this endpoint to 3000 files).');
  // Both sides of a rename carry scope: moving a protected or gate file cannot erase its review requirement.
  const files = [...new Set(entries.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  const docsOnly = !ciWouldRun(files);
  const mergeSha = first.mergeCommitSha;
  let base = targetBase;
  if (!docsOnly) {
    if (!/^[0-9a-f]{40}$/.test(mergeSha ?? '')) throw new GateError('No current GitHub merge result is available.');
    const merge = ghJson(gh, ['api', `repos/${repo}/commits/${mergeSha}`]);
    if (
      merge.sha !== mergeSha ||
      merge.parents?.length !== 2 ||
      !/^[0-9a-f]{40}$/.test(merge.parents[0]?.sha ?? '') ||
      merge.parents[1]?.sha !== head
    )
      throw new GateError('GitHub merge result does not bind the target main parent and exact PR head.');
    base = merge.parents[0].sha;
  }
  const compared = ghJson(gh, ['api', `repos/${repo}/compare/${base}...${head}`]);
  const reviewBase = compared.merge_base_commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(reviewBase ?? ''))
    throw new GateError('PR merge base could not be resolved; exact-base evidence is required.');
  const comments = ghJson(gh, ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments`])
    .flat()
    .filter((c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association));
  const declarationComments = declarationCommentsFingerprint(trustedComments(comments));
  const declarations = [trustedBody(first), ...comments.map((c) => c.body ?? '')].join('\n');
  const readChecks = () => {
    const r = gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,state,bucket,workflow,link,completedAt'], { allowFail: true });
    if (r.stdout.trim()) return collapseChecks(JSON.parse(r.stdout));
    if (/no checks reported/i.test(r.stderr)) return [];
    throw new GateError(`gh pr checks returned nothing (${r.status}): ${r.stderr.trim().slice(0, 300)}`);
  };
  const readRuns = () =>
    ghJson(gh, ['run', 'list', '-R', repo, '--commit', head, '-L', '100', '--json', 'databaseId,workflowName,status,conclusion']);
  const pendingChecks = (checks) => checks.filter((c) => !['pass', 'fail', 'cancel', 'skipping'].includes(c.bucket));
  const start = now();
  let stable = 0,
    ciAbsentSince = null,
    settled;
  for (;;) {
    const cur = viewPr();
    assertSnapshot(cur);
    const checks = readChecks(),
      runs = readRuns();
    const pending = pendingChecks(checks).map((c) => c.name);
    const active = runs.filter((r) => r.status !== 'completed').map((r) => r.workflowName);
    const missing = REQUIRED.filter((r) => !checks.some((c) => keyOf(c) === keyOf(r)));
    const ciPresent = checks.some((c) => c.workflow === CI_WORKFLOW_NAME) || runs.some((r) => r.workflowName === CI_WORKFLOW_NAME);
    let done = !pending.length && !active.length && !missing.length;
    if (done && !ciPresent && !docsOnly) {
      ciAbsentSince ??= now();
      if (now() - ciAbsentSince < o.ciGraceSec * 1000) done = false;
    }
    stable = done ? stable + 1 : 0;
    if (stable >= 2 || (missing.length && !pending.length && !active.length && now() - start > o.ciGraceSec * 1000)) {
      settled = { checks, ciPresent, mergeable: cur.mergeable };
      break;
    }
    if (now() - start > o.timeoutMin * 60_000)
      throw new GateError(
        `checks not finished after ${o.timeoutMin} min. Still pending: ${[...pending, ...active, ...missing.map((r) => r.name)].join(', ')}`,
      );
    log(
      `waiting: ${pending.length} pending check(s), ${active.length} active run(s), missing required: ${missing.map((r) => r.name).join(', ') || 'none'}`,
    );
    await sleep(o.pollSec * 1000);
  }
  const reasons = [],
    required = {};
  for (const r of REQUIRED) {
    const c = settled.checks.find((c) => keyOf(c) === keyOf(r));
    required[r.name] = c?.bucket ?? 'missing';
    if (!c) reasons.push(`required check "${r.name}" (workflow "${r.workflow}") never reported`);
    else if (c.bucket !== 'pass') reasons.push(`required check "${r.name}" is ${c.bucket}`);
  }
  const gate = evaluateGateFileRule(first.title, files);
  if (!gate.ok) reasons.push('Gate files changed without a ci: or gate: title declaration.');
  if (!docsOnly && !settled.ciPresent) reasons.push('CI never started for this non-docs PR.');
  if (!docsOnly) reasons.push(...coverageProblems(files, settled.checks));
  let evidence = {
    pass: true,
    reasons: [],
    classifications: [],
    summary: docsOnly ? ['Docs-only report: CI path filter excludes every changed file.'] : ['No usable CI evidence was collected.'],
  };
  if (docsOnly) {
    for (const c of settled.checks) if (FAIL_BUCKETS.has(c.bucket)) reasons.push(`docs-only reported check failed: ${keyOf(c)}`);
  } else if (settled.ciPresent) {
    evidence = await evidenceCollector({ gh, repo, head, base, mergeSha, checks: settled.checks, files, declarations });
    reasons.push(...evidence.reasons);
    if (!evidence.pass && !evidence.reasons.length) reasons.push('Exact-base/head evidence did not pass.');
  }
  const protectedFiles = files.filter(isProtectedPath);
  const reviewResult = protectedFiles.length ? reviewValidator({ head, base: reviewBase, declarations }) : { pass: true, reasons: [] };
  reasons.push(...reviewResult.reasons);
  if (!reviewResult.pass && !reviewResult.reasons.length) reasons.push('Independent Opus review did not pass.');
  const final = viewPr();
  assertSnapshot(final);
  if (final.mergeable === 'CONFLICTING') reasons.push('PR has merge conflicts with main');
  // Evidence can take minutes. Reject a newly started run or any changed check before issuing a verdict.
  const finalChecks = readChecks(),
    finalRuns = readRuns();
  if (
    checkFingerprint(finalChecks) !== checkFingerprint(settled.checks) ||
    pendingChecks(finalChecks).length ||
    finalRuns.some((r) => r.status !== 'completed')
  )
    throw new GateError('Checks changed or restarted during evidence collection; run the gate again.');
  if (
    declarationCommentsFingerprint(ghJson(gh, ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments`]).flat()) !==
    declarationComments
  )
    throw new GateError('PR review or failure declarations changed in comments; run the gate again.');
  const evalResult = {
    pass: reasons.length === 0,
    reasons,
    required,
    docsOnly,
    gate,
    evidence,
    protectedFiles,
    review: reviewResult.review,
  };
  const verdict = evalResult.pass ? 'PASS' : 'FAIL';
  const comment = renderEvidenceComment({ verdict, head, base, reviewBase, targetBase, pr, repo, checks: settled.checks, evalResult });
  if (o.comment) gh(['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], { input: comment });
  return {
    code: evalResult.pass ? 0 : 1,
    verdict,
    evalResult,
    comment,
    base,
    reviewBase,
    mergeSha,
    targetBase,
    snapshot: first,
    checks: settled.checks,
    declarationComments,
    mergeCommand: evalResult.pass ? mergeCommand(pr, head, repo) : undefined,
  };
}

/** Required jobs must have run; a workflow shell or a skipped test job proves no changed-path coverage. */
export function coverageProblems(files, checks) {
  const ran = (name) => checks.some((c) => c.workflow === CI_WORKFLOW_NAME && c.name === name && ['pass', 'fail'].includes(c.bucket));
  const problems = ['Doctrine gates', 'Typecheck & build', 'Format']
    .filter((name) => !ran(name))
    .map((name) => `Required CI coverage missing or skipped: ${name}.`);
  const flags = classify(files);
  const shards = { protocol: 'Tests (protocol)', money: 'Tests (money)', trade: 'Tests (trade)', paybank: 'Tests (pay-bank)' };
  const expected = flags.full
    ? ['Tests (full)']
    : Object.entries(shards)
        .filter(([flag]) => flags[flag])
        .map(([, name]) => name);
  // Unclassified non-doc paths (agent rules, root config) are conservatively covered by the full suite.
  if (!expected.length) expected.push('Tests (full)');
  if (!ran('Tests (full)'))
    for (const name of expected) if (!ran(name)) problems.push(`Required changed-path test coverage missing or skipped: ${name}.`);
  return problems;
}

export function renderEvidenceComment({ verdict, head, base, reviewBase, targetBase, pr, repo, checks, evalResult: e }) {
  const lines = [
    MARKER,
    `**Merge gate: ${verdict}** for head \`${head}\``,
    '',
    `- Review merge base: \`${reviewBase}\`; tested target main: \`${base}\`.`,
    `- Required checks: ${REQUIRED.map((r) => `${r.name} ${e.required[r.name]}`).join(', ')}.`,
    `- Finished checks reported: ${checks.length}.`,
  ];
  if (e.docsOnly) lines.push('- Docs-only report: no CI test coverage claimed; all reported checks must pass.');
  for (const item of e.evidence.summary ?? []) lines.push(`- ${item}`);
  for (const item of e.evidence.classifications ?? []) lines.push(`- ${item.check}: ${item.classification} — ${item.reason}`);
  if (e.gate.gateFiles.length)
    lines.push(
      `- Gate files changed: ${e.gate.gateFiles.map((f) => `\`${f.file}\``).join(', ')} (${e.gate.declared ? 'declared' : 'undeclared'}); judged by origin/main's copy.`,
    );
  if (e.protectedFiles.length)
    lines.push(`- Independent Opus review: ${e.review ? `PASS, session ${e.review.reviewerSession}` : 'missing or invalid'}.`);
  if (e.reasons.length) lines.push('', 'Blocked because:', ...e.reasons.map((r) => `- ${r}`));
  if (verdict === 'PASS') lines.push('', `Merge command: \`${mergeCommand(pr, head, repo)}\``);
  return lines.join('\n') + '\n';
}

/**
 * The gate must be main's copy: a PR can edit this file. Returns a problem string, or null when tooling/scripts and
 * tooling/ci and the workspace manifests used for protected-task attribution match origin/main exactly. `git` is injected for tests.
 */
export function mainCopyProblem(git) {
  const fetched = git(['fetch', '-q', 'origin', 'main']);
  if (fetched.status !== 0)
    return `could not fetch origin/main (${String(fetched.stderr).trim().slice(0, 200)}), so the gate cannot prove it is main's copy`;
  const origin = git(['rev-parse', 'origin/main']),
    current = git(['rev-parse', 'HEAD']);
  if (origin.status !== 0 || current.status !== 0 || !/^[0-9a-f]{40}$/.test(origin.stdout?.trim() ?? ''))
    return 'Could not prove the gate revision against origin/main.';
  if (origin.stdout.trim() !== current.stdout?.trim())
    return 'Run the gate from an up-to-date origin/main checkout; this branch HEAD differs from origin/main.';
  const paths = [
    'tooling/scripts',
    'tooling/ci',
    '.github/workflows',
    'package.json',
    ':(glob)apps/*/package.json',
    ':(glob)services/*/package.json',
    ':(glob)packages/*/package.json',
  ];
  const diff = git(['diff', '--quiet', 'origin/main', '--', ...paths]);
  if (diff.status === 1) return 'Gate files differ from origin/main. Run the gate from an up-to-date origin/main checkout.';
  if (diff.status !== 0) return `git diff against origin/main failed (${String(diff.stderr).trim().slice(0, 200)})`;
  // Omit --exclude-standard deliberately: ignored untracked imports can also replace a missing gate dependency.
  const untracked = git(['ls-files', '--others', '--', ...paths]);
  if (untracked.status !== 0) return 'Could not inspect untracked gate dependencies.';
  if (untracked.stdout?.trim()) return 'Untracked gate files or dependencies exist; use a clean origin/main checkout.';
  return null;
}

/**
 * Production lifecycle. Tests must explicitly provide an isolated receiptRoot; runGate itself never writes receipts.
 * Invalidate first so every refusal removes a stale PASS. Publish PASS only after the receipt has been saved.
 */
export async function runVerifiedGate(
  o,
  {
    git,
    gh,
    receiptRoot,
    productionToken,
    runGateFn = runGate,
    writeReceipt = writePassReceipt,
    reviewValidator = validateOpusReview,
    invalidate = invalidateReceipt,
    log = () => {},
  } = {},
) {
  if (receiptRoot === undefined && productionToken !== LIVE_CLI)
    throw new GateError('Only the production CLI may write live receipts; tests must specify an isolated receiptRoot.');
  const receiptKey = { repo: o.repo, head: o.head, receiptRoot };
  invalidate(receiptKey);
  try {
    const problem = mainCopyProblem(git);
    if (problem) throw new GateError(problem);
    const gateSha = git(['rev-parse', 'origin/main']).stdout.trim();
    const result = await runGateFn({ ...o, comment: false }, { gh, log });
    if (result.code === 0) {
      const finalProblem = mainCopyProblem(git);
      if (finalProblem) throw new GateError(finalProblem);
      if (git(['rev-parse', 'origin/main']).stdout.trim() !== gateSha)
        throw new GateError('origin/main moved during this gate run; run its current copy again.');
      // Fetching main can take time; bind the receipt again to the PR and unchanged finished checks afterwards.
      const checks = collapseChecks(
        ghJson(gh, ['pr', 'checks', String(o.pr), '-R', o.repo, '--json', 'name,state,bucket,workflow,link,completedAt'], {
          allowFail: true,
        }),
      );
      const runs = ghJson(gh, [
        'run',
        'list',
        '-R',
        o.repo,
        '--commit',
        o.head,
        '-L',
        '100',
        '--json',
        'databaseId,workflowName,status,conclusion',
      ]);
      if (checkFingerprint(checks) !== checkFingerprint(result.checks) || runs.some((r) => r.status !== 'completed'))
        throw new GateError('Checks changed or restarted before receipt; run the gate again.');
      const comments = ghJson(gh, ['api', '--paginate', '--slurp', `repos/${o.repo}/issues/${o.pr}/comments`])
        .flat()
        .filter((c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association));
      if (declarationCommentsFingerprint(trustedComments(comments)) !== result.declarationComments)
        throw new GateError('PR review or failure declarations changed before receipt; run the gate again.');
      const cur = readPrSnapshot(gh, o.repo, o.pr, 'state,isDraft,headRefOid,baseRefOid,baseRefName,title,body,mergeable');
      const before = result.snapshot;
      if (
        cur.state !== 'OPEN' ||
        cur.isDraft ||
        cur.headRefOid !== o.head ||
        cur.baseRefOid !== result.targetBase ||
        cur.baseRefName !== 'main' ||
        cur.title !== before.title ||
        bodyFingerprint(cur) !== bodyFingerprint(before) ||
        cur.mergeCommitSha !== before.mergeCommitSha ||
        cur.mergeable === 'CONFLICTING'
      )
        throw new GateError('PR changed before receipt; run the gate again.');
      if (result.evalResult.protectedFiles.length) {
        const fresh = reviewValidator({
          head: o.head,
          base: result.reviewBase,
          declarations: [trustedBody(cur), ...comments.map((c) => c.body ?? '')].join('\n'),
        });
        const earlier = result.evalResult.review;
        if (
          !fresh.pass ||
          !fresh.review ||
          fresh.review.head !== o.head ||
          fresh.review.base !== result.reviewBase ||
          fresh.review.authorSession !== earlier?.authorSession ||
          fresh.review.reviewerSession !== earlier?.reviewerSession ||
          fresh.review.parentSession !== earlier?.parentSession
        )
          throw new GateError('Opus review changed or was withdrawn before receipt; review the exact head again.');
        result.evalResult.review = fresh.review;
      }
      result.receipt = writeReceipt({
        ...receiptKey,
        pr: o.pr,
        base: result.base,
        liveHead: cur.headRefOid,
        gateSha,
        evidence: result.evalResult.evidence,
        review: result.evalResult.review,
      });
    }
    if (o.comment) gh(['pr', 'comment', String(o.pr), '-R', o.repo, '--body-file', '-'], { input: result.comment });
    return result;
  } catch (error) {
    invalidate(receiptKey);
    throw error;
  }
}

async function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const git = (args) => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000 });
      return { status: r.status ?? 2, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    };
    const result = await runVerifiedGate(o, {
      git,
      gh: makeGh(),
      productionToken: LIVE_CLI,
      log: (m) => console.error(`merge-gate: ${m}`),
    });
    if (result.receipt) console.log(`PASS receipt: ${result.receipt.path}`);
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

#!/usr/bin/env node
/**
 * CI affected-path classifier.
 *
 * A pull request runs the tests of what it changed, not the whole suite:
 *   full     — a change on the run-everything list (contracts, events, ledger-client, config, auth, lockfile,
 *              turbo and tsconfig, tooling, workflows, gate files) or any path outside the product dirs;
 *   affected — turbo runs the changed packages, their dependents and the readers listed in
 *              tooling/ci/test-read-edges.json (`--filters` prints the turbo filters);
 *   neither  — docs only; the seal then needs no test job.
 *
 *   node tooling/ci/ci-affected.mjs --self-test
 *   node tooling/ci/ci-affected.mjs --files services/svc-protocol/src/x.ts
 *   node tooling/ci/ci-affected.mjs --github-output
 *   node tooling/ci/ci-affected.mjs --filters
 *   node tooling/ci/ci-affected.mjs --seal
 *
 * `push:main` always classifies as full (the trunk seal).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { detectedEdges } from './cross-package-reads.mjs';

/** Run-everything list: a change here can break a consumer in any package, so the whole suite runs. */
export const FULL_TRIGGERS = [
  'tooling/',
  '.github/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  'packages/contracts/',
  'packages/events/',
  // Imported by dozens of services (27 workspaces depend on ledger-client, 33 on config).
  'packages/ledger-client/',
  'packages/config/',
  'packages/auth/',
];

/** Agent-rule and gate files are never docs-only, even though most of them are Markdown. */
export const GATE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursor/',
  '.agents/',
  '.claude/',
  'docs/agents/',
  'docs/CODEOWNERS',
  'tooling/',
  '.github/',
];
const GATE_BASENAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'SKILL.md']);

const PRODUCT_DIRS = /^(apps|services|packages)\//;

function posix(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function matchesPrefix(file, prefix) {
  const f = posix(file);
  const p = posix(prefix);
  if (p.endsWith('/')) return f === p.slice(0, -1) || f.startsWith(p);
  return f === p || f.startsWith(`${p}/`);
}

/** True for a gate file: the agent rules, the CI and tooling directories, the workflows. */
export const isGateFile = (file) => GATE_FILES.some((g) => matchesPrefix(file, g)) || GATE_BASENAMES.has(posix(file).split('/').pop());

const isDoc = (file) => file.startsWith('docs/') || file.endsWith('.md');

/**
 * `edges` is tooling/ci/test-read-edges.json: tests in <reader> read files of each listed package. turbo's
 * dependents graph cannot see those reads, so the reader is selected whenever a package it reads changes.
 */
export function readEdges() {
  let declared = {};
  try {
    declared = JSON.parse(readFileSync(new URL('./test-read-edges.json', import.meta.url), 'utf8')).edges ?? {};
  } catch {
    /* no declared edges */
  }
  // Reads the scan finds count too, so a test that reads another package needs no edge-list entry to be selected.
  return mergeEdges(declared, detectedEdges());
}

export function mergeEdges(a, b) {
  const out = {};
  for (const src of [a, b])
    for (const [reader, reads] of Object.entries(src)) out[reader] = [...new Set([...(out[reader] ?? []), ...reads])];
  return out;
}

/**
 * full     — run every test (run-everything list, gate files, anything outside the product dirs, push to main).
 * affected — run the tests of the changed packages, their dependents, and the readers of what they changed.
 * Neither  — nothing to test (docs only); the seal then needs no test job.
 */
export function classify(files, { forceFull = false } = {}) {
  if (forceFull) return { full: true, affected: false };
  const list = (files || []).map(posix).filter(Boolean);
  let affected = false;
  for (const file of list) {
    if (isGateFile(file)) return { full: true, affected: false };
    if (isDoc(file)) continue;
    if (FULL_TRIGGERS.some((t) => matchesPrefix(file, t))) return { full: true, affected: false };
    if (PRODUCT_DIRS.test(file)) affected = true;
    else return { full: true, affected: false }; // unknown root path: run everything, never a silent skip
  }
  return { full: false, affected };
}

/** turbo filters for an affected run: changed packages plus dependents, plus the readers of changed packages. */
export function affectedFilters(files, edges = readEdges(), base = 'origin/main') {
  const list = (files || []).map(posix).filter(Boolean);
  const filters = [`...[${base}]`];
  for (const [reader, reads] of Object.entries(edges)) {
    if (reads.some((dir) => list.some((f) => matchesPrefix(f, dir)))) filters.push(`./${reader}`);
  }
  return filters;
}

/**
 * Build filters: the affected filters plus every package a selected reader reads. A reader's own build can type its
 * tests too (apps/admin's next build does), and those tests import the read packages' sources, so their dependencies
 * must be built even when no declared dependency leads there. Tests keep using affectedFilters.
 */
export function buildFilters(files, edges = readEdges(), base = 'origin/main') {
  const filters = affectedFilters(files, edges, base);
  const out = new Set(filters);
  for (const [reader, reads] of Object.entries(edges)) {
    if (!filters.includes(`./${reader}`)) continue;
    for (const dir of reads) out.add(`./${dir}`);
  }
  return [...out];
}

export const SHARD_COUNT = 8;

/**
 * The test job's matrix. A run-everything run is split SHARD_COUNT ways (tooling/ci/test-shards.mjs); an affected run is
 * one job, `changed`. The seal reads the matrix as one job: it is green only when every shard is.
 */
export function shardMatrix(flags) {
  if (flags.full) return Array.from({ length: SHARD_COUNT }, (_, i) => `${i + 1}/${SHARD_COUNT}`);
  return ['changed'];
}

export function sealNeeded(flags, results) {
  const problems = [];
  const always = ['changes', 'gates', 'format', 'build'];
  for (const name of always) {
    const r = results[name];
    if (r !== 'success') problems.push(`${name} was ${r || 'missing'} (required)`);
  }
  // A skipped test job counts as a failure unless the classifier said there was nothing to test.
  if (flags.full || flags.affected) {
    if (results['tests-full'] !== 'success') {
      problems.push(`tests-full was ${results['tests-full'] || 'missing'} (${flags.full ? 'full run' : 'affected run'} required)`);
    }
  }
  return problems;
}

/**
 * The commit turbo compares against (`...[<base>]`): where this head branched from the base branch, not the base
 * branch's tip. A re-run of an old pull_request run checks out that run's merge commit while `fetch-depth: 0` fetches
 * today's main, so `...[origin/main]` also selected every package main changed since: on 30 Oct, #6834's head selects
 * 37 packages against today's main and 19 against its merge-base, and its re-runs hung or failed (#6831, #6832, #6834).
 * Falls back to the branch tip when git cannot say.
 */
export function diffBase(run = (args) => execFileSync('git', args, { encoding: 'utf8' }), base = baseRef()) {
  try {
    const sha = run(['merge-base', base, 'HEAD']).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : base;
  } catch {
    return base;
  }
}

/** The base branch a pull request merges into, as a remote ref (origin/main outside a pull request). */
export function baseRef() {
  return process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
}

function gitChangedFiles() {
  const base = baseRef();
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...HEAD`], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}`], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function selfTest() {
  const none = { full: false, affected: false };
  const cases = [
    { files: ['services/svc-protocol/src/audit/pipeline.ts'], expected: { full: false, affected: true } },
    { files: ['services/svc-token/src/token-service.ts', 'apps/customer/src/x.tsx'], expected: { full: false, affected: true } },
    { files: ['packages/ledger-client/src/index.ts'], expected: { full: true, affected: false } },
    { files: ['packages/config/src/index.ts'], expected: { full: true, affected: false } },
    { files: ['packages/auth/src/index.ts'], expected: { full: true, affected: false } },
    { files: ['packages/contracts/src/x.ts'], expected: { full: true, affected: false } },
    { files: ['packages/events/src/catalog.ts'], expected: { full: true, affected: false } },
    { files: ['tooling/ci/gates.mjs'], expected: { full: true, affected: false } },
    { files: ['tooling/infra/postgres-init/01-service-schemas.sql'], expected: { full: true, affected: false } },
    { files: ['.github/workflows/ci.yml'], expected: { full: true, affected: false } },
    { files: ['pnpm-lock.yaml'], expected: { full: true, affected: false } },
    { files: ['turbo.json'], expected: { full: true, affected: false } },
    { files: ['tsconfig.base.json'], expected: { full: true, affected: false } },
    { files: ['AGENTS.md'], expected: { full: true, affected: false } },
    { files: ['CLAUDE.md'], expected: { full: true, affected: false } },
    { files: ['.cursor/rules/x.mdc'], expected: { full: true, affected: false } },
    { files: ['vendor/x/y.ts'], expected: { full: true, affected: false } },
    { files: ['services/svc-trade/CLAUDE.md'], expected: { full: true, affected: false } },
    { files: ['tooling/agent-protocol/AGENT_PROTOCOL.md'], expected: { full: true, affected: false } },
    { files: ['docs/agents/build-slice.md'], expected: { full: true, affected: false } },
    { files: ['docs/CODEOWNERS'], expected: { full: true, affected: false } },
    { files: ['.claude/agents/explore.md'], expected: { full: true, affected: false } },
    { files: ['services/svc-x/SKILL.md'], expected: { full: true, affected: false } },
    { files: ['.github/pull_request_template.md'], expected: { full: true, affected: false } },
    { files: ['docs/x.md'], expected: none },
    { files: ['services/svc-trade/README.md'], expected: none },
    { files: [], expected: none },
    { files: ['docs/x.md', 'services/svc-trade/src/a.ts'], expected: { full: false, affected: true } },
  ];
  for (const c of cases) {
    const got = classify(c.files);
    assert(same(got, c.expected), `classify(${JSON.stringify(c.files)}) => ${JSON.stringify(got)} expected ${JSON.stringify(c.expected)}`);
  }
  const forced = classify(['services/svc-protocol/x.ts'], { forceFull: true });
  assert(forced.full === true && forced.affected === false, 'forceFull must short-circuit to full');

  // Filters: dependents of what changed, plus the readers of the changed package.
  const edges = { 'apps/customer': ['services/svc-trade', 'services/svc-pay'], 'apps/admin': ['services/svc-bank'] };
  assert(
    same(affectedFilters(['services/svc-trade/src/a.ts'], edges), ['...[origin/main]', './apps/customer']),
    'a reader of svc-trade is selected when svc-trade changes',
  );
  assert(same(affectedFilters(['services/svc-ledger/src/a.ts'], edges), ['...[origin/main]']), 'unrelated change selects no reader');
  assert(
    same(affectedFilters(['services/svc-pay/a.ts', 'services/svc-bank/b.ts'], edges), [
      '...[origin/main]',
      './apps/customer',
      './apps/admin',
    ]),
    'every reader of every changed package is selected',
  );
  assert(!affectedFilters(['services/svc-trade-extra/a.ts'], edges).includes('./apps/customer'), 'a prefix sibling is not a match');
  assert(
    same(buildFilters(['services/svc-bank/b.ts'], edges), ['...[origin/main]', './apps/admin', './services/svc-bank']),
    'a selected reader builds every package it reads',
  );
  assert(same(buildFilters(['services/svc-ledger/src/a.ts'], edges), ['...[origin/main]']), 'no reader selected, nothing added');
  const sha = 'a'.repeat(40);
  assert(diffBase(() => `${sha}\n`, 'origin/main') === sha, 'turbo compares against the merge-base, not the moving branch tip');
  assert(diffBase(() => 'not a sha', 'origin/main') === 'origin/main', 'an odd answer falls back to the branch tip');
  assert(
    diffBase(() => {
      throw new Error('no merge base');
    }, 'origin/main') === 'origin/main',
    'no merge base falls back to the branch tip',
  );
  assert(same(affectedFilters(['x'], {}, sha), [`...[${sha}]`]), 'the base reaches the filter');
  assert(
    same(Object.entries(mergeEdges({ 'apps/a': ['x', 'y'] }, { 'apps/a': ['y', 'z'], 'apps/b': ['x'] })).flat(2), [
      'apps/a',
      'x',
      'y',
      'z',
      'apps/b',
      'x',
    ]),
    'declared and detected edges merge without duplicates',
  );
  assert(detectedEdges()['apps/customer']?.includes('services/svc-trade'), 'a read the scan finds becomes an edge with no declaration');

  const ok = { changes: 'success', gates: 'success', format: 'success', build: 'success' };
  assert(sealNeeded(none, ok).length === 0, 'docs only needs no test job');
  assert(sealNeeded({ full: false, affected: true }, { ...ok, 'tests-full': 'success' }).length === 0, 'affected run green');
  assert(
    sealNeeded({ full: false, affected: true }, { ...ok, 'tests-full': 'skipped' }).length === 1,
    'skipped test job is a failure when tests were needed',
  );
  assert(sealNeeded({ full: true, affected: false }, { ...ok, 'tests-full': 'failure' }).length === 1, 'full run red');
  assert(sealNeeded({ full: true, affected: false }, { ...ok, build: 'failure', 'tests-full': 'success' }).length === 1, 'build red');
  assert(same(shardMatrix({ full: true }), ['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', '8/8']), 'a full run is split eight ways');
  assert(same(shardMatrix({ full: false, affected: true }), ['changed']), 'an affected run is one job');
  console.log('✓ ci-affected --self-test OK (' + (cases.length + 14) + ' fixtures)');
}

function githubOutput(flags) {
  const lines = Object.entries(flags).map(([k, v]) => `${k}=${v ? 'true' : 'false'}`);
  const dest = process.env.GITHUB_OUTPUT;
  if (dest) writeFileSync(dest, `${lines.join('\n')}\n`, { flag: 'a' });
  for (const line of lines) console.log(line);
  const shards = `shards=${JSON.stringify(shardMatrix(flags))}`;
  if (dest) writeFileSync(dest, `${shards}\n`, { flag: 'a' });
  console.log(shards);
}

function runSeal() {
  const flags = {
    full: process.env.FULL === 'true',
    affected: process.env.AFFECTED === 'true',
  };
  const results = {
    changes: process.env.CHANGES,
    gates: process.env.GATES,
    format: process.env.FORMAT,
    build: process.env.BUILD,
    'tests-full': process.env.T_FULL,
  };
  const problems = sealNeeded(flags, results);
  if (problems.length) {
    console.error('✖ CI merge seal failed:');
    for (const p of problems) {
      console.error(`  - ${p}`);
      console.error(`::error title=CI merge seal::${p}`);
    }
    process.exit(1);
  }
  console.log('✓ CI merge seal: required jobs succeeded');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  if (args.includes('--seal')) {
    runSeal();
    process.exit(0);
  }

  const filesIdx = args.indexOf('--files');
  let files;
  let forceFull = process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_EVENT_NAME === 'push';
  if (filesIdx >= 0) files = args.slice(filesIdx + 1);
  else files = gitChangedFiles();
  if (args.includes('--filters')) {
    for (const f of affectedFilters(files, readEdges(), diffBase())) console.log(f);
    process.exit(0);
  }
  if (args.includes('--build-filters')) {
    for (const f of buildFilters(files, readEdges(), diffBase())) console.log(f);
    process.exit(0);
  }
  const flags = classify(files, { forceFull });
  if (args.includes('--github-output')) githubOutput(flags);
  else console.log(JSON.stringify({ files, flags }, null, 2));
}

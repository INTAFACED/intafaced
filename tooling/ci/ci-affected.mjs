#!/usr/bin/env node
/**
 * CI affected-path classifier.
 *
 * A pull request runs the tests of what it changed, not the whole suite:
 *   full     — a change on the run-everything list (events, ledger-client, config, auth, lockfile, turbo and
 *              tsconfig, tooling, workflows, gate files) or any path outside the product dirs;
 *   affected — turbo runs the changed packages, their dependents and the readers listed in
 *              tooling/ci/test-read-edges.json (`--filters` prints the turbo filters);
 *              A lint rule or a gate's baseline file (isGateOnlyTooling) runs only the product tests that read it.
 *   neither  — docs only, or gate-only tooling no product test reads; the seal then needs no test job.
 * Apart from those, `rust` says whether CI's Rust job runs (format, clippy, tests: `pnpm rust:check`): a change to a
 * Rust file (isRustFile), to a TypeScript service a crate replaces (its code and the recorded answers the crate's tests
 * read: rustCrates), to what defines that job, and every run-everything run. A change to Rust files alone runs no
 * TypeScript tests.
 *
 *   node tooling/ci/ci-affected.mjs --files services/svc-protocol/src/x.ts
 *   node tooling/ci/ci-affected.mjs --github-output
 *   node tooling/ci/ci-affected.mjs --filters
 *   node tooling/ci/ci-affected.mjs --seal
 *
 * `push:main` and a merge queue's commit (`merge_group`, what main becomes) always classify as full (the trunk seal).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allEdges, pathReadEdges } from './cross-package-reads.mjs';
import { SPLIT } from './test-shards.mjs';

/** Run-everything list: a change here can break a consumer in any package, so the whole suite runs. */
export const FULL_TRIGGERS = [
  'tooling/',
  '.github/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  // Not packages/contracts/: its dependents are turbo's to pick, and the readers of its files the read scan's.
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

/**
 * Tooling only the Doctrine gates job judges, which runs on every pull request: the lint rules (`tooling/lint/`, whose
 * own tests are tooling tests) and a gate's baseline file (`tooling/ci/*baseline*.json`, read by its gate). A change
 * there runs the product tests that read it (GATE_ONLY_READS through pathReadEdges: packages/config's copy-rule test
 * reads tooling/lint/), never the whole suite. Before this, 26 bug fixes a day took all sixteen shards only for deleting
 * lines from tooling/ci/conflict-keys-baseline.json, which no unit test reads (project-state#3379).
 */
export const GATE_ONLY_TOOLING = ['tooling/lint/'];
const BASELINE = /^tooling\/ci\/[^/]*baseline[^/]*\.json$/;
export const isGateOnlyTooling = (file) => BASELINE.test(posix(file)) || GATE_ONLY_TOOLING.some((d) => matchesPrefix(file, d));
/** The paths a product test may read that isGateOnlyTooling covers: the lint folder and today's baseline files. */
function gateOnlyReads(root = fileURLToPath(new URL('../..', import.meta.url))) {
  const baselines = readdirSync(`${root}/tooling/ci`)
    .filter((n) => BASELINE.test(`tooling/ci/${n}`))
    .map((n) => `tooling/ci/${n}`);
  return [...GATE_ONLY_TOOLING, ...baselines];
}

/** Rust's own files: the code, every crate's manifest, the lock file, and the workspace's toolchain and lint config. */
const RUST_ROOT_FILES = new Set(['Cargo.lock', 'rust-toolchain.toml', 'clippy.toml', 'rustfmt.toml', 'deny.toml']);
export const isRustFile = (file) => {
  const f = posix(file);
  return (
    f.endsWith('.rs') ||
    f === 'Cargo.toml' ||
    f.endsWith('/Cargo.toml') ||
    RUST_ROOT_FILES.has(f) ||
    f.startsWith('crates/') ||
    f.startsWith('.cargo/')
  );
};
/**
 * The crates in `crates/`, each named after the TypeScript service it replaces. While a crate is built beside its
 * TypeScript service, it is tested against that service's recorded answers, so a change there runs the Rust job before
 * main does; once it replaced the service (`crates/svc-tax`), the answers live in the crate's own fixtures. Read from
 * the folder, never kept by hand.
 */
export function rustCrates(root = fileURLToPath(new URL('../..', import.meta.url))) {
  try {
    return readdirSync(`${root}/crates`, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
/**
 * Files outside `crates/` that the crates' tests read (`include_str!`): the compose file that starts svc-tax
 * (crates/svc-tax/tests/boot.rs), and each crate's own records, `packages/<package>/procedures/<crate>.schema.json`
 * (crates/svc-tax/tests/procedure_samples.rs, refusal_coverage.rs; crates/svc-academy/tests/procedure_records.rs). Another
 * service's records reach no crate, so a change to them runs no Rust job.
 */
const RUST_READS = new Set(['docker-compose.apps.yml']);
/** Source the Rust ledger's recorded tables come from (crates/svc-ledger/scripts/record-posting.mjs, checked in the Rust job). */
const RUST_READS_UNDER = ['packages/ledger-client/src/'];
const RECORDS_FILE = /^packages\/[^/]+\/procedures\/([^/]+)\.schema\.json$/;
/** A file the Rust job judges: a Rust file, a file the crates' tests read, or anything in a TypeScript service a crate replaces. */
export const reachesRust = (file, crates = rustCrates()) =>
  isRustFile(file) ||
  RUST_READS.has(posix(file)) ||
  RUST_READS_UNDER.some((dir) => posix(file).startsWith(dir)) ||
  crates.includes(RECORDS_FILE.exec(posix(file))?.[1] ?? '') ||
  crates.some((name) => posix(file).startsWith(`services/${name}/`));
/** What defines the Rust job (its steps, and the `rust:check` script it runs): a change to one runs it too. */
const RUST_JOB_FILES = ['.github/workflows/ci.yml', 'package.json'];

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
  // Reads the scan finds count too, so a test that reads another package needs no edge-list entry to be selected. The
  // same function feeds turbo.json's generated inputs (cross-package-reads.mjs turboReadInputs), so the two agree. The
  // reads of gate-only tooling are added here only: a test reads them when it runs, which no typecheck or build hashes.
  return mergeEdges(allEdges(), pathReadEdges(gateOnlyReads()));
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
 * Neither  — nothing to test (docs only, or gate-only tooling no test reads); the seal then needs no test job.
 * `edges` (readEdges' shape) says who reads gate-only tooling; read from the tree when one changed and none is given.
 */
export function classify(files, { forceFull = false, crates = rustCrates(), edges } = {}) {
  if (forceFull) return { full: true, affected: false, rust: true };
  const list = (files || []).map(posix).filter(Boolean);
  const rust = list.some((f) => reachesRust(f, crates) || RUST_JOB_FILES.includes(f));
  let affected = false;
  for (const file of list) {
    if (isGateOnlyTooling(file)) {
      edges ??= readEdges();
      if (Object.values(edges).some((reads) => reads.some((d) => matchesPrefix(file, d)))) affected = true;
      continue;
    }
    if (isGateFile(file)) return { full: true, affected: false, rust };
    if (isDoc(file)) continue;
    if (FULL_TRIGGERS.some((t) => matchesPrefix(file, t))) return { full: true, affected: false, rust };
    if (isRustFile(file) && !PRODUCT_DIRS.test(file)) continue; // the Rust job tests it
    if (PRODUCT_DIRS.test(file)) affected = true;
    else return { full: true, affected: false, rust }; // unknown root path: run everything, never a silent skip
  }
  return { full: false, affected, rust };
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

/**
 * A run that tests everything whatever changed: a push to main, and a merge queue's commit (`merge_group`), which is the
 * next main itself, holding several pull requests at once, so the affected selection of any one of them says too little.
 */
export function runsEverything(env) {
  return (env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'push') || env.GITHUB_EVENT_NAME === 'merge_group';
}

export const SHARD_COUNT = 16;

/**
 * The test job's matrix. A run-everything run is split SHARD_COUNT ways (tooling/ci/test-shards.mjs: the whole packages in
 * the first shards, then one shard per piece of each package in its SPLIT); an affected run is one job, `changed`,
 * unless it is wide: its tests include a SPLIT package (one too slow for one job), or turbo could not say which packages
 * it tests (`tested` null). A wide run takes the sixteen shards, which run every test the `changed` job would, and the rest.
 * (Failure it prevents: on 14 Nov 2026 every `changed` job whose packages held a SPLIT one took 17 to 37 minutes, runs
 * 43594422205, 43586760106, 43599805754 and 43616068781, against 1.8 to 6.5 for the others and 6.3 to 8.8 minutes wall
 * time for all sixteen shards.) The seal reads the matrix as one job: it is green only when every shard is.
 */
export function shardMatrix(flags, tested = []) {
  const all = Array.from({ length: SHARD_COUNT }, (_, i) => `${i + 1}/${SHARD_COUNT}`);
  if (flags.full) return all;
  if (flags.affected && (tested === null || tested.some((name) => SPLIT[name]))) return all;
  return ['changed'];
}

/**
 * The packages an affected run's `pnpm test` runs, by turbo's own dry run over the same filters; null when turbo cannot
 * say, which shardMatrix reads as wide (more tests, never fewer).
 */
export function testedPackages(filters, run = (args) => execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 << 20 })) {
  try {
    const dry = JSON.parse(run(['-s', 'turbo', 'run', 'test', '--dry-run=json', ...filters.map((f) => `--filter=${f}`)]));
    const names = dry.tasks.filter((t) => t.task === 'test' && t.command && t.command !== '<NONEXISTENT>').map((t) => t.package);
    return [...new Set(names)].sort();
  } catch {
    return null;
  }
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
  // The Rust job, when the change reaches Rust: skipped or missing is a failure then, as for the tests.
  if (flags.rust && results.rust !== 'success') problems.push(`rust was ${results.rust || 'missing'} (the change reaches Rust)`);
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

function githubOutput(flags, tested = []) {
  const lines = Object.entries(flags).map(([k, v]) => `${k}=${v ? 'true' : 'false'}`);
  const dest = process.env.GITHUB_OUTPUT;
  if (dest) writeFileSync(dest, `${lines.join('\n')}\n`, { flag: 'a' });
  for (const line of lines) console.log(line);
  if (tested === null) console.log('turbo could not list the tested packages: the sixteen shards run');
  else if (tested.length) console.log(`tested packages (${tested.length}): ${tested.join(' ')}`);
  const shards = `shards=${JSON.stringify(shardMatrix(flags, tested))}`;
  if (dest) writeFileSync(dest, `${shards}\n`, { flag: 'a' });
  console.log(shards);
}

function runSeal() {
  const flags = {
    full: process.env.FULL === 'true',
    affected: process.env.AFFECTED === 'true',
    rust: process.env.RUST === 'true',
  };
  const results = {
    changes: process.env.CHANGES,
    gates: process.env.GATES,
    format: process.env.FORMAT,
    build: process.env.BUILD,
    'tests-full': process.env.T_FULL,
    rust: process.env.RUST_RESULT,
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--seal')) {
    runSeal();
    process.exit(0);
  }

  // The pre-push hook's question: does this branch change what the Rust job judges? Prints true or false.
  if (args.includes('--rust-files')) {
    const crates = rustCrates();
    console.log(gitChangedFiles().some((f) => reachesRust(f, crates)) ? 'true' : 'false');
    process.exit(0);
  }

  const filesIdx = args.indexOf('--files');
  let files;
  let forceFull = runsEverything(process.env);
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
  if (args.includes('--github-output'))
    githubOutput(flags, flags.affected && !flags.full ? testedPackages(affectedFilters(files, readEdges(), diffBase())) : []);
  else console.log(JSON.stringify({ files, flags }, null, 2));
}

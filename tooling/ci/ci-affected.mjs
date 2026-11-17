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
 *   node tooling/ci/ci-affected.mjs --files services/svc-protocol/src/x.ts
 *   node tooling/ci/ci-affected.mjs --github-output
 *   node tooling/ci/ci-affected.mjs --filters
 *   node tooling/ci/ci-affected.mjs --seal
 *
 * `push:main` and a merge queue's commit (`merge_group`, what main becomes) always classify as full (the trunk seal).
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { allEdges } from './cross-package-reads.mjs';
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
  // Reads the scan finds count too, so a test that reads another package needs no edge-list entry to be selected. The
  // same function feeds turbo.json's generated inputs (cross-package-reads.mjs turboReadInputs), so the two agree.
  return allEdges();
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--seal')) {
    runSeal();
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

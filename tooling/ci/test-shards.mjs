#!/usr/bin/env node
/**
 * TEST SHARDS — splits the whole test suite across N parallel jobs on main (and on run-everything PRs).
 *
 * Every workspace with a `test` script belongs to exactly one shard, except the few in SPLIT: each of those runs in
 * pieces, one shard per piece, through vitest's own `--shard=<k>/<m>`, which splits the package's test files so the
 * pieces together run every file once. The other packages are weighed by their number of test files (a proxy for run
 * time) and packed largest first into the lightest of the remaining shards, so the split is deterministic and a new
 * package lands in a shard without anyone editing a list. Nothing is skipped: the shards together are the same set
 * `pnpm test` runs.
 *
 *   node tooling/ci/test-shards.mjs --shard 2/16          the turbo filters for shard 2 of 16, one per line
 *   node tooling/ci/test-shards.mjs --vitest-shard 2/16   the piece (`k/m`) shard 2 runs of its one package, or nothing
 *   node tooling/ci/test-shards.mjs --plan 16             every shard with its weight (for reading, not for CI)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUPS = ['apps', 'services', 'packages', 'tooling'];

/**
 * Packages too slow for one shard, and how many pieces each runs in. (Failure it prevents: one package was a whole
 * shard's run time, so the slowest shard set every run-everything CI run. Measured 6 Nov 2026 on main's CI runs
 * 42166557829 and 42167647396: vitest's own Duration for svc-pay 737 s, svc-identity 652 s, svc-p2p 487 s, svc-trade
 * 447 s, svc-bank 337 s; the next, customer, 242 s. Shard 3 of 8 (svc-pay) took 12.6 to 13.0 minutes of tests and
 * shard 4 of 8 (svc-identity, svc-p2p) 7.5 to 11.0, against 1.8 to 7.5 for the rest.) Each piece aims at about 250 s,
 * the slowest whole package's time. A package listed here that no longer has a test script fails test-shards.test.mjs.
 */
export const SPLIT = {
  '@intafaced/svc-pay': 3,
  '@intafaced/svc-identity': 3,
  '@intafaced/svc-p2p': 2,
  '@intafaced/svc-trade': 2,
  '@intafaced/svc-bank': 2,
};
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

function countTestFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) n += countTestFiles(join(dir, e.name));
    } else if (TEST_FILE.test(e.name)) n += 1;
  }
  return n;
}

/** Every workspace that has a `test` script: { name, weight }. */
export function testPackages(root = process.cwd()) {
  const out = [];
  for (const g of GROUPS) {
    if (!existsSync(join(root, g))) continue;
    for (const d of readdirSync(join(root, g)).sort()) {
      const file = join(root, g, d, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (!pkg.scripts?.test) continue;
      out.push({ name: pkg.name, weight: 1 + countTestFiles(join(root, g, d)) });
    }
  }
  return out;
}

/** Longest-processing-time packing: heaviest package first into the lightest shard. Deterministic. */
export function plan(packages, count) {
  const shards = Array.from({ length: count }, () => ({ weight: 0, names: [] }));
  const order = [...packages].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  for (const p of order) {
    const lightest = shards.reduce((best, s) => (s.weight < best.weight ? s : best), shards[0]);
    lightest.weight += p.weight;
    lightest.names.push(p.name);
  }
  for (const s of shards) s.names.sort();
  return shards;
}

/**
 * Every shard of a run-everything run, in order: the whole packages packed into the first shards, then one shard per
 * piece of each SPLIT package. A shard is { names, piece }: its packages (turbo filters) and, for a piece, `k/m`.
 */
export function shardList(packages, count, split = SPLIT) {
  const pieces = packages
    .filter((p) => split[p.name])
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((p) => Array.from({ length: split[p.name] }, (_, i) => ({ weight: 0, names: [p.name], piece: `${i + 1}/${split[p.name]}` })));
  const whole = count - pieces.length;
  if (whole < 1) throw new Error(`${count} shards leave none for the packages outside SPLIT (${pieces.length} pieces)`);
  const packed = plan(
    packages.filter((p) => !split[p.name]),
    whole,
  ).map((s) => ({ ...s, piece: null }));
  return [...packed, ...pieces];
}

/**
 * Problems with a set of shards against the packages `pnpm test` runs: a package in no shard, a whole package in two
 * shards, a split package whose pieces are not exactly 1/m to m/m each once, a piece shard holding more than its one
 * package, or a shard with no package (an empty filter list would run everything). Empty means the shards run every
 * package's tests exactly once.
 */
export function coverage(list, packages) {
  const problems = [];
  const known = new Map(packages.map((p) => [p.name, p]));
  const whole = new Map();
  const pieces = new Map();
  list.forEach((s, i) => {
    if (!s.names.length) problems.push(`shard ${i + 1} has no package`);
    if (s.piece && s.names.length !== 1) problems.push(`shard ${i + 1} runs piece ${s.piece} of ${s.names.length} packages`);
    for (const n of s.names) {
      if (!known.has(n)) problems.push(`${n} has no test script`);
      if (s.piece) pieces.set(n, [...(pieces.get(n) ?? []), s.piece]);
      else whole.set(n, (whole.get(n) ?? 0) + 1);
    }
  });
  for (const name of known.keys()) {
    const w = whole.get(name) ?? 0;
    const p = pieces.get(name) ?? [];
    if (w + p.length === 0) problems.push(`${name} is in no shard`);
    else if (w > 1 || (w && p.length)) problems.push(`${name} runs more than once`);
    else if (p.length) {
      const m = Number(p[0].split('/')[1]);
      const want = Array.from({ length: m }, (_, i) => `${i + 1}/${m}`);
      if (JSON.stringify([...p].sort((a, b) => parseInt(a) - parseInt(b))) !== JSON.stringify(want))
        problems.push(`${name} runs pieces ${p.join(', ')}, not ${want.join(', ')}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--plan')) {
    const count = Number(args[args.indexOf('--plan') + 1]);
    shardList(testPackages(), count).forEach((s, i) =>
      console.log(`${i + 1}/${count} ${s.piece ? `piece ${s.piece}` : `weight ${s.weight}`}: ${s.names.join(' ')}`),
    );
  } else if (args.includes('--shard') || args.includes('--vitest-shard')) {
    const flag = args.includes('--shard') ? '--shard' : '--vitest-shard';
    const m = /^(\d+)\/(\d+)$/.exec(args[args.indexOf(flag) + 1] ?? '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
      console.error(`usage: test-shards.mjs ${flag} <i>/<n>`);
      process.exit(2);
    }
    const all = testPackages();
    const list = shardList(all, Number(m[2]));
    const problems = coverage(list, all);
    // A SPLIT name that matches no package would quietly turn its pieces into whole-package shards.
    for (const name of Object.keys(SPLIT))
      if (!all.some((p) => p.name === name)) problems.push(`${name} is in SPLIT but has no test script`);
    if (problems.length) {
      for (const p of problems) console.error(`::error::the test shards do not run every package once: ${p}`);
      process.exit(1);
    }
    const shard = list[Number(m[1]) - 1];
    if (flag === '--shard') for (const name of shard.names) console.log(name);
    else if (shard.piece) console.log(shard.piece);
  } else {
    console.error('usage: test-shards.mjs --shard <i>/<n> | --vitest-shard <i>/<n> | --plan <n>');
    process.exit(2);
  }
}

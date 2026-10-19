#!/usr/bin/env node
/**
 * TEST SHARDS — splits the whole test suite across N parallel jobs on main (and on run-everything PRs).
 *
 * Every workspace with a `test` script belongs to exactly one shard. Packages are weighed by their number of test
 * files (a proxy for run time) and packed largest first into the lightest shard, so the split is deterministic and
 * a new package lands in a shard without anyone editing a list. Nothing is skipped: the shards together are the
 * same set `pnpm test` runs.
 *
 *   node tooling/ci/test-shards.mjs --shard 2/4      the turbo filters for shard 2 of 4, one per line
 *   node tooling/ci/test-shards.mjs --plan 4         every shard with its weight (for reading, not for CI)
 *   node tooling/ci/test-shards.mjs --self-test
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUPS = ['apps', 'services', 'packages', 'tooling'];
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

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const pk = [
    { name: 'a', weight: 50 },
    { name: 'b', weight: 30 },
    { name: 'c', weight: 30 },
    { name: 'd', weight: 10 },
    { name: 'e', weight: 5 },
  ];
  const shards = plan(pk, 3);
  const all = shards.flatMap((s) => s.names).sort();
  assert(JSON.stringify(all) === '["a","b","c","d","e"]', 'every package is in exactly one shard');
  assert(JSON.stringify(plan(pk, 3)) === JSON.stringify(shards), 'the plan is deterministic');
  assert(Math.max(...shards.map((s) => s.weight)) <= 50, 'no shard is heavier than the heaviest package here');
  assert(plan(pk, 8).flatMap((s) => s.names).length === 5, 'more shards than packages still covers each once');
  assert(
    plan([], 4).every((s) => s.names.length === 0),
    'an empty set gives empty shards',
  );
  // The real workspace: shards are disjoint and together equal the set `pnpm test` runs.
  const real = testPackages();
  assert(real.length > 0, 'the workspace has test packages');
  const names = plan(real, 4).flatMap((s) => s.names);
  assert(new Set(names).size === names.length, 'no package is in two shards');
  assert(names.length === real.length, 'the shards cover every package with a test script');
  console.log(`✓ test-shards --self-test OK (${real.length} packages in 4 shards)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
  } else if (args.includes('--plan')) {
    const count = Number(args[args.indexOf('--plan') + 1]);
    plan(testPackages(), count).forEach((s, i) => console.log(`${i + 1}/${count} weight ${s.weight}: ${s.names.join(' ')}`));
  } else if (args.includes('--shard')) {
    const m = /^(\d+)\/(\d+)$/.exec(args[args.indexOf('--shard') + 1] ?? '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
      console.error('usage: test-shards.mjs --shard <i>/<n>');
      process.exit(2);
    }
    for (const name of plan(testPackages(), Number(m[2]))[Number(m[1]) - 1].names) console.log(name);
  } else {
    console.error('usage: test-shards.mjs --shard <i>/<n> | --plan <n> | --self-test');
    process.exit(2);
  }
}

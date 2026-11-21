#!/usr/bin/env node
/**
 * The seeded stack snapshot (project-state#3597): a pull request's journeys run starts from the TEST stack another run
 * already seeded, instead of seeding its own, when nothing the seed is made from changed and the copy is fresh.
 * Seeding (the stack's first start, the TEST gates, the market maker's two TEST accounts and the TEST chart history)
 * was about 6.5 of the build job's 10.7 minutes on PR run 44913280955, and every shard waits for that job.
 *
 *   node tooling/scripts/local-test-snapshot.mjs key            the snapshot's key: a hash of every input below
 *   node tooling/scripts/local-test-snapshot.mjs files          the inputs, one per line
 *   node tooling/scripts/local-test-snapshot.mjs fresh <file>   exit 0 when the ISO time in <file> is under MAX_AGE_HOURS old
 *
 * The inputs are what decides the seeded state: the code that writes the seed (the seed scripts and every repository file
 * they import, followed by code, so a new import is an input without anyone listing it), the schemas it is written into
 * (every migration), the chain's contracts, and the toolchain (the lockfile, Node, the workflow and its NATS binary).
 * A change to any of them gives another key, and the run seeds afresh.
 * What is not an input: a service's own runtime code. A pull request's services start on data main's services wrote, as a
 * deploy starts on the data the release before it wrote, and run every migration first. A pull request that breaks
 * seeding itself through service code is caught on main: main's runs never restore a snapshot, they always seed afresh.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The scripts the build job's `Seed the stack` step runs, and the chain seed `start` runs. Their imports are followed. */
export const SEED_ENTRIES = [
  'tooling/scripts/local-test-stack.mjs',
  'tooling/scripts/local-test-gates.mjs',
  'tooling/scripts/local-test-market.mjs',
  'services/svc-protocol/scripts/seed-test-chain.ts',
];

/** Inputs no import reaches: data the seed reads, the schemas, the chain's contracts and the toolchain (git pathspec globs). */
export const SEED_INPUT_GLOBS = [
  'pnpm-lock.yaml',
  '.node-version',
  '.github/workflows/real-app-journeys.yml',
  '.github/actions/nats-server/**',
  'tooling/scripts/local-stack-fixtures/**',
  'services/*/drizzle/**',
  'services/*/scripts/migrate.*',
  'services/svc-ops/src/db/migrate.ts',
  'crates/*/migrations/**',
  'services/svc-protocol/contracts/**',
  'services/svc-trade/fixtures/**',
];

/**
 * A snapshot older than this seeds afresh. The TEST chart history ends when it was written (210 bars of 15 minutes, up
 * to that moment), and a shard already runs journeys up to about 70 minutes after the build job seeded; main seeds a
 * fresh one on each of its runs, about every 30 to 40 minutes on a working day (main's runs of 21 Nov 2026).
 */
export const MAX_AGE_HOURS = 2;

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The repository file a relative import names, or undefined when none exists (`.js` in TypeScript names its `.ts`). */
export function resolveImport(fromFile, spec, exists) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const tries = [base];
  if (/\.(m?js)$/.test(base)) tries.push(base.replace(/\.(m?)js$/, '.$1ts'));
  if (!/\.[a-z]+$/.test(base)) tries.push(`${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.mjs`);
  return tries.find((t) => !t.startsWith('..') && exists(t));
}

/** Every repository file the entries import, directly or through each other, the entries included. */
export function importClosure(entries, { read, exists }) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(IMPORT)) {
      const hit = resolveImport(file, m[1], exists);
      if (hit && !seen.has(hit)) queue.push(hit);
    }
  }
  return [...seen];
}

/** The tracked files the globs name, by git (so build outputs and node_modules never count). */
export function gitListed(root, globs) {
  const r = spawnSync('git', ['ls-files', '-z', '--', ...globs.map((g) => `:(glob)${g}`)], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** Every input of the seeded state, sorted. */
export function snapshotInputs({ root = REPO, list = (g) => gitListed(root, g) } = {}) {
  const exists = (f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile();
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return [...new Set([...importClosure(SEED_ENTRIES, { read, exists }), ...list(SEED_INPUT_GLOBS)])].sort();
}

/** The snapshot's key: a hash of each input's path and bytes. */
export function snapshotKey(opts = {}) {
  const root = opts.root ?? REPO;
  const hash = crypto.createHash('sha256');
  for (const f of snapshotInputs(opts))
    hash
      .update(f)
      .update('\0')
      .update(fs.readFileSync(path.join(root, f)))
      .update('\0');
  return hash.digest('hex').slice(0, 24);
}

/** Whether a snapshot seeded at `seededAt` (ISO) may still be used at `now`; a time that can't be read never is. */
export function snapshotFresh(seededAt, now = Date.now()) {
  const t = Date.parse(String(seededAt).trim());
  if (!Number.isFinite(t)) return { fresh: false, why: `its seeding time "${String(seededAt).trim()}" can't be read` };
  const minutes = Math.round((now - t) / 60000);
  if (minutes < -5) return { fresh: false, why: `it says it was seeded ${-minutes} minutes in the future` };
  if (minutes > MAX_AGE_HOURS * 60) return { fresh: false, why: `it was seeded ${minutes} minutes ago, over ${MAX_AGE_HOURS} hours` };
  return { fresh: true, why: `it was seeded ${minutes} minutes ago` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'key') process.stdout.write(`${snapshotKey()}\n`);
  else if (cmd === 'files') process.stdout.write(`${snapshotInputs().join('\n')}\n`);
  else if (cmd === 'fresh' && arg) {
    const { fresh, why } = snapshotFresh(fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : '');
    process.stdout.write(`snapshot ${fresh ? 'fresh' : 'stale'}: ${why}\n`);
    process.exit(fresh ? 0 : 1);
  } else {
    process.stderr.write('usage: local-test-snapshot.mjs key | files | fresh <seeded-at file>\n');
    process.exit(2);
  }
}

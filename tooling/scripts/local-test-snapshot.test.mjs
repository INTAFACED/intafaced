import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  importClosure,
  MAX_AGE_HOURS,
  REFRESH_AFTER_MINUTES,
  resolveImport,
  SEED_ENTRIES,
  snapshotDue,
  snapshotFresh,
  snapshotInputs,
  snapshotKey,
  snapshotsToDrop,
} from './local-test-snapshot.mjs';

/** A git repository holding the seed entries, one import each way, a migration, a fixture and an unrelated service file. */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
  const files = {
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '.node-version': '22\n',
    '.github/workflows/real-app-journeys.yml': 'name: Real-app journeys\n',
    '.github/workflows/journeys-snapshot.yml': 'name: Journeys snapshot\n',
    '.github/actions/stack-seed/action.yml': 'name: Seed the TEST stack\n',
    'tooling/scripts/local-test-stack.mjs':
      "import { a } from './local-test-facts.mjs';\nconst m = await import('./local-stack-services/trade.mjs');\n",
    'tooling/scripts/local-test-facts.mjs': "export const a = 1;\nimport '../../apps/customer/deployment/headers.mjs';\n",
    'tooling/scripts/local-stack-services/trade.mjs': 'export default {};\n',
    'apps/customer/deployment/headers.mjs': 'export {};\n',
    'tooling/scripts/local-test-gates.mjs': 'export {};\n',
    'tooling/scripts/local-test-market.mjs': 'export {};\n',
    'services/svc-protocol/scripts/seed-test-chain.ts': "import { x } from '../src/chain-parts.js';\n",
    'services/svc-protocol/src/chain-parts.ts': 'export const x = 1;\n',
    'services/svc-trade/drizzle/0001_init.sql': 'CREATE TABLE trade.t (id int);\n',
    'crates/svc-tax/migrations/0001.sql': 'CREATE TABLE tax.t (id int);\n',
    'tooling/scripts/local-stack-fixtures/video.webm': 'TEST\n',
    'services/svc-trade/src/router.ts': 'export const router = 1;\n',
    'apps/customer/src/app.tsx': 'export {};\n',
  };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q');
  git('add', '-A');
  return { root, write: (f, body) => fs.writeFileSync(path.join(root, f), body), git };
}

test('the inputs are the seed entries, everything they import, the migrations, the fixtures and the toolchain', () => {
  const { root } = repo();
  assert.deepEqual(snapshotInputs({ root }), [
    '.github/actions/stack-seed/action.yml',
    '.github/workflows/journeys-snapshot.yml',
    '.github/workflows/real-app-journeys.yml',
    '.node-version',
    'apps/customer/deployment/headers.mjs',
    'crates/svc-tax/migrations/0001.sql',
    'pnpm-lock.yaml',
    'services/svc-protocol/scripts/seed-test-chain.ts',
    'services/svc-protocol/src/chain-parts.ts',
    'services/svc-trade/drizzle/0001_init.sql',
    'tooling/scripts/local-stack-fixtures/video.webm',
    'tooling/scripts/local-stack-services/trade.mjs',
    'tooling/scripts/local-test-facts.mjs',
    'tooling/scripts/local-test-gates.mjs',
    'tooling/scripts/local-test-market.mjs',
    'tooling/scripts/local-test-stack.mjs',
  ]);
});

// The snapshot rebuilds when any input changes (the issue's bar): each planted change below gives another key.
for (const [what, file, body] of [
  ['a migration', 'services/svc-trade/drizzle/0001_init.sql', 'CREATE TABLE trade.t (id bigint);\n'],
  ['a Rust migration', 'crates/svc-tax/migrations/0001.sql', '-- changed\n'],
  ['a seed entry', 'tooling/scripts/local-test-gates.mjs', 'export const gate = 2;\n'],
  ['a module an entry imports', 'tooling/scripts/local-test-facts.mjs', 'export const a = 2;\n'],
  ['a module imported dynamically', 'tooling/scripts/local-stack-services/trade.mjs', 'export default { x: 1 };\n'],
  ['a TypeScript module the chain seed imports as .js', 'services/svc-protocol/src/chain-parts.ts', 'export const x = 2;\n'],
  ['the lockfile', 'pnpm-lock.yaml', 'lockfileVersion: 10\n'],
  ['Node', '.node-version', '24\n'],
  ['the workflow', '.github/workflows/real-app-journeys.yml', 'name: changed\n'],
  ["main's snapshot workflow", '.github/workflows/journeys-snapshot.yml', 'name: changed\n'],
  ['the seed action', '.github/actions/stack-seed/action.yml', 'name: changed\n'],
  ['a seed fixture', 'tooling/scripts/local-stack-fixtures/video.webm', 'TEST 2\n'],
]) {
  test(`a change to ${what} gives another key`, () => {
    const { root, write } = repo();
    const before = snapshotKey({ root });
    write(file, body);
    assert.notEqual(snapshotKey({ root }), before);
  });
}

test('a new migration file gives another key', () => {
  const { root, write, git } = repo();
  const before = snapshotKey({ root });
  write('services/svc-trade/drizzle/0002_more.sql', 'ALTER TABLE trade.t ADD COLUMN n int;\n');
  git('add', '-A');
  assert.notEqual(snapshotKey({ root }), before);
});

test('a new import of a file nobody listed makes that file an input', () => {
  const { root, write } = repo();
  write('tooling/scripts/local-test-gates.mjs', "import './local-test-new.mjs';\n");
  write('tooling/scripts/local-test-new.mjs', 'export {};\n');
  assert.ok(snapshotInputs({ root }).includes('tooling/scripts/local-test-new.mjs'));
  const before = snapshotKey({ root });
  write('tooling/scripts/local-test-new.mjs', 'export const changed = 1;\n');
  assert.notEqual(snapshotKey({ root }), before);
});

test("a change to a service's runtime code or the app keeps the key: main's fresh seed judges those", () => {
  const { root, write } = repo();
  const before = snapshotKey({ root });
  write('services/svc-trade/src/router.ts', 'export const router = 2;\n');
  write('apps/customer/src/app.tsx', 'export const app = 2;\n');
  assert.equal(snapshotKey({ root }), before);
});

test('an untracked file under a glob is not an input (build outputs never count)', () => {
  const { root, write } = repo();
  const before = snapshotKey({ root });
  write('services/svc-trade/drizzle/meta.generated.json', '{}\n');
  assert.equal(snapshotKey({ root }), before);
});

test("this repository's inputs hold every seed entry and the TypeScript and Rust migrations", () => {
  const inputs = snapshotInputs();
  for (const e of SEED_ENTRIES) assert.ok(inputs.includes(e), e);
  assert.ok(inputs.some((f) => f.startsWith('services/svc-identity/drizzle/')));
  assert.ok(inputs.some((f) => f.startsWith('crates/svc-ledger/migrations/')));
  assert.ok(inputs.includes('tooling/scripts/local-stack-services/ledger.mjs'));
  assert.ok(!inputs.some((f) => f.includes('node_modules/')));
});

test('resolveImport finds .ts behind .js and never leaves the repository', () => {
  const have = new Set(['a/b.ts', 'a/c.mjs', 'a/d/index.ts']);
  const exists = (f) => have.has(f);
  assert.equal(resolveImport('a/x.ts', './b.js', exists), 'a/b.ts');
  assert.equal(resolveImport('a/x.mjs', './c.mjs', exists), 'a/c.mjs');
  assert.equal(resolveImport('a/x.ts', './d', exists), 'a/d/index.ts');
  assert.equal(
    resolveImport('a/x.ts', '../../outside.mjs', () => true),
    undefined,
  );
  assert.deepEqual(importClosure(['a/x.ts'], { read: () => "import './b.js'", exists: (f) => f === 'a/x.ts' || exists(f) }).sort(), [
    'a/b.ts',
    'a/x.ts',
  ]);
});

test('a snapshot is fresh up to MAX_AGE_HOURS and never when its time is unreadable or ahead', () => {
  const now = Date.parse('2026-11-21T15:00:00Z');
  assert.equal(snapshotFresh('2026-11-21T14:00:00Z\n', now).fresh, true);
  assert.equal(snapshotFresh(new Date(now - MAX_AGE_HOURS * 3600000).toISOString(), now).fresh, true);
  assert.equal(snapshotFresh(new Date(now - MAX_AGE_HOURS * 3600000 - 60000).toISOString(), now).fresh, false);
  assert.equal(snapshotFresh('', now).fresh, false);
  assert.equal(snapshotFresh('yesterday', now).fresh, false);
  assert.equal(snapshotFresh('2026-11-21T16:00:00Z', now).fresh, false);
});

const entry = (id, key, minutesAgo, now) => ({ id, key, created_at: new Date(now - minutesAgo * 60000).toISOString() });

// Replayed from main's cache on 22 Nov 2026 (project-state#3703): 85c25067f changed the seed inputs at 07:41 UTC, main
// held only the snapshot of the key before it (kept 07:41 by run 44998561110), and its next one came at 08:11, behind
// main's full run. Every pull request run between them seeded its own (45000417817, 45000371474, 45000260095, 44999592041).
test('main needs a snapshot as soon as a push changes the key, though it holds a fresh one of the old key', () => {
  const now = Date.parse('2026-11-22T07:42:30Z');
  const main = [entry(1, 'real-app-journeys-snapshot-2a0041841c4f20db5655ab47-44998561110-1', 1, now)];
  assert.equal(snapshotDue(main, '67971df8d5ce85cc60a046a4', now).due, true);
  assert.equal(snapshotDue(main, '2a0041841c4f20db5655ab47', now).due, false);
});

test(`main keeps a new snapshot of an unchanged key once its newest is ${REFRESH_AFTER_MINUTES} minutes old, well inside MAX_AGE_HOURS`, () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  const key = '67971df8d5ce85cc60a046a4';
  const at = (m) => [
    entry(1, `real-app-journeys-snapshot-${key}-1-1`, m, now),
    entry(2, `real-app-journeys-snapshot-${key}-2-1`, m + 30, now),
  ];
  assert.equal(snapshotDue(at(REFRESH_AFTER_MINUTES - 1), key, now).due, false);
  assert.equal(snapshotDue(at(REFRESH_AFTER_MINUTES), key, now).due, true);
  assert.ok(REFRESH_AFTER_MINUTES + 15 < MAX_AGE_HOURS * 60, 'a new one is kept before the old one goes stale');
  assert.equal(
    snapshotDue([entry(1, `real-app-journeys-snapshot-${key}x-1-1`, 1, now)], key, now).due,
    true,
    'a longer key is another key',
  );
});

test('a kept snapshot drops the older ones of its key and the stale ones, and leaves a fresh one of another key', () => {
  const now = Date.parse('2026-11-22T08:12:00Z');
  const kept = 'real-app-journeys-snapshot-67971df8d5ce85cc60a046a4-45000747271-1';
  const caches = [
    entry(1, kept, 0, now),
    entry(2, 'real-app-journeys-snapshot-67971df8d5ce85cc60a046a4-44999000000-1', 20, now),
    entry(3, 'real-app-journeys-snapshot-2a0041841c4f20db5655ab47-44998561110-1', 30, now),
    entry(4, 'real-app-journeys-snapshot-fe440db626a2745b7935f4e2-44990000000-1', MAX_AGE_HOURS * 60 + 1, now),
    entry(5, 'real-app-journeys-seed-5ce8e61fe', MAX_AGE_HOURS * 60 + 1, now),
  ];
  assert.deepEqual(snapshotsToDrop(caches, kept, now), [2, 4]);
});

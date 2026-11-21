// The posting and post-recipe slices' TypeScript proofs against the Rust binary, run and judged in one command
// (`vitest.config.mts` names the five projects). From the repository root, with Postgres and NATS up and the binary built:
//   cargo build -p svc-ledger
//   TEST_DATABASE_URL=postgres://…/<admin>_test NATS_URL=nats://127.0.0.1:4222 node crates/svc-ledger/tests/conformance/run.mjs
// It passes when:
// - every conformance case passes or fails the same way through the TypeScript door and the Rust one, with the same
//   failure (a case both fail is the door refusing before the engine, which the suite, written for engines, does not
//   expect: the input schema, the recipe gate);
// - every case of the slices' own Postgres tests (the four binding files, `post-recipe-door.pg.test.ts`) passes on the
//   Rust door;
// - every case of the engine's Postgres tests ends the same through the TypeScript door and the Rust one.
// A fresh NATS is needed per run: the binary refuses a stream left by another run over the same subjects.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const config = fileURLToPath(new URL('./vitest.config.mts', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'ledger-conformance-'));

function run(name, projects) {
  const file = join(out, `${name}.json`);
  const r = spawnSync(
    join(root, 'node_modules/.bin/vitest'),
    ['run', '--config', config, ...projects.flatMap((p) => ['--project', p]), '--reporter=json', `--outputFile=${file}`],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (r.error) throw r.error;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// A case's result: its status and its failure's first line, with the ids a run makes up (uuids, hashes) masked.
const said = (t) => {
  const why = (t.failureMessages[0] ?? '')
    .split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')
    .replace(/[0-9a-f]{64}/g, '<hash>');
  return `${t.status}${why ? `: ${why}` : ''}`;
};
const rel = (f) => f.replace(root, '');

// The one engine case that is a check of the test harness, not of a door: it asserts `createTestDb` gave the run its own
// schema. The Rust binary serves the fixed `ledger` schema, so its book is a database of its own instead.
const NOT_A_DOOR = new Map([
  [
    'services/svc-ledger/src/ledger/postgres-ledger.test.ts > PostgresLedger svc-ledger — database-level guarantees uses a unique schema so parallel suites cannot share state',
    "createTestDb's own schema name; the Rust book is its own database",
  ],
]);
let failed = false;

// 1. Conformance, both doors in one report, and the slices' own Postgres tests (binding, postRecipe) on the Rust door.
const door = run('door', ['conformance', 'binding-pg', 'post-recipe-pg']);
const conf = { 'ts door': new Map(), 'rust door': new Map() };
const binding = { passed: 0, other: [] };
for (const file of door.testResults) {
  if (!file.name.endsWith('.conformance.ts')) {
    if (file.assertionResults.length === 0) binding.other.push(`${rel(file.name)}: no case ran (${file.message ?? file.status})`);
    for (const t of file.assertionResults) {
      if (t.status === 'passed') binding.passed++;
      else binding.other.push(`${rel(file.name)} > ${t.fullName}\n    ${said(t)}`);
    }
    continue;
  }
  for (const t of file.assertionResults) {
    const d = Object.keys(conf).find((k) => t.ancestorTitles[0] === `ledger conformance — ${k}`);
    if (!d) throw new Error(`a case outside both runs: ${t.fullName}`);
    conf[d].set(t.ancestorTitles.slice(1).concat(t.title).join(' > '), said(t));
  }
}

function compare(label, ts, rust) {
  let differ = 0;
  for (const name of new Set([...ts.keys(), ...rust.keys()])) {
    if (NOT_A_DOOR.has(name)) {
      console.log(`  not a door: ${name}\n    ${NOT_A_DOOR.get(name)} (ts ${ts.get(name)}; rust ${rust.get(name)})`);
      continue;
    }
    if (ts.get(name) !== rust.get(name)) {
      differ++;
      console.error(`differs: ${name}\n  ts:   ${ts.get(name)}\n  rust: ${rust.get(name)}`);
    }
  }
  const count = (m, s) => [...m.values()].filter((v) => v.startsWith(s)).length;
  console.log(
    `${label}: ${ts.size} cases; ts door ${count(ts, 'passed')} passed, ${count(ts, 'failed')} failed; rust door ${count(rust, 'passed')} passed, ${count(rust, 'failed')} failed; ${differ} differ`,
  );
  for (const [name, v] of ts) if (!v.startsWith('passed') && v === rust.get(name)) console.log(`  both: ${name}\n    ${v}`);
  if (differ || ts.size === 0) failed = true;
}

compare('conformance', conf['ts door'], conf['rust door']);
console.log(`the slices' Postgres tests on the Rust door: ${binding.passed} passed, ${binding.other.length} not`);
for (const o of binding.other) console.error(`  ${o}`);
if (binding.passed === 0 || binding.other.length) failed = true;

// 2. The engine's tests, once through each door.
const cases = (report) => {
  const m = new Map();
  for (const file of report.testResults) {
    if (file.assertionResults.length === 0) m.set(`${rel(file.name)} (file)`, `failed: ${file.message ?? file.status}`);
    for (const t of file.assertionResults) m.set(`${rel(file.name)} > ${t.fullName}`, said(t));
  }
  return m;
};
compare('engine', cases(run('engine-ts', ['engine-ts-door'])), cases(run('engine-rust', ['engine-rust-door'])));

process.exit(failed ? 1 : 0);

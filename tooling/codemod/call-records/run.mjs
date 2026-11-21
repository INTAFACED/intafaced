#!/usr/bin/env node
// The whole call-records codemod for one service, end to end (the steps this file runs):
//   1. index.mjs writes the records, mounts them in the router and moves every caller;
//   2. contracts is built and samples.mjs writes each record's samples, and names any record JSON Schema can't carry;
//   3. portable.mjs gives a refused construct with an exact JSON form that form in its source, and step 2 runs again;
//      any record still refused: everything step 1 wrote is put back (portable.mjs's edits kept) and step 1 runs again
//      without those calls (they stay as they were);
//   4. with --refusals, refusals.mjs lists what the service's own tests see each new record's handler refuse;
//   5. procedures:write regenerates the registry and procedures/<service>.schema.json;
//   with --door (a service the Rust door serves, its router read --from-rev), door-check.mjs holds each record to it;
//   6. doubles.mjs gives every test's API client double that reaches a record caller a `call` (its own query or mutate).
// It starts only on a clean tree (nothing uncommitted under apps/, services/ or packages/contracts/), so step 3 can put
// back exactly what step 1 wrote.
//
//   node tooling/codemod/call-records/run.mjs --module notify [--service svc-notify] [--paths a.,b.] [--refusals]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const here = (f) => join(REPO, 'tooling/codemod/call-records', f);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8' });

export function run(argv) {
  const refusals = argv.includes('--refusals');
  const pass = argv.filter((a) => a !== '--refusals');
  const service =
    pass[pass.indexOf('--service') + 1] && pass.includes('--service')
      ? pass[pass.indexOf('--service') + 1]
      : `svc-${pass[pass.indexOf('--module') + 1]}`;

  const dirty = out('git', [
    'status',
    '--porcelain',
    '--',
    'apps',
    'services',
    'packages/contracts/src',
    'packages/contracts/procedures',
  ]).trim();
  if (dirty) {
    console.error(`commit or put back these first, so a retry can undo exactly what the codemod wrote:\n${dirty}`);
    process.exit(1);
  }

  const door = pass.includes('--door') ? ['--door', pass[pass.indexOf('--door') + 1]] : [];
  const summary = join(tmpdir(), `call-records-${process.pid}.json`);
  const unportable = join(tmpdir(), `call-records-unportable-${process.pid}.json`);
  const step1 = (extra = []) => {
    sh('node', [here('index.mjs'), ...pass, '--write', '--json', summary, ...extra], { stdio: ['ignore', 'ignore', 'inherit'] });
    return JSON.parse(readFileSync(summary, 'utf8'));
  };
  const recordFiles = () =>
    out('git', ['status', '--porcelain', '--', 'packages/contracts/src'])
      .split('\n')
      .map((l) => l.slice(3))
      .filter((f) => /-(procedures|records)\.ts$/.test(f));
  const build = () => sh('pnpm', ['--filter', '@intafaced/contracts', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const putBack = () => {
    sh('git', ['checkout', '--', 'apps', 'services', 'packages/contracts/src']);
    sh('git', ['clean', '-fdq', '--', 'apps', 'services', 'packages/contracts/src']);
  };

  // Steps 2 and 3, with portable.mjs between: a record the export refuses for a construct with an exact JSON form is fixed
  // in its schema's source and tried again. What portable.mjs edits in files the repo already has is kept across a put
  // back (as a patch); records still refused are put back and left out, until a round leaves none.
  const tracked = new Set(out('git', ['ls-files', '--', 'apps', 'services', 'packages/contracts/src']).split('\n').filter(Boolean));
  const kept = new Set();
  const patchFile = join(tmpdir(), `call-records-portable-${process.pid}.patch`);
  const skipFile = join(tmpdir(), `call-records-skip-${process.pid}.json`);
  let skip = {};
  let result;
  for (let round = 0; ; round++) {
    result = step1(Object.keys(skip).length ? ['--skip-file', skipFile] : []);
    build();
    let skipped;
    for (;;) {
      sh('node', [here('samples.mjs'), '--unportable', unportable, ...door, ...recordFiles()]);
      skipped = JSON.parse(readFileSync(unportable, 'utf8'));
      if (!Object.keys(skipped).length) break;
      const fixed = JSON.parse(out('node', [here('portable.mjs'), '--unportable', unportable, '--write', ...door, ...recordFiles()]));
      if (!fixed.fixed) break;
      for (const f of fixed.files) if (tracked.has(f)) kept.add(f);
      build();
    }
    if (!Object.keys(skipped).length) break;
    if (round > 5) throw new Error(`records still refused after ${round} rounds: ${Object.keys(skipped).join(', ')}`);
    const patch = kept.size ? out('git', ['diff', '--', ...kept]) : '';
    putBack();
    if (patch) {
      writeFileSync(patchFile, patch);
      sh('git', ['apply', patchFile]);
    }
    skip = { ...skip, ...skipped };
    writeFileSync(skipFile, JSON.stringify(skip));
  }
  sh(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...recordFiles()]);
  if (refusals) {
    build();
    sh('node', [here('refusals.mjs'), '--service', service, ...recordFiles()]);
    sh(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...recordFiles()]);
  }
  build();
  // A door's records are held to the door before anything else reads them: kind, access and the exact input tree.
  if (door.length) sh('node', [here('door-check.mjs'), ...door, '--service', service, ...recordFiles()]);
  sh('pnpm', ['procedures:write'], { cwd: join(REPO, 'packages/contracts'), stdio: ['ignore', 'ignore', 'inherit'] });
  sh('node', [here('doubles.mjs'), '--write'], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (const f of [summary, unportable, patchFile, skipFile]) if (existsSync(f)) rmSync(f);
  console.log(JSON.stringify({ service, records: result.records.length, rewritten: result.rewritten, hand: result.hand }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) run(process.argv.slice(2));

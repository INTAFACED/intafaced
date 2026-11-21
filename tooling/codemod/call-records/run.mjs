#!/usr/bin/env node
// The whole call-records codemod for one service, end to end (the steps this file runs):
//   1. index.mjs writes the records, mounts them in the router and moves every caller;
//   2. contracts is built and samples.mjs writes each record's samples, and names any record JSON Schema can't carry;
//   3. if any, everything step 1 wrote is put back and step 1 runs again without those calls (they stay as they were);
//   4. with --refusals, refusals.mjs lists what the service's own tests see each new record's handler refuse;
//   5. procedures:write regenerates the registry and procedures/<service>.schema.json;
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

  let result = step1();
  build();
  sh('node', [here('samples.mjs'), '--unportable', unportable, ...recordFiles()]);
  const skipped = JSON.parse(readFileSync(unportable, 'utf8'));
  if (Object.keys(skipped).length) {
    putBack();
    const skipFile = join(tmpdir(), `call-records-skip-${process.pid}.json`);
    writeFileSync(skipFile, JSON.stringify(skipped));
    result = step1(['--skip-file', skipFile]);
    build();
    sh('node', [here('samples.mjs'), ...recordFiles()]);
  }
  sh(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...recordFiles()]);
  if (refusals) {
    build();
    sh('node', [here('refusals.mjs'), '--service', service, ...recordFiles()]);
    sh(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...recordFiles()]);
  }
  build();
  sh('pnpm', ['procedures:write'], { cwd: join(REPO, 'packages/contracts'), stdio: ['ignore', 'ignore', 'inherit'] });
  sh('node', [here('doubles.mjs'), '--write'], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (const f of [summary, unportable]) if (existsSync(f)) rmSync(f);
  console.log(JSON.stringify({ service, records: result.records.length, rewritten: result.rewritten, hand: result.hand }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) run(process.argv.slice(2));

#!/usr/bin/env node
/**
 * Outreach golden tests — the proofs for the vendored modules (apps/invitation/src/vendored) that the
 * public invitation app (apps/invitation) still bundles.
 *
 * The legacy Vue customer site in that directory is retired (see its
 * RETIRED.md), but `apps/invitation/vite.config.ts` still aliases six of its
 * files into the shipped questionnaire: outreach-intake, outreach-review,
 * outreach-public-info, outreach-draft-storage, outreach-countries and
 * config/intafaced.js. This gate keeps the golden tests that sit next to those
 * modules running; it replaces the broader `shell-golden` gate, which ran every
 * golden in the retired site.
 *
 * Only `outreach-*.golden.js` files are run.
 *
 * Exit 0 = every discovered outreach golden exited 0. Exit 1 = any failed, or
 * none were found (a golden suite that finds no goldens proves nothing).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const posix = (p) => p.replaceAll('\\', '/');
const ROOT = posix(fileURLToPath(new URL('../..', import.meta.url))).replace(/\/$/, '');
const SHELL = join(ROOT, 'apps/invitation/src/vendored');
const GOLDEN_DIR = join(SHELL, 'assets/js');

function listGoldens(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^outreach-.+\.golden\.js$/.test(name))
    .map((name) => join(dir, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

const goldens = listGoldens(GOLDEN_DIR);
if (goldens.length === 0) {
  console.error('✗ invitation-outreach-golden — no outreach-*.golden.js under', relative(ROOT, GOLDEN_DIR));
  console.error('  NOTHING WAS RUN. apps/invitation still bundles these modules; do not leave them unproven.');
  process.exit(1);
}

let failed = 0;
for (const file of goldens) {
  const rel = relative(ROOT, file);
  const r = spawnSync(process.execPath, [file], {
    cwd: SHELL,
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status === 0) {
    const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || 'ok';
    console.log(`✓ ${rel} — ${last}`);
  } else {
    failed += 1;
    console.error(`✗ ${rel} exit=${r.status}`);
    if (r.stdout) process.stderr.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
}

if (failed) {
  console.error(`✗ invitation-outreach-golden — ${failed}/${goldens.length} failed`);
  process.exit(1);
}
console.log(`✓ invitation-outreach-golden clean — ${goldens.length} golden(s)`);
process.exit(0);

#!/usr/bin/env node
/**
 * frontend:preflight — fail closed if Stream A law / residual / tools are missing.
 *
 * Usage:
 *   node tooling/frontend/preflight.mjs
 *   ORCA_REQUIRED=1 node tooling/frontend/preflight.mjs
 *   SLICE_TYPE=CRAFT node tooling/frontend/preflight.mjs
 *   SLICE_ID=b3-money node tooling/frontend/preflight.mjs
 *
 * Exit 0 = ready to ship at AOS level (or waiver files present).
 * Exit 1 = blocked — do not open product PR.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLICE_TYPE = (process.env.SLICE_TYPE || 'HONESTY').toUpperCase();
const SLICE_ID = process.env.SLICE_ID || '';
const ORCA_REQUIRED =
  process.env.ORCA_REQUIRED === '1' || process.env.ORCA_REQUIRED === 'true' || SLICE_TYPE === 'CRAFT' || SLICE_TYPE === 'HONESTY';

const errors = [];
const warns = [];

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function err(msg) {
  errors.push(msg);
  console.log(`  ✖ ${msg}`);
}
function warn(msg) {
  warns.push(msg);
  console.log(`  ! ${msg}`);
}

function mustFile(rel, why) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) err(`missing ${rel} (${why})`);
  else ok(`${rel}`);
}

function git(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

console.log(`frontend:preflight  type=${SLICE_TYPE}  slice=${SLICE_ID || '(none)'}`);
console.log('— law files —');

const LAW = [['tooling/frontend/residual-register.json', 'completeness register']];

for (const [f, why] of LAW) mustFile(f, why);

console.log('— residual register —');
const regPath = join(ROOT, 'tooling/frontend/residual-register.json');
if (existsSync(regPath)) {
  try {
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    const items = reg.items || [];
    const open = items.filter((i) => i.status === 'open' || i.status === 'partial');
    const blocked = items.filter((i) => i.status === 'blocked');
    const p1 = items
      .filter((i) => typeof i.priority === 'number' && i.priority > 0 && i.priority < 10)
      .sort((a, b) => a.priority - b.priority);
    ok(`${items.length} residual items (${open.length} open/partial, ${blocked.length} blocked)`);
    if (p1.length) {
      console.log('  next priority:');
      for (const i of p1.slice(0, 8)) {
        console.log(`    P${i.priority} ${i.id} [${i.status}] ${i.title}`);
      }
    }
  } catch (e) {
    err(`residual-register.json unreadable: ${e.message}`);
  }
}

console.log('— tip / worktree —');
const tip = git('git rev-parse origin/main 2>/dev/null') || git('git rev-parse main 2>/dev/null');
const head = git('git rev-parse HEAD');
const branch = git('git branch --show-current');
if (tip) ok(`origin/main ${tip.slice(0, 10)}`);
else warn('could not resolve origin/main');
ok(`HEAD ${head.slice(0, 10)} on ${branch || '(detached)'}`);
if (branch === 'main') err('on main branch — Stream A requires worktree feat/app-* or docs/*');

console.log('— tooling paths —');
mustFile('tooling/uiproof/boot.mjs', 'ui:boot');
mustFile('tooling/uiproof/matrix.mjs', 'ui:proof matrix');
mustFile('tooling/ci/brand-scan.mjs', 'brand-scan');
mustFile('package.json', 'scripts');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
for (const s of ['ui:boot', 'ui:proof', 'scan:brand']) {
  if (!scripts[s]) err(`package.json missing script ${s}`);
  else ok(`script ${s}`);
}

console.log('— collision hint (open PR titles) —');
try {
  const prs = execSync('gh pr list --state open --limit 30 --json number,title,headRefName 2>/dev/null', { cwd: ROOT, encoding: 'utf8' });
  const list = JSON.parse(prs || '[]');
  const risky = list.filter((p) => /order-route|feat\/ui|feat\/app|frontend|shell/i.test(p.title + p.headRefName));
  if (!risky.length) ok('no obvious open shell/order-route title collision');
  else {
    warn('open PRs to re-derive before editing shell:');
    for (const p of risky) console.log(`    #${p.number} ${p.headRefName} — ${p.title}`);
  }
} catch {
  warn('gh pr list failed — re-derive collisions manually');
}

console.log('— Orca —');
if (ORCA_REQUIRED) {
  try {
    const st = execSync('orca status --json 2>/dev/null', { encoding: 'utf8', timeout: 8000 });
    const j = JSON.parse(st);
    const ready = j?.result?.runtime?.state === 'ready' || j?.result?.app?.running;
    if (ready) ok('orca runtime ready');
    else err('Orca required but not ready — open Orca app (OPS-NOW)');
  } catch {
    err('Orca required but `orca status` failed — open Orca app');
  }
} else {
  warn('ORCA_REQUIRED off (set for CRAFT/HONESTY)');
}

console.log('— slice artifacts —');
if (SLICE_ID) {
  const dir = join(ROOT, 'docs/refs', SLICE_ID);
  if (!existsSync(dir)) {
    if (SLICE_TYPE === 'CRAFT' || SLICE_TYPE === 'HONESTY') {
      err(`docs/refs/${SLICE_ID}/ missing — copy docs/refs/_template and fill`);
    } else warn(`docs/refs/${SLICE_ID}/ not present`);
  } else {
    ok(`docs/refs/${SLICE_ID}/`);
    const need =
      SLICE_TYPE === 'CRAFT' ? ['steal-lines.md', 'critique.md', 'gap-audit.md'] : SLICE_TYPE === 'HONESTY' ? ['gap-audit.md'] : [];
    for (const f of need) {
      const p = join(dir, f);
      if (!existsSync(p) || !readFileSync(p, 'utf8').trim()) err(`${SLICE_ID}/${f} empty or missing`);
      else ok(`${SLICE_ID}/${f}`);
    }
  }
} else if (SLICE_TYPE === 'CRAFT' || SLICE_TYPE === 'HONESTY') {
  warn('set SLICE_ID=... to enforce docs/refs/<slice>/ artifacts');
}

console.log('');
if (errors.length) {
  console.log(`BLOCKED — ${errors.length} error(s), ${warns.length} warning(s)`);
  console.log('Do not open product PR until preflight is clean (or type=LAW).');
  process.exit(1);
}
console.log(`READY — ${warns.length} warning(s)`);
process.exit(0);

#!/usr/bin/env node
/**
 * KIT CEILINGS: each customer room file's count of the kit-look findings, frozen, and only ever lowered (intafaced issue 9326).
 *
 * The rules are garden/no-restyled-kit-part, garden/no-raw-control and garden/no-raw-type-class
 * (tooling/lint/oxlint-plugin-garden/kit-look-rules.js). Their counts per file of apps/customer/src live in
 * apps/customer/kit-ceilings.json. kit-ceilings.test.mjs fails when a file's count passes its ceiling (a file with no entry
 * has a ceiling of zero), when a ceiling is above the file's count (stale: lower it), and when the file raises a ceiling or
 * adds a file that main's copy does not hold. The lint ratchet separately fails a change whose touched files gain a finding.
 *
 * Usage:
 *   node tooling/lint/kit-ceilings.mjs            print each rule's total and what is over or stale; exit 1 if any
 *   node tooling/lint/kit-ceilings.mjs --write    lower the ceilings to today's counts; refuses to raise any
 * Never raise a ceiling or add a file to pass: replace the raw control or class with the kit's part.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, ruleOf } from '../ci/lint-ratchet.mjs';

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const CEILINGS = 'apps/customer/kit-ceilings.json';
const RULES = ['garden/no-restyled-kit-part', 'garden/no-raw-control', 'garden/no-raw-type-class'];
const SCOPE = 'apps/customer/src';

/** { <rule>: { <file>: count } } from oxlint's JSON diagnostics, files sorted. */
function countsOf(diagnostics, rules = RULES) {
  const out = Object.fromEntries(rules.map((r) => [r, {}]));
  for (const d of diagnostics) {
    const rule = ruleOf(d);
    if (!(rule in out)) continue;
    const file = String(d.filename).split('\\').join('/');
    out[rule][file] = (out[rule][file] ?? 0) + 1;
  }
  for (const r of rules) out[r] = Object.fromEntries(Object.entries(out[r]).sort(([a], [b]) => a.localeCompare(b)));
  return out;
}

/** Today's counts over the customer app, linted with the root config. */
export function countTree(cwd = ROOT, paths = [SCOPE]) {
  const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'oxlint'), ['-c', CONFIG, '--format', 'json', ...paths], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  let diagnostics;
  try {
    diagnostics = JSON.parse(run.stdout).diagnostics ?? [];
  } catch {
    throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout || '').slice(0, 800)}`);
  }
  return countsOf(diagnostics);
}

/**
 * What breaks the ceilings: [{ kind: 'over'|'stale'|'raised', rule, file, count, ceiling, was }].
 * `over`: a count above its ceiling (no entry is a ceiling of 0). `stale`: a ceiling above its count. `raised`: a ceiling
 * above main's (`base`), or a file main's copy does not hold. `base` null skips the raised check.
 */
export function judge(counts, ceilings, base = null) {
  const out = [];
  for (const rule of RULES) {
    const have = counts[rule] ?? {};
    const cap = ceilings[rule] ?? {};
    for (const file of new Set([...Object.keys(have), ...Object.keys(cap)])) {
      const count = have[file] ?? 0;
      const ceiling = cap[file] ?? 0;
      if (count > ceiling) out.push({ kind: 'over', rule, file, count, ceiling });
      else if (ceiling > count) out.push({ kind: 'stale', rule, file, count, ceiling });
    }
    if (!base) continue;
    const was = base[rule] ?? {};
    for (const [file, ceiling] of Object.entries(cap)) {
      if (ceiling > (was[file] ?? 0)) out.push({ kind: 'raised', rule, file, ceiling, was: was[file] ?? 0 });
    }
  }
  return out;
}

const FIX = {
  over: (p) => `${p.file}: ${p.rule} ${p.count}, ceiling ${p.ceiling}. Use the kit's part instead (the lint message names it).`,
  stale: (p) => `${p.file}: ${p.rule} ${p.count}, ceiling ${p.ceiling}. Lower it: node tooling/lint/kit-ceilings.mjs --write`,
  raised: (p) => `${p.file}: ${p.rule} ceiling ${p.ceiling}, main's ${p.was}. Never raise a ceiling or add a file: use the kit's part.`,
};
export const describe = (p) => `${p.kind}: ${FIX[p.kind](p)}`;

/** The ceilings written from today's counts, refusing any that would rise above `ceilings`. */
export function lowered(counts, ceilings) {
  const up = judge(counts, ceilings).filter((p) => p.kind === 'over');
  if (up.length) throw new Error(`refused: these would raise a ceiling\n${up.map(describe).join('\n')}`);
  return Object.fromEntries(RULES.map((r) => [r, counts[r] ?? {}]));
}

export const readCeilings = (root = ROOT) => JSON.parse(readFileSync(join(root, CEILINGS), 'utf8'));
const formatCeilings = (c) => `${JSON.stringify(c, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const counts = countTree();
  const ceilings = readCeilings();
  if (process.argv.includes('--write')) {
    writeFileSync(join(ROOT, CEILINGS), formatCeilings(lowered(counts, ceilings)));
    console.log(`wrote ${CEILINGS}`);
  } else {
    for (const r of RULES)
      console.log(`${r}: ${Object.values(counts[r]).reduce((a, b) => a + b, 0)} in ${Object.keys(counts[r]).length} files`);
    const problems = judge(counts, ceilings);
    for (const p of problems) console.log(describe(p));
    process.exitCode = problems.length ? 1 : 0;
  }
}

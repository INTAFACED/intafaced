#!/usr/bin/env node
/**
 * How many findings of one lint rule are left, and where: the copies a ratcheted rule still holds on this checkout.
 *
 * Usage: node tooling/lint/count-rule.mjs <rule> [path…] [--json]
 *   <rule>  as the ratchet names it, `garden/no-call-by-name`
 *   path    what to lint (default: the whole checkout, as the root config ignores)
 * Prints the total on the first line, then one `<count> <file>` line per file over zero, most first. With --json, one
 * object: { rule, total, files: { <file>: <count> } }. Exits 1 when oxlint gives no answer, never on a count.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, ruleOf } from '../ci/lint-ratchet.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** oxlint's JSON diagnostics to { total, files } for one rule. */
export function countOf(diagnostics, rule) {
  const files = {};
  for (const d of diagnostics) {
    if (ruleOf(d) !== rule) continue;
    const file = String(d.filename).split('\\').join('/');
    files[file] = (files[file] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
  return { total: Object.values(files).reduce((a, b) => a + b, 0), files: sorted };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const [rule, ...paths] = args.filter((a) => a !== '--json');
  if (!rule) {
    console.error('usage: node tooling/lint/count-rule.mjs <rule> [path…] [--json]');
    process.exit(2);
  }
  const run = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'oxlint'),
    ['-c', CONFIG, '--format', 'json', ...(paths.length ? paths : ['.'])],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    console.error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout || '').slice(0, 800)}`);
    process.exit(1);
  }
  const { total, files } = countOf(parsed.diagnostics ?? [], rule);
  if (json) console.log(JSON.stringify({ rule, total, files }));
  else console.log([String(total), ...Object.entries(files).map(([f, n]) => `${n} ${f}`)].join('\n'));
}

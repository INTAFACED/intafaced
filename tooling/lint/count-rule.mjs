#!/usr/bin/env node
/**
 * How many findings of one lint rule are left, and where: the copies a ratcheted rule still holds on this checkout.
 *
 * Usage: node tooling/lint/count-rule.mjs <rule> [path…] [--json]
 *   <rule>  as the ratchet names it, `garden/no-call-by-name`
 *   path    what to lint (default: the whole checkout, as the root config ignores)
 * Prints the total on the first line, then one `<count> <file>` line per file over zero, most first. With --json, one
 * object: { rule, total, files: { <file>: <count> } }. Exits 1 when oxlint gives no answer, never on a count.
 * A test imports countRule (a rule's findings over real paths) or countPlanted (over files written to a scratch folder,
 * linted with the root config): count-rule.d.mts types them for TypeScript tests.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** oxlint's JSON diagnostics for these paths, linted from `cwd` with `config`; throws when oxlint gives no JSON. */
function diagnosticsOf(paths, cwd = ROOT, config = CONFIG) {
  const run = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'oxlint'),
    ['-c', config, '--format', 'json', ...(paths.length ? paths : ['.'])],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  try {
    return JSON.parse(run.stdout).diagnostics ?? [];
  } catch {
    throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout || '').slice(0, 800)}`);
  }
}

/** One rule's findings over real paths of this checkout (relative to its root), with the root config. */
export const countRule = (rule, paths) => countOf(diagnosticsOf(paths), rule);

/** One rule's findings over planted files ({ <path>: <text> }), written to a scratch folder and linted there with the root
 * config, so its overrides apply to the planted paths as they would to the real ones. */
export function countPlanted(rule, files) {
  const config = JSON.parse(readFileSync(join(ROOT, CONFIG), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'count-rule-'));
  try {
    writeFileSync(join(dir, CONFIG), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return countOf(diagnosticsOf(Object.keys(files), dir), rule);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const [rule, ...paths] = args.filter((a) => a !== '--json');
  if (!rule) {
    console.error('usage: node tooling/lint/count-rule.mjs <rule> [path…] [--json]');
    process.exit(2);
  }
  let counted;
  try {
    counted = countRule(rule, paths);
  } catch (e) {
    console.error(String(e.message));
    process.exit(1);
  }
  const { total, files } = counted;
  if (json) console.log(JSON.stringify({ rule, total, files }));
  else console.log([String(total), ...Object.entries(files).map(([f, n]) => `${n} ${f}`)].join('\n'));
}

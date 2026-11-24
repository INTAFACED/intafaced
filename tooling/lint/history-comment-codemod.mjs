#!/usr/bin/env node
/**
 * Codemod for garden/no-history-comment: applies the rule's own fix (a citation dropped from a list or parentheses) and
 * lists what is left to reword by hand.
 *
 *   node tooling/lint/history-comment-codemod.mjs <path>...            dry run: the findings, and how many it would fix
 *   node tooling/lint/history-comment-codemod.mjs <path>... --write    applies the fixes
 *
 * Only the one rule runs, so --fix touches nothing else; the fix edits comment text only, never code.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RULE = 'garden/no-history-comment';

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const paths = argv.filter((a) => !a.startsWith('--')).map((p) => resolve(p));
  if (!paths.length) {
    console.error('usage: history-comment-codemod.mjs <path>... [--write]');
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'history-comment-'));
  try {
    const config = join(dir, 'oxlintrc.json');
    writeFileSync(
      config,
      JSON.stringify({
        plugins: [],
        categories: { correctness: 'off' },
        jsPlugins: [join(ROOT, 'tooling/lint/oxlint-plugin-garden/index.js')],
        ignorePatterns: ['**/vendor/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/out/**'],
        rules: { [RULE]: 'error' },
      }),
    );
    const lint = (extra = []) => {
      const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'oxlint'), ['-c', config, '--format', 'json', ...extra, ...paths], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      try {
        return JSON.parse(run.stdout).diagnostics;
      } catch {
        throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 800)}`);
      }
    };
    const before = lint();
    if (write) lint(['--fix']);
    const after = write ? lint() : before;
    const where = paths.map((p) => relative(ROOT, p) || '.').join(' ');
    if (write) console.log(`${RULE} in ${where}: ${before.length} → ${after.length}`);
    else console.log(`${RULE} in ${where}: ${before.length} finding(s); --write fixes those whose citation sits in a list`);
    for (const d of after) console.log(`  ${d.filename}:${d.labels?.[0]?.span?.line ?? '?'} ${d.message.split(':')[0]}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

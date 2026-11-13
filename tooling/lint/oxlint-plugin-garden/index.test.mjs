// The garden rules on planted files: each fires on its weed, names its fix, and stays quiet on the clean form.
// Runs with every other tooling test (tooling/scripts/tooling-tests.mjs). The root config is read as it is, so a rule
// switched off or a broken plugin shows here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const CONFIG = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));

/** Lint planted files with the root config (its plugin path made absolute); returns oxlint's unix-format lines. */
function lint(files) {
  const dir = mkdtempSync(join(tmpdir(), 'garden-'));
  try {
    const config = { ...CONFIG, jsPlugins: CONFIG.jsPlugins.map((p) => join(ROOT, p)) };
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(config));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', join(dir, '.oxlintrc.json'), '--format', 'unix', ...Object.keys(files)], {
        cwd: dir,
        encoding: 'utf8',
      });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => /:\d+:\d+:/.test(l));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const has = (out, file, rule) => out.some((l) => l.startsWith(`${file}:`) && l.includes(rule));

test('oxlint is installed', { skip: !existsSync(OXLINT) && 'no node_modules' }, () => assert.ok(existsSync(OXLINT)));

test('the six garden rules fire on their weeds and name the fix', { skip: !existsSync(OXLINT) && 'no node_modules' }, () => {
  const out = lint({
    'cast.ts': 'export const n = ("1" as unknown as number) + 1;\n',
    'reasonless.ts': '// eslint-disable-next-line no-console\nconsole.log(1);\n',
    'src/wait.test.ts': 'export async function t() {\n  await new Promise((r) => setTimeout(r, 50));\n}\n',
    'page.pw.mjs': 'export async function t(page) {\n  await page.waitForTimeout(500);\n}\n',
    'any.ts': 'export const f = (x: any) => x;\n',
  });
  assert.ok(has(out, 'cast.ts', 'garden(no-double-cast)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.includes('no-double-cast') && l.includes('type guard')),
    'the cast message names the fix',
  );
  assert.ok(has(out, 'reasonless.ts', 'garden(require-suppression-reason)'), out.join('\n'));
  assert.ok(has(out, 'src/wait.test.ts', 'garden(no-real-clock-wait-in-tests)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.includes('no-real-clock-wait-in-tests') && l.includes('useFakeTimers')),
    'the wait message names the fix',
  );
  assert.ok(has(out, 'page.pw.mjs', 'garden(no-wait-for-timeout)'), out.join('\n'));
  assert.ok(has(out, 'any.ts', 'no-explicit-any'), out.join('\n'));
});

test(
  'the clean forms pass, and no-local-helper stays off until its shared import exists',
  { skip: !existsSync(OXLINT) && 'no node_modules' },
  () => {
    const out = lint({
      'reasoned.ts': '// eslint-disable-next-line no-console -- the CLI prints its table\nconsole.log(1);\n',
      'one-cast.ts': 'export const n = Number("1" as string) + 1;\n',
      'src/fake.test.ts': 'export function t(vi) {\n  vi.useFakeTimers();\n}\n',
      'helper.ts':
        'export function isRecord(v: unknown): v is Record<string, unknown> {\n  return typeof v === "object" && v !== null;\n}\n',
      'prod-wait.ts': 'export const later = () => new Promise((r) => setTimeout(r, 50));\n',
    });
    const garden = out.filter((l) => l.includes('garden('));
    assert.deepEqual(garden, [], garden.join('\n'));
  },
);

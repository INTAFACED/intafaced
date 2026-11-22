// garden/no-source-text-test on planted files: each way a test reads a services/apps/packages or tooling source file as text
// fires and names the fix; reading migrations, compose files or JSON, a tooling folder or fixture, and source code that
// reads files do not.
// The count command reads the same findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countOf } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden/no-source-text-test';

/** oxlint's JSON diagnostics over planted files, linted with the root config. */
function lint(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-source-text-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'json', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return JSON.parse(out).diagnostics ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEAD = [
  "import { readFileSync } from 'node:fs';",
  "import { readFile } from 'node:fs/promises';",
  "import { dirname, join, resolve } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const HERE = dirname(fileURLToPath(import.meta.url));',
  "const ROOT = join(HERE, '..', '..', '..');",
].join('\n');
const SERVICE_TEST = 'services/svc-bank/src/cards/new-pin.test.ts';
const TOOLING_TEST = 'tooling/scripts/new-scan.test.mjs';

test('every way a test reads source text fires and names the fix', skip, () => {
  const diagnostics = lint({
    [SERVICE_TEST]: [
      HEAD,
      "const a = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');",
      "const b = readFileSync(join(HERE, '..', 'router.ts'), 'utf8');",
      "const c = readFileSync(new URL('./cards.ts', import.meta.url), 'utf8');",
      "const routerPath = resolve(HERE, '..', 'index.ts');",
      "const d = readFileSync(routerPath, 'utf8');",
      "const e = await readFile(join(ROOT, 'apps', 'customer', 'src', 'App.tsx'), 'utf8');",
      "const f = readFileSync(join(HERE, 'freeze.ts'), 'utf8');",
    ].join('\n'),
    [TOOLING_TEST]: [
      HEAD,
      "const g = fs.readFileSync(`${ROOT}/packages/contracts/src/procedure.ts`, 'utf8');",
      "const h = readFileSync(join(ROOT, 'apps/admin/src/lib', name), 'utf8');",
      // weed project-state#3684: local-test-stack.test.mjs read its script this way and a regex over it cost #9456 a push.
      "const i = readFileSync(join(HERE, 'local-test-stack.mjs'), 'utf8');",
      "const j = readFileSync(new URL('./journey-seal.mjs', import.meta.url), 'utf8');",
      "const k = readFileSync(join(ROOT, 'tooling/ci/boundary-scan.mjs'), 'utf8');",
    ].join('\n'),
  });
  const { total, files } = countOf(diagnostics, RULE);
  assert.deepEqual(files, { [SERVICE_TEST]: 6, [TOOLING_TEST]: 5 });
  assert.equal(total, 11);
  for (const d of diagnostics.filter((x) => x.code === 'garden(no-source-text-test)'))
    assert.match(d.message, /call the code and assert on its answer/u);
});

test('data files, a tooling folder or fixture, a path under an unknown root and non-test code stay quiet', skip, () => {
  const read = "const a = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');";
  const diagnostics = lint({
    [SERVICE_TEST]: [
      HEAD,
      "const drizzle = join(HERE, '..', '..', 'drizzle');",
      "const m = readFileSync(join(drizzle, '0001_init.sql'), 'utf8');",
      "const c = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');",
      "const p = readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8');",
      "const s = readFileSync(join(ROOT, 'services/svc-bank/src/fixtures/card.json'), 'utf8');",
      'const v = readFileSync(somePath, "utf8");',
    ].join('\n'),
    [TOOLING_TEST]: [
      HEAD,
      "const w = readFileSync(join(ROOT, '.github/workflows'), 'utf8');",
      "const x = readFileSync(join(HERE, 'fixtures', 'stack-old.mjs'), 'utf8');",
      "const y = readFileSync(join(pkg, 'src', 'global.ts'), 'utf8');",
      "const z = readFileSync(join(HERE, 'ci.yml'), 'utf8');",
    ].join('\n'),
    'services/svc-bank/src/boot/load-keys.ts': [HEAD, read].join('\n'),
  });
  assert.deepEqual(countOf(diagnostics, RULE), { total: 0, files: {} });
});

test("a path under a folder the test made is a generator's output; each name is the declaration in scope where it is used", skip, () => {
  const diagnostics = lint({
    [TOOLING_TEST]: [
      HEAD,
      "import { mkdtempSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "const repo = resolve(HERE, '..', '..');",
      "test('reads the real tree', () => { readFileSync(join(repo, 'services', 'svc-edge', 'src', 'routes.ts'), 'utf8'); });",
      "test('writes into its own folder', () => {",
      "  const repo = mkdtempSync(join(tmpdir(), 'slice-new-'));",
      "  readFileSync(join(repo, 'services', 'svc-academy', 'src', 'grade-reports.ts'), 'utf8');",
      '});',
      "test('and again', () => { const repo = mkdtempSync(join(tmpdir(), 'x-')); readFileSync(join(repo, 'apps/admin/src/a.ts'), 'utf8'); });",
      "test('the outer name after them', () => { readFileSync(join(repo, 'packages/db/src/connection.ts'), 'utf8'); });",
    ].join('\n'),
  });
  const found = diagnostics.filter((d) => d.code === 'garden(no-source-text-test)').map((d) => /\(`([^`]*)`\)/.exec(d.message)?.[1]);
  assert.deepEqual(
    found,
    ['../../services/svc-edge/src/routes.ts', '../../packages/db/src/connection.ts'],
    "the real tree's reads, named by the outer repo; the temp folders' never",
  );
});

test("a generated file held equal to its generator is the generator's output, not source", skip, () => {
  const diagnostics = lint({
    'packages/ui/src/components/coins/art.test.ts': [
      HEAD,
      "const a = readFileSync(join(HERE, 'coin-art.generated.ts'), 'utf8');",
      "const b = readFileSync(join(HERE, 'coin-art.ts'), 'utf8');",
    ].join('\n'),
  });
  const found = diagnostics.filter((d) => d.code === 'garden(no-source-text-test)').map((d) => /\(`([^`]*)`\)/.exec(d.message)?.[1]);
  assert.deepEqual(found, ['coin-art.ts'], 'the hand-written file still counts; the generated one does not');
});

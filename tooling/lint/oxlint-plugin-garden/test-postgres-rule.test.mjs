// garden/test-postgres-helper on planted files: it fires on the past mistake as it was written on main before
// intafaced#9610 (services/svc-bank/src/saga.money.test.ts's own `new PostgreSqlContainer('postgres:16-alpine')`), on the
// lazy import svc-pay's control testkit used, on an alias and on a GenericContainer of a postgres image; it stays quiet on
// the fixed code, on the helper itself and on a GenericContainer of another image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(test-postgres-helper)';

function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-test-postgres-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PAST = `import { PostgreSqlContainer } from '@testcontainers/postgresql';
async function openAdmin() {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_saga_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return container.getConnectionUri();
}
`;

test('test-postgres-helper: the past mistake fails on its import and its constructor, naming the fix', skip, () => {
  const f = 'services/svc-bank/src/saga.money.test.ts';
  const out = findings({ [f]: PAST });
  assert.deepEqual(
    out.map((l) => l.split(':')[1]),
    ['1', '3'],
    out.join('\n'),
  );
  for (const l of out) assert.ok(l.includes("testPostgres() from '@intafaced/db/test-postgres'"), l);
});

test('test-postgres-helper: a lazy import, an alias and a postgres GenericContainer fail too', skip, () => {
  const out = findings({
    'services/svc-pay/src/control/control.testkit.ts': `export async function open() {\n  const { PostgreSqlContainer: Pg } = await import('@testcontainers/postgresql');\n  return new Pg('postgres:16-alpine').start();\n}\n`,
    'services/svc-x/src/generic.test.ts': `import { GenericContainer } from 'testcontainers';\nexport const c = new GenericContainer('postgres:16-alpine');\n`,
  });
  assert.equal(out.filter((l) => l.startsWith('services/svc-pay/src/control/control.testkit.ts:2:')).length, 1, out.join('\n'));
  assert.equal(out.filter((l) => l.startsWith('services/svc-x/src/generic.test.ts:2:')).length, 1, out.join('\n'));
});

test('test-postgres-helper: quiet on the fixed code, the helper and another image', skip, () => {
  const out = findings({
    'services/svc-bank/src/saga.money.test.ts': `import { testPostgres } from '@intafaced/db/test-postgres';\nexport const c = testPostgres('postgres:16-alpine').withDatabase('x');\n`,
    'packages/db/src/test-postgres.ts': `import { PostgreSqlContainer } from '@testcontainers/postgresql';\nexport const testPostgres = (i = 'postgres:16-alpine') => new PostgreSqlContainer(i);\n`,
    'services/svc-x/src/redis.test.ts': `import { GenericContainer } from 'testcontainers';\nexport const c = new GenericContainer('redis:7');\n`,
  });
  assert.deepEqual(out, []);
});

// garden/no-made-up-principal on planted files: a principal with its tier written in fires and names the supported way; a
// principal passed through, one rebuilt from a stored grant, a test, a mock and the identity service do not.
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
const RULE = 'garden(no-made-up-principal)';

/** Each planted file's findings of this rule, as unix-format lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-principal-'));
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
const SVC = 'services/svc-trade/src/venue/protections.ts';

test('a principal with its tier written in fires and names the supported way', skip, () => {
  const out = findings({
    [SVC]: [
      'export const engineActor = (userId) => ({',
      '  sub: userId,',
      '  userId,',
      "  scopes: ['trade:read', 'trade:write'],",
      "  tier: 'basic',",
      '  mfa: false,',
      '});',
    ].join('\n'),
  });
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0].startsWith(`${SVC}:5:`), out[0]);
  assert.ok(out[0].includes("`tier: 'basic'`") && out[0].includes('principalFromAlgoGrant'), out[0]);
});

test('a carried principal, a rebuilt grant, tests, mocks and the issuers pass', skip, () => {
  const made = "export const p = { userId: 'u', scopes: ['trade:write'], tier: 'basic' };\n";
  const out = findings({
    [SVC]: [
      'export const asOwner = (principal) => ({ ...principal, scopes: principal.scopes });',
      'export const rebuilt = (grant, userId) => ({ sub: userId, userId, scopes: [...grant.scopes], tier: grant.tier });',
      "export const view = { tier: 'basic', fee: '0.1' };",
    ].join('\n'),
    'services/svc-trade/src/venue/protections.test.ts': made,
    'services/svc-trade/src/spot/testing.ts': made,
    'apps/customer/src/features/pay/portal/portal.mock.mjs': made,
    'services/svc-identity/src/auth/session.ts': made,
    'packages/auth/src/tokens.ts': made,
  });
  assert.deepEqual(out, []);
});

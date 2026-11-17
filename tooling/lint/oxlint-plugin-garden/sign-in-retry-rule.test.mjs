// garden/no-sign-in-retry on planted files: the two retries main had (the founder console's signInOnceMore and
// J-bank-02's stepAfterRefusal) fire and name the one-sign-in fix; one sign-in that fails on a refusal, and the gates'
// own operator sign-in outside the journeys, do not.
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
const RULE = 'garden(no-sign-in-retry)';

/** Each planted file's findings of this rule, as oxlint's unix lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-sign-in-'));
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
const ADMIN = 'apps/customer/tests/real-app/admin.mjs';
const BANK = 'apps/customer/tests/real-app/J-bank-02.pw.mjs';

test("main's two sign-in retries fire and name the one-sign-in fix", skip, () => {
  const out = findings({
    // apps/customer/tests/real-app/admin.mjs before the retries went
    [ADMIN]: [
      "import { founderStepRefused, founderTotp, signInOnceMore } from '../../../../tooling/scripts/local-test-gates.mjs';",
      'export async function founderSignIn(page, key) {',
      '  await signInOnceMore({',
      '    attempt: () => consoleSignIn(page, founder, () => founderTotp(ctx, key, founder.totpSecret)),',
      '    onRefused: () => founderStepRefused(ctx, key),',
      '  });',
      '}',
    ].join('\n'),
    // J-bank-02's own retry before the retries went
    [BANK]: [
      'async function signInWithCode(page, who) {',
      '  const refused = await attempt();',
      '  const { secret, step } = run.read();',
      '  if (refused && secret) {',
      '    const current = Math.floor(Date.now() / 30_000);',
      "    const { stepAfterRefusal } = await import('../../../../tooling/scripts/local-test-gates.mjs');",
      '    run.reset({ ...run.read(), step: stepAfterRefusal(step, current) });',
      '    await attempt();',
      '  }',
      '}',
    ].join('\n'),
  });
  assert.equal(out.length, 2, out.join('\n'));
  const admin = out.find((l) => l.startsWith(`${ADMIN}:3:`));
  const bank = out.find((l) => l.startsWith(`${BANK}:7:`));
  assert.ok(admin?.includes('signInOnceMore in a journey'), out.join('\n'));
  assert.ok(bank?.includes('stepAfterRefusal in a journey'), out.join('\n'));
  assert.ok(bank.includes('founderSignIn in apps/customer/tests/real-app/admin.mjs'), bank);
});

test('one sign-in that fails on a refusal, and the gates’ own operator sign-in, pass', skip, () => {
  const out = findings({
    [ADMIN]: [
      'export async function founderSignIn(page, key) {',
      "  if ((await consoleSignIn(page, founder, () => founderTotp(ctx, key, founder.totpSecret))) === 'refused') {",
      '    const { refused } = founderStepRefused(ctx, key);',
      '    throw new Error(`refused at step ${refused}`);',
      '  }',
      '}',
    ].join('\n'),
    'tooling/scripts/local-test-gates.mjs': 'export function operatorLogin(op) { op.lastStep = stepAfterRefusal(op.lastStep, 1); }',
  });
  assert.deepEqual(out, []);
});

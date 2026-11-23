// garden/no-sign-in-in-step on planted files: the founder sign-ins main's journeys made inside their steps (J-agents-16
// before #8522, J-algo-dev-03 before #8433, a direct founderSignIn in a step) fire and name the founders fixture; a
// sign-in kept once per file (the fixed J-agents-16, the fixed J-algo-dev-03, the fixture itself, a beforeAll) passes.
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
const RULE = 'garden(no-sign-in-in-step)';

/** Each planted file's findings of this rule, as oxlint's unix lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-sign-in-step-'));
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
const at = (name) => `apps/customer/tests/real-app/${name}.pw.mjs`;
const lines = (...l) => l.join('\n');

// J-agents-16 as main had it before #8522: every step opened the desk through a fresh founder sign-in.
const AGENTS_16_BEFORE = lines(
  "import { test, expect } from './journey.mjs';",
  "import { openFounderDesk } from './agents.mjs';",
  "const openAlerts = (page) => openFounderDesk(page, '/more-ops/agents/alerts', 'Agent alerts');",
  "test('J-agents-16 #3 takes notifications down', async ({ page }) => {",
  '  await openAlerts(page);',
  '});',
  "test('J-agents-16 #4 opens the managed policy baseline', async ({ page }) => {",
  '  await openAlerts(page);',
  '});',
);
// ...and as #8522 left it: one sign-in, kept for the file.
const AGENTS_16_AFTER = lines(
  "import { test, expect } from './journey.mjs';",
  "import { openFounderDesk } from './agents.mjs';",
  'let consoleSession = null;',
  'async function openAlerts(browser) {',
  '  if (!consoleSession) {',
  '    const page = await (await browser.newContext()).newPage();',
  "    await openFounderDesk(page, '/more-ops/agents/alerts', 'Agent alerts');",
  '    consoleSession = { page };',
  '    return page;',
  '  }',
  '  return consoleSession.page;',
  '}',
  "test('J-agents-16 #4 opens the managed policy baseline', async ({ browser }) => {",
  '  await openAlerts(browser);',
  '});',
);

test('J-agents-16 before #8522 fires and names the founders fixture and its file; after #8522 it passes', skip, () => {
  const before = findings({ [at('J-agents-16')]: AGENTS_16_BEFORE });
  assert.equal(before.length, 1, before.join('\n'));
  assert.ok(before[0].startsWith(`${at('J-agents-16')}:3:`), before[0]);
  assert.ok(before[0].includes('openFounderDesk inside a journey step'), before[0]);
  assert.ok(before[0].includes('`founders` fixture in apps/customer/tests/real-app/journey.mjs'), before[0]);
  assert.ok(before[0].includes('founders.console(key)'), before[0]);
  assert.deepEqual(findings({ [at('J-agents-16')]: AGENTS_16_AFTER }), []);
});

test('approver sessions on a fresh gates context per door call fire; on a kept one they pass (J-algo-dev-03, #8433)', skip, () => {
  const door = (open) =>
    lines(
      "import { test } from './journey.mjs';",
      ...open,
      'async function publishTemplate(input) {',
      '  const { ctx, founders } = await founderOps();',
      "  return ctx.edge.mutate('quant', 'ops.template.publish', input, await founders.a.tradeOpsToken());",
      '}',
      "test('J-algo-dev-03 #4 opens a built-in template', async () => {",
      '  await publishTemplate({});',
      '  await publishTemplate({});',
      '});',
    );
  const before = findings({
    [at('J-algo-dev-03')]: door([
      'async function founderOps() {',
      "  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');",
      '  const ctx = await gates.makeContext({ log: () => {} });',
      '  return { ctx, founders: await gates.approverSessions(ctx) };',
      '}',
    ]),
  });
  assert.equal(before.length, 1, before.join('\n'));
  assert.ok(before[0].includes('approverSessions inside a journey step') && before[0].includes('founders.ops()'), before[0]);
  const after = findings({
    [at('J-algo-dev-03')]: door([
      'let founderCtx;',
      'async function founderOps() {',
      "  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');",
      '  founderCtx ??= await gates.makeContext({ log: () => {}, shareSessions: true });',
      '  return { ctx: founderCtx, founders: await gates.approverSessions(founderCtx) };',
      '}',
    ]),
  });
  assert.deepEqual(after, []);
});

test('a founder sign-in straight in a step fires; the fixture, a beforeAll and a helper module pass', skip, () => {
  const out = findings({
    [at('J-cex-spot-18')]: lines(
      "import { test } from './journey.mjs';",
      "import { founderSignIn } from './admin.mjs';",
      "test('J-cex-spot-18 #5 reads the trade audit', async ({ page }) => {",
      "  await founderSignIn(page, 'b');",
      '});',
    ),
    [at('J-agents-17')]: lines(
      "import { test } from './journey.mjs';",
      "import { founderSignIn } from './admin.mjs';",
      'let desk;',
      'test.beforeAll(async ({ browser }) => {',
      '  desk = await (await browser.newContext()).newPage();',
      "  await founderSignIn(desk, 'a');",
      '});',
      "test('J-agents-17 #1 opens the desk', async ({ founders }) => {",
      "  const { page } = await founders.console('b');",
      '  await page.goto(desk.url());',
      '});',
    ),
    'apps/customer/tests/real-app/agents.mjs': lines(
      'export async function openFounderDesk(page, route, heading, key) {',
      "  const { founderSignIn } = await import('./admin.mjs');",
      '  return founderSignIn(page, key);',
      '}',
    ),
  });
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0].startsWith(`${at('J-cex-spot-18')}:4:`) && out[0].includes('founderSignIn inside a journey step'), out[0]);
});

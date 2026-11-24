// garden/restart-through-helper on planted files: J-support-public-12's svc-support restart and J-support-public-08 #4's
// svc-ops stop and start as main had them before their fixes (#8422, #8074: a blocking `tool(…)`) fire and name
// `restartService`; the same code on restartService, stopService and startService passes, and so do the stack's other
// tools and stack.mjs, the helpers' home. A direct awaited call and the blocking restartWith fire too: one way is left.
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
const RULE = 'garden(restart-through-helper)';

/** Each planted file's findings of this rule, as oxlint's unix lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-restart-'));
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
const at = (name) => `apps/customer/tests/real-app/${name}`;
const lines = (...l) => l.join('\n');

// J-support-public-12 before #8422: svc-support restarted with a blocking tool call.
const SUPPORT_12_BEFORE = lines(
  "import { api, tool } from './stack.mjs';",
  'function restartSupport(switches) {',
  '  const before = Object.fromEntries(Object.keys(switches).map((k) => [k, process.env[k]]));',
  '  try {',
  "    tool('local-test-stack.mjs', 'restart', 'support');",
  '  } finally {',
  '    for (const [k, v] of Object.entries(before)) process.env[k] = v;',
  '  }',
  '}',
  'export { api, restartSupport };',
);
const SUPPORT_12_AFTER = lines(
  "import { api, restartService } from './stack.mjs';",
  "const restartSupport = (switches) => restartService('support', switches);",
  'export { api, restartSupport };',
);
// J-support-public-08 #4 before #8074: svc-ops stopped and started again, each a blocking tool call.
const SUPPORT_08_BEFORE = lines(
  "import { test } from './journey.mjs';",
  "import { tool } from './stack.mjs';",
  'test(`J-support-public-08 #4 a failed store refuses`, async () => {',
  '  try {',
  "    tool('local-test-stack.mjs', 'stop', 'ops');",
  '  } finally {',
  "    tool('local-test-stack.mjs', 'start', '--only', 'ops');",
  '  }',
  '});',
);
const SUPPORT_08_AFTER = lines(
  "import { test } from './journey.mjs';",
  "import { startService, stopService, tool } from './stack.mjs';",
  'test(`J-support-public-08 #4 a failed store refuses`, async () => {',
  "  tool('local-test-market.mjs', 'status');",
  "  tool('local-test-stack.mjs', 'status');",
  '  try {',
  "    await stopService('ops');",
  '  } finally {',
  "    await startService('ops');",
  '  }',
  '});',
);

test('the pre-fix code of #8422 and #8074 fires, naming restartService and its file', { skip }, () => {
  const out = findings({ [at('J-support-public-12.pw.mjs')]: SUPPORT_12_BEFORE, [at('J-support-public-08.pw.mjs')]: SUPPORT_08_BEFORE });
  assert.equal(out.filter((l) => l.includes('J-support-public-12')).length, 1, out.join('\n'));
  assert.equal(out.filter((l) => l.includes('J-support-public-08')).length, 2, out.join('\n'));
  for (const l of out) assert.match(l, /restartService\(service, settings\).*apps\/customer\/tests\/real-app\/stack\.mjs/);
});

test('the same code on restartService, stopService and startService passes', { skip }, () => {
  const out = findings({ [at('J-support-public-12.pw.mjs')]: SUPPORT_12_AFTER, [at('J-support-public-08.pw.mjs')]: SUPPORT_08_AFTER });
  assert.deepEqual(out, []);
});

test('a direct awaited call, a blocking restartWith and a helper module fire; stack.mjs and other folders do not', { skip }, () => {
  const awaited = lines(
    "import { toolAwaited } from './stack.mjs';",
    "export const notify = () => toolAwaited('local-test-stack.mjs', 'restart', 'notify');",
  );
  const blocking = lines(
    "import { restartWith } from './stack.mjs';",
    "export const off = () => restartWith('identity', 'LOCAL_STACK_X', false);",
  );
  const out = findings({
    [at('J-x-01.pw.mjs')]: awaited,
    [at('venue-reads.mjs')]: blocking,
    [at('stack.mjs')]: awaited.replace("import { toolAwaited } from './stack.mjs';", 'const toolAwaited = () => {};'),
    'tooling/scripts/elsewhere.mjs': awaited.replace("import { toolAwaited } from './stack.mjs';", 'const toolAwaited = () => {};'),
  });
  assert.equal(out.length, 2, out.join('\n'));
  assert.ok(out.some((l) => l.includes('J-x-01') && l.includes("toolAwaited('local-test-stack.mjs', 'restart'")));
  assert.ok(out.some((l) => l.includes('venue-reads.mjs') && l.includes('`restartWith(…)`')));
});

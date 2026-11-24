// garden/no-switch-router on planted files: a router part chosen between two sets of procedures fires (svc-pay's
// `founderAdmin.changes` and `.approvals` as they stood, the codemod test's `flag ? liveRouter() : standIn()`, `??`, `||`
// and one path given `? :` of two procedures), and the message names the fix; one procedure per path switching inside its
// handler, a spread that adds or leaves out a path, `&&`, an empty side and a test file stay quiet.
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
const RULE = 'garden/no-switch-router';

/** oxlint's JSON diagnostics over planted files, linted with the root config. */
function lint(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-switch-router-'));
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

const PAST = 'services/svc-pay/src/namespaces/founder-admin.ts';
const OTHER = 'services/svc-x/src/router.ts';
const FIXED = 'services/svc-pay/src/namespaces/founder-control.ts';

test('a router part chosen between two sets of procedures fires, and names the fix', skip, () => {
  const diagnostics = lint({
    // The past mistake, as services/svc-pay/src/namespaces/founder-admin.ts wrote it before this rule.
    [PAST]: [
      'export function createFounderAdminRouter(founder: F, control?: C) {',
      '  return router({',
      '    changes: router(',
      '      control',
      '        ? founderChangeProcedures(founder, control)',
      '        : {',
      "            submit: founder.input(a).output(b).mutation(() => notBuilt('founderAdmin.changes.submit')),",
      '          },',
      '    ),',
      '    approvals: router(',
      '      control',
      '        ? founderApprovalProcedures(founder, control)',
      "        : { list: founder.input(a).output(b).query(() => notBuilt('founderAdmin.approvals.list')) },",
      '    ),',
      '  });',
      '}',
    ].join('\n'),
    [OTHER]: [
      'export function createSvcRouter(flag: boolean, a?: R, b?: R) {',
      '  return t.router({',
      '    flagged: flag ? liveRouter() : standIn(),',
      '    either: a ?? b,',
      '    or: (a || standIn()) as R,',
      '    one: flag ? p.query(h) : p.query(h2),',
      '  });',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(countOf(diagnostics, RULE).files, { [OTHER]: 4, [PAST]: 2 });
  for (const d of diagnostics.filter((x) => x.code === 'garden(no-switch-router)'))
    assert.match(d.message, /two procedures under one path .*switch inside its handler.*founderChangeProcedures/u);
});

test('one procedure per path, a spread, `&&`, an empty side and tests stay quiet', skip, () => {
  const past = "export const r = router(control ? live() : { submit: p.mutation(() => notBuilt('x')) });";
  const diagnostics = lint({
    [FIXED]: [
      'export function createFounderAdminRouter(founder: F, control?: C) {',
      '  return router({',
      '    changes: router(founderChangeProcedures(founder, control)),',
      "    list: p.query(({ input }) => (control ? control.list(input) : notBuilt('founderAdmin.approvals.list'))),",
      '    ...(control ? { control: createFounderControlRouter(founder, control) } : {}),',
      '    maybe: control && createFounderControlRouter(founder, control),',
      '    gone: control ? live() : undefined,',
      '  });',
      '}',
    ].join('\n'),
    'services/svc-x/src/router.test.ts': past,
    'services/svc-x/test/router.ts': past,
  });
  assert.deepEqual(countOf(diagnostics, RULE), { total: 0, files: {} });
});

// garden/no-cross-feature-import on planted files: an import that reaches inside another feature fires, by a relative path
// or the admin alias, in every import form; the entry, the feature's own files, shared code, another root and packages
// stay quiet. The count command reads the same findings.
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
const RULE = 'garden/no-cross-feature-import';

/** oxlint's JSON diagnostics over planted files, linted with the root config. */
function lint(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-cross-feature-'));
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

const MONEY = 'apps/customer/src/features/money/NewRoom.tsx';
const ACADEMY = 'apps/admin/src/lib/academy/new-desk.ts';
const ROUTE = 'apps/admin/src/app/(console)/merchants/page.tsx';
const TEST = 'apps/customer/src/features/more/rooms.test.tsx';

test('an import inside another feature fires in every form, in both apps, and names the entry', skip, () => {
  const diagnostics = lint({
    [MONEY]: [
      "import { useSession } from '../session/session';",
      "import type { Plan } from '../more/quant/plan';",
      "export { Row } from '../account/rows/Row';",
      "export * from '../trade/ticket';",
      "const lazy = () => import('../pay/PayRoom');",
      "type S = typeof import('../session/session');",
      "import { deep } from '../session/index/deep';",
    ].join('\n'),
    [ACADEMY]: ["import { DeskTable } from '@/lib/desk/table';", "import { load } from '../accounts/load';"].join('\n'),
    [ROUTE]: "import { Shell } from '../[...founderPath]/shell';",
    [TEST]: "import { seed } from '../session/fixtures';",
  });
  const { total, files } = countOf(diagnostics, RULE);
  assert.deepEqual(files, { [MONEY]: 7, [ACADEMY]: 2, [ROUTE]: 1, [TEST]: 1 });
  assert.equal(total, 11);
  const messages = diagnostics.filter((x) => x.code === 'garden(no-cross-feature-import)').map((d) => d.message);
  assert.ok(
    messages.some((m) =>
      m.includes('inside the feature `features/session`: import what it exposes from its entry, `features/session/index.ts`'),
    ),
  );
  assert.ok(messages.some((m) => m.includes('inside the feature `lib/desk`')));
});

test("an entry, a feature's own files, shared code, another root and packages stay quiet", skip, () => {
  const diagnostics = lint({
    [MONEY]: [
      "import { useSession } from '../session';",
      "import { Plan } from '../more/index';",
      "import { Pay } from '../pay/index.ts';",
      "import { Row } from './rows/Row';",
      "import { Room } from '../money/client';",
      "import { Button } from '../../shared/ui';",
      "import { Screen } from '../../screens/Home';",
      "import { z } from 'zod';",
      "import { RECORD } from '@intafaced/contracts/bank';",
    ].join('\n'),
    // Admin's layers of one area (a route, its components, its lib) are different roots, never compared.
    [ACADEMY]: [
      "import { Desk } from '@/lib/desk';",
      "import { Chip } from '@/components/chip';",
      "import { Trade } from '@/components/trade-ops/table';",
      "import { Page } from '@/app/(console)/trade-ops/page';",
    ].join('\n'),
    // Outside every feature: a screen, shared code, a file directly in a root, a journey test and a service.
    'apps/customer/src/screens/Home.tsx': "import { Row } from '../features/account/rows/Row';",
    'apps/customer/src/shared/ui.tsx': "import { s } from '../features/session/session';",
    'apps/admin/src/components/chip.tsx': "import { m } from './merchants/table';",
    'apps/customer/tests/real-app/J-x.pw.mjs': "import { s } from '../../src/features/session/session';",
    'services/svc-bank/src/features/a/x.ts': "import { y } from '../b/y';",
  });
  assert.deepEqual(countOf(diagnostics, RULE), { total: 0, files: {} });
});

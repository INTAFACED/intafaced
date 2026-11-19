/**
 * Tests for architecture-map.mjs: docs/ARCHITECTURE.md's counts and tables follow the folders.
 * No network. Run: node --test tooling/ci/architecture-map.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { currentFolders, problems, renderBlock, shapeCheck, shapeProblems, tableRows } from './architecture-map.mjs';

const doc = readFileSync(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
const folders = currentFolders();

test('the committed docs/ARCHITECTURE.md is current', () => {
  assert.deepEqual(problems(doc, folders), []);
});

test('project-state#2338: the hand-kept count (24 packages for 29) fails', () => {
  const s = doc.indexOf('<!-- architecture-map:start');
  const e = doc.indexOf('<!-- architecture-map:end -->') + '<!-- architecture-map:end -->'.length;
  const stale = renderBlock({ ...folders, packages: folders.packages.slice(0, 24) });
  const found = problems(doc.slice(0, s) + stale + doc.slice(e), folders);
  assert.ok(
    found.some((p) => p.includes('count block is stale')),
    found.join('\n'),
  );
});

test('project-state#2338: a services table with no svc-campaigns row fails', () => {
  const planted = doc
    .split('\n')
    .filter((l) => !l.startsWith('| `svc-campaigns`'))
    .join('\n');
  const found = problems(planted, folders);
  assert.ok(
    found.some((p) => p.includes('no row for `services/svc-campaigns`')),
    found.join('\n'),
  );
});

test('a row for a deleted service or a missing package fails', () => {
  const planted = doc
    .replace('| `svc-ledger`', '| `svc-chain`      |  gone |\n| `svc-ledger`')
    .replace('| `packages/auth`', '| `packages/gone`');
  const found = problems(planted, folders);
  assert.ok(
    found.some((p) => p.includes('`services/svc-chain`, which does not exist')),
    found.join('\n'),
  );
  assert.ok(
    found.some((p) => p.includes('`packages/gone`, which does not exist')),
    found.join('\n'),
  );
});

test('a grouped packages cell names each package', () => {
  const rows = tableRows(doc, 'Packages that matter', 'packages');
  for (const n of ['venue-contracts', 'venue-adapter', 'db', 'telemetry', 'i18n', 'ui']) assert.ok(rows.includes(n), n);
});

test('--check says the committed doc is current', () => {
  const out = execFileSync(process.execPath, [new URL('./architecture-map.mjs', import.meta.url).pathname, '--check'], {
    encoding: 'utf8',
  });
  assert.match(out, /are current/);
});

test('docs/agents/shape.md names only paths and rules that exist', () => {
  assert.deepEqual(shapeCheck(), []);
});

test('shape.md: a renamed example file, a missing folder and an unrun rule each fail', () => {
  const page = readFileSync(new URL('../../docs/agents/shape.md', import.meta.url), 'utf8');
  const have = new Set(['packages', 'services', 'apps', 'packages/contracts/src/tax-procedures.ts', 'apps/customer/src/features']);
  const exists = (rel) => have.has(rel);
  const planted = [
    'Copy `packages/contracts/src/tax-procedures.ts`, then `services/svc-gone/src/router.ts`.',
    'Its entry is `apps/customer/src/features/<area>/index.ts`; a screen is `apps/customer/src/screenz/<id>/index.tsx`.',
    'Fails: `garden/no-hand-schema`, `garden/no-such-rule`.',
  ].join('\n');
  assert.deepEqual(shapeProblems(planted, exists, ['garden/no-hand-schema']), [
    'docs/agents/shape.md names `services/svc-gone/src/router.ts`, which does not exist: name the file to copy as it is on main.',
    'docs/agents/shape.md names `apps/customer/src/screenz`, which does not exist: name the file to copy as it is on main.',
    'docs/agents/shape.md names `garden/no-such-rule`, which .oxlintrc.json does not run: name a rule that runs.',
  ]);
  assert.ok(page.includes('`packages/contracts/src/procedure-mount.test.ts`'), 'the page names its call example');
});

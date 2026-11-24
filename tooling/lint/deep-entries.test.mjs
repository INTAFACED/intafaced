// garden/no-deep-entry's list of entries (oxlint-plugin-garden/deep-entries.json) is the route table and the menus as
// they are. It reads the app's modules, which import built packages, so CI runs it after the build
// (tooling/scripts/tooling-tests.mjs NEEDS_BUILD). Fix a difference with: node tooling/lint/deep-entries.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILE, deepEntries } from './deep-entries.mjs';

test('the entry list is the route table and menus as they are (else: node tooling/lint/deep-entries.mjs)', async () => {
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')).entries, await deepEntries());
});

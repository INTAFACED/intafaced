#!/usr/bin/env node
// The customer-app paths a journey may enter by `goto` (garden/no-deep-entry, oxlint-plugin-garden/deep-entry-rule.js):
// the front page, every menu row (apps/customer/src/app/menus.ts tabSpecs, Simple and Pro, signed in and out), every room
// the All services index lists (apps/customer/src/screens/more/tiles.ts allServices) and every room an emailed link opens
// (`publicFrame`). Read from the app's own modules, written beside the rule, which the lint ratchet reads from main.
//   node tooling/lint/deep-entries.mjs            write oxlint-plugin-garden/deep-entries.json
//   node tooling/lint/deep-entries.mjs --check    exit 1 when the file differs from the app (deep-entry-rule.test.mjs)
// Needs @intafaced/contracts and @intafaced/i18n built (the route table imports them).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

export const FILE = fileURLToPath(new URL('./oxlint-plugin-garden/deep-entries.json', import.meta.url));
const app = (f) => tsImport(`../../apps/customer/src/${f}`, import.meta.url);

export async function deepEntries() {
  const { rooms } = await app('app/navigation.ts');
  const { tabSpecs } = await app('app/menus.ts');
  const { allServices } = await app('screens/more/tiles.ts');
  const out = new Set(['/']);
  const path = (href) => href.split(/[?#]/)[0];
  for (const mode of ['simple', 'pro'])
    for (const signedIn of [true, false])
      for (const tab of tabSpecs(mode, signedIn)) for (const href of [tab.href, ...tab.items.map((i) => i.href)]) out.add(path(href));
  for (const group of allServices()) for (const room of group.rooms) out.add(room.path);
  for (const room of rooms) if (room.publicFrame && !/[:*]/.test(room.path)) out.add(room.path);
  return [...out].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = await deepEntries();
  if (process.argv.includes('--check')) {
    if (JSON.stringify(JSON.parse(readFileSync(FILE, 'utf8')).entries) !== JSON.stringify(now)) {
      console.error(`${FILE} differs from the route table and menus: run node tooling/lint/deep-entries.mjs`);
      process.exit(1);
    }
  } else writeFileSync(FILE, `${JSON.stringify({ entries: now }, null, 2)}\n`);
}

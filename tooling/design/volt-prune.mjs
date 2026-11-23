#!/usr/bin/env node
// The one script that edits apps/customer/src/app/volt-off-kit.json and apps/customer/kit-ceilings.json downward (#9796).
// A Volt batch into main leaves both alone: a stale entry (a room now on the kit, a ceiling above its file's count) passes
// every check, and only an added entry or a raised ceiling fails. Run this on a branch from main, in a PR of its own,
// whenever wanted: it drops each listed room now on the kit or gone (volt-count.ts `pruned`) and lowers each ceiling to its
// file's count, moving a renamed file's entry to its new path (kit-ceilings.mjs `lowered`). It never adds an entry or
// raises a ceiling, and it changes no room, so the count of rooms in Volt is the same before and after.
// Needs the workspace packages built (`pnpm turbo run build --filter=@intafaced/customer^...`), as the customer tests do.
//   node tooling/design/volt-prune.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { CEILINGS, ROOT, countTree, formatCeilings, lowered, readCeilings, renamesSince } from '../lint/kit-ceilings.mjs';

const OFF_KIT = 'apps/customer/src/app/volt-off-kit.json';
const { pruned, voltCount } = await tsImport('../../apps/customer/src/app/volt-count.ts', import.meta.url);

const count = voltCount();
const before = JSON.parse(readFileSync(join(ROOT, OFF_KIT), 'utf8'));
const after = pruned(count, before);
writeFileSync(join(ROOT, OFF_KIT), `${JSON.stringify(after, null, 2)}\n`);
process.stdout.write(
  `${OFF_KIT}: ${before.length} -> ${after.length} rooms (dropped ${before.length - after.length}); in Volt: ${count.n} of ${count.N}\n`,
);

const ceilings = readCeilings();
const entries = (c) => Object.values(c).reduce((sum, files) => sum + Object.keys(files).length, 0);
const total = (c) => Object.values(c).reduce((sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0), 0);
const next = lowered(countTree(), ceilings, renamesSince(mainRef()));
writeFileSync(join(ROOT, CEILINGS), formatCeilings(next));
process.stdout.write(
  `${CEILINGS}: ${entries(ceilings)} -> ${entries(next)} entries, ${total(ceilings)} -> ${total(next)} findings allowed\n`,
);

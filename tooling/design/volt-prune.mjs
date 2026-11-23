#!/usr/bin/env node
// The one thing that edits apps/customer/src/app/volt-off-kit.json and apps/customer/kit-ceilings.json downward.
// Every PR, a Volt batch into main included, leaves both lists as they are: a stale entry (a room now on the kit, a file
// whose count fell or that is gone) passes there, and an added entry or a raised ceiling fails. Run this in its own PR,
// whenever wanted, so no two batches edit nearby lines of the same JSON file.
//   node tooling/design/volt-prune.mjs    drops each room now on the kit (in Volt or a placeholder) or gone from
//                                         volt-off-kit.json, and lowers each ceiling to today's count; it never adds a
//                                         room nor raises a ceiling, and leaves volt-count's n as it was
// Needs the workspace packages built (`pnpm turbo run build --filter=@intafaced/customer^...`), as the customer tests do.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { CEILINGS, ROOT, countTree, formatCeilings, lowered, readCeilings, renamesSince } from '../lint/kit-ceilings.mjs';

const OFF_KIT = 'apps/customer/src/app/volt-off-kit.json';
const { voltCount, pruneOffKit } = await tsImport('../../apps/customer/src/app/volt-count.ts', import.meta.url);

const count = voltCount();
const before = JSON.parse(readFileSync(join(ROOT, OFF_KIT), 'utf8'));
const after = pruneOffKit(count, before);
writeFileSync(join(ROOT, OFF_KIT), `${JSON.stringify(after, null, 2)}\n`);
process.stdout.write(
  `${OFF_KIT}: ${before.length} -> ${after.length} (dropped ${before.length - after.length}); n ${count.n} of ${count.N}\n`,
);

const ceilings = readCeilings();
const total = (c) => Object.values(c).reduce((sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0), 0);
const next = lowered(countTree(), ceilings, renamesSince(mainRef()));
writeFileSync(join(ROOT, CEILINGS), formatCeilings(next));
process.stdout.write(`${CEILINGS}: ${total(ceilings)} -> ${total(next)}\n`);

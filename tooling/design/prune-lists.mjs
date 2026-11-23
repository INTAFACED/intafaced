#!/usr/bin/env node
// Prunes the two shared lists a Volt batch leaves stale, in its own PR, whenever wanted (intafaced issue 9796): it drops
// from apps/customer/src/app/volt-off-kit.json each room now on the kit or no longer a room, and lowers
// apps/customer/kit-ceilings.json to today's counts (a renamed file's entry moves to its new path, a gone file's drops).
// It is the only thing that edits either list downward; a batch never edits them, since a stale entry passes. It never
// adds a room or raises a ceiling, and it prints Volt's n before and after, which the lists do not change.
// Needs the workspace packages built (`pnpm turbo run build --filter=@intafaced/customer^...`), as volt-count.mjs does.
//   node tooling/design/prune-lists.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { CEILINGS, ROOT, countTree, formatCeilings, lowered, readCeilings, renamesSince } from '../lint/kit-ceilings.mjs';

const { voltCount, prunedOffKit } = await tsImport('../../apps/customer/src/app/volt-count.ts', import.meta.url);
const LIST = join(ROOT, 'apps/customer/src/app/volt-off-kit.json');

const before = voltCount();
const off = JSON.parse(readFileSync(LIST, 'utf8'));
const kept = prunedOffKit(before, off);
writeFileSync(LIST, `${JSON.stringify(kept, null, 2)}\n`);

const entries = (c) => Object.values(c).reduce((sum, files) => sum + Object.keys(files).length, 0);
const ceilings = readCeilings();
const next = lowered(countTree(), ceilings, renamesSince(mainRef()));
writeFileSync(join(ROOT, CEILINGS), formatCeilings(next));

const after = voltCount();
process.stdout.write(
  `volt-off-kit.json: ${off.length} -> ${kept.length} rooms\n` +
    `kit-ceilings.json: ${entries(ceilings)} -> ${entries(next)} entries\n` +
    `Volt: n ${before.n} of ${before.N} before, ${after.n} of ${after.N} after\n`,
);
if (after.n !== before.n) {
  process.stderr.write('prune-lists: n changed, which a list edit never should\n');
  process.exit(1);
}

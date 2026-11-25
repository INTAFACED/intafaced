#!/usr/bin/env node
// The one script that lowers apps/customer/kit-ceilings.json (#9796). A change into main leaves it alone: a ceiling above
// its file's count passes every check, and only a raised ceiling fails. Run this on a branch from main, in a PR of its own,
// whenever wanted: it lowers each ceiling to its file's count, moving a renamed file's entry to its new path
// (kit-ceilings.mjs `lowered`). It never raises a ceiling, and it changes no room.
//   node tooling/design/volt-prune.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { CEILINGS, ROOT, countTree, formatCeilings, lowered, readCeilings, renamesSince } from '../lint/kit-ceilings.mjs';

const ceilings = readCeilings();
const entries = (c) => Object.values(c).reduce((sum, files) => sum + Object.keys(files).length, 0);
const total = (c) => Object.values(c).reduce((sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0), 0);
const next = lowered(countTree(), ceilings, renamesSince(mainRef()));
writeFileSync(join(ROOT, CEILINGS), formatCeilings(next));
process.stdout.write(
  `${CEILINGS}: ${entries(ceilings)} -> ${entries(next)} entries, ${total(ceilings)} -> ${total(next)} findings allowed\n`,
);

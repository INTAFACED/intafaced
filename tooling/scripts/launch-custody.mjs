// The custody switch launch runs with, in one place (#11077). The hosted beta starts its stack with it
// (tooling/beta/beta-host.mjs) and the Real-app journeys run starts each launch-desk shard with it
// (.github/workflows/real-app-journeys.yml), so CI proves the launch desk on the setting the beta and launch run.
// (Failure it prevents: the beta ran custody off from #11019 while every CI journey ran the stack's default, on, so CI
// proved the launch desk on a setup launch won't run, and could pass a step that fails on the beta.)
//
// The launch desk is every Order 1 journey of docs/roadmap/journeys.json (Order 1 is the launch wedge,
// tooling/scripts/roadmap.mjs; a journey marked later for custody is never Order 1). Every other journey is frozen until
// launch and keeps today's setting, the stack's default (local-test-state.mjs startCustodyLayer: on). A file that names no
// journey (menu-reach, registry-blockers) keeps it too.
//
// Usage: node tooling/scripts/launch-custody.mjs --files "<journey files>"
// Prints `off` when every file is a launch-desk file, `on` when none is; a mix exits 1, naming the files, since one
// shard runs one stack on one switch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The custody switch (`LEDGER_CUSTODY_LAYER`, as `LOCAL_STACK_CUSTODY_LAYER` on a stack start) launch runs with. */
export const LAUNCH_CUSTODY_LAYER = 'off';
/** The stack's default, which frozen journeys keep (local-test-state.mjs startCustodyLayer with the variable unset). */
export const FROZEN_CUSTODY_LAYER = 'on';
/** The order that is the launch desk in docs/roadmap/journeys.json. */
export const LAUNCH_ORDER = 1;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JOURNEYS_JSON = path.join(ROOT, 'docs/roadmap/journeys.json');
// A journey file's id ends at its first number; a part file adds a suffix (journey-seal.mjs JOURNEY_TEST).
const JOURNEY_FILE_ID = /^(?:.*\/)?(J-[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+)(?:-[a-z0-9-]+)?\.pw\.mjs$/;

/** The journey id a journey file runs, or null for a file that names none. */
export function journeyIdOf(file) {
  return JOURNEY_FILE_ID.exec(String(file))?.[1] ?? null;
}

/** The ids of the launch-desk journeys (LAUNCH_ORDER) in a journeys.json list. Pure, for the tests. */
export function launchJourneyIds(journeys) {
  if (!Array.isArray(journeys) || journeys.length === 0) throw new Error('journeys.json holds no journey');
  return new Set(journeys.filter((j) => j?.order === LAUNCH_ORDER).map((j) => j.id));
}

/** The launch-desk ids from docs/roadmap/journeys.json. */
export function readLaunchJourneyIds(file = JOURNEYS_JSON) {
  return launchJourneyIds(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** The custody switch a journey file's stack runs: LAUNCH_CUSTODY_LAYER for a launch-desk journey, else today's. */
export function fileCustody(file, launchIds) {
  return launchIds.has(journeyIdOf(file)) ? LAUNCH_CUSTODY_LAYER : FROZEN_CUSTODY_LAYER;
}

/** The one switch a shard of `files` runs; throws naming both kinds when they mix. Pure, for the tests. */
export function shardCustody(files, launchIds) {
  const list = files.filter(Boolean);
  if (list.length === 0) throw new Error('a shard with no journey file has no custody switch');
  const by = Map.groupBy(list, (f) => fileCustody(f, launchIds));
  if (by.size > 1)
    throw new Error(
      `one shard mixes custody ${LAUNCH_CUSTODY_LAYER} (${by.get(LAUNCH_CUSTODY_LAYER).join(' ')}) and ${FROZEN_CUSTODY_LAYER} (${by.get(FROZEN_CUSTODY_LAYER).join(' ')}); the shard planner keeps them apart (journey-shards.mjs)`,
    );
  return [...by.keys()][0];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--files');
  if (i < 0) {
    console.error('usage: node tooling/scripts/launch-custody.mjs --files "<journey files>"');
    process.exit(2);
  }
  try {
    process.stdout.write(`${shardCustody(String(argv[i + 1] ?? '').split(/\s+/), readLaunchJourneyIds())}\n`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

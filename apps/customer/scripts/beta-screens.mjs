#!/usr/bin/env node
// The beta's rooms: every room of the route table an Order 1 journey step showed. Each journey test records the customer-app paths its steps showed (`beta screens`,
// tooling/scripts/journey-screens.mjs); this reads one Real-app journeys report, keeps the steps of the `order: 1`
// journeys in docs/roadmap/journeys.json, maps each path to its room (navigation.ts findRoom) and writes the sorted rooms
// to src/app/beta-screens.json, which the beta's build reads (vite.config.ts betaVoltDefine). A step that shows a room this
// list leaves out is named by the journeys verdict (`notOnBeta`); run this again on a newer report to take it in.
//   node apps/customer/scripts/beta-screens.mjs --run <id>       downloads that run's `real-app-journeys` report (gh)
//   node apps/customer/scripts/beta-screens.mjs --report <file>  reads a report already on disk
// Needs @intafaced/contracts and @intafaced/i18n built (the route table imports them).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = join(ROOT, 'apps/customer/src/app/beta-screens.json');

/**
 * Journeys whose steps walk the full app's catalogue rather than a room a person needs: J-home-ia-02 checks that every
 * door lists every row of the full app and that search finds every area. Their screens would put back the whole menu,
 * so they are left out, and the verdict names their steps not proven on the beta.
 */
export const CATALOGUE_WALKS = { 'J-home-ia-02': 'walks every door and area of the full app (its #1 checks the full menu)' };

/** Each `order: 1` journey's step paths, from a Playwright JSON report: `{ path: [journey, ...] }`. */
export function orderOneScreens(report, journeys) {
  const order1 = new Set(journeys.filter((j) => j.order === 1 && !(j.id in CATALOGUE_WALKS)).map((j) => j.id));
  const seen = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const id = /^(J-[a-z0-9-]+-\d+)\b/.exec(spec.title)?.[1];
      if (!id || !order1.has(id)) continue;
      for (const test of spec.tests ?? [])
        for (const a of [...(test.annotations ?? []), ...(test.results ?? []).flatMap((r) => r.annotations ?? [])]) {
          if (a?.type !== 'beta screens') continue;
          let paths = [];
          try {
            paths = JSON.parse(a.description);
          } catch {
            /* a bad annotation is no screen */
          }
          for (const path of paths) if (typeof path === 'string') (seen.get(path) ?? seen.set(path, new Set()).get(path)).add(id);
        }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return seen;
}

/** The rooms (route table rows) those paths open, sorted; a path no row opens is dropped. */
export function roomsOf(screens, findRoom) {
  const out = new Set();
  for (const path of screens.keys()) {
    const room = findRoom(path);
    if (room) out.add(room.path);
  }
  return [...out].sort();
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  let file = arg('--report');
  const run = arg('--run');
  if (!file && run) {
    const dir = mkdtempSync(join(tmpdir(), 'beta-screens-'));
    execFileSync('gh', ['run', 'download', run, '--repo', 'INTAFACED/intafaced', '-n', 'real-app-journeys', '-D', dir], {
      stdio: 'inherit',
    });
    file = join(dir, 'report.json');
  }
  if (!file) throw new Error('give --run <id> or --report <file>');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const journeys = JSON.parse(readFileSync(join(ROOT, 'docs/roadmap/journeys.json'), 'utf8'));
  const { findRoom } = await tsImport('../src/app/navigation.ts', import.meta.url);
  const screens = orderOneScreens(report, journeys);
  const rooms = roomsOf(screens, findRoom);
  if (!rooms.length) throw new Error('no Order 1 screen in this report: is it a full journeys run?');
  writeFileSync(OUT, `${JSON.stringify({ run: run ?? null, leftOut: CATALOGUE_WALKS, rooms }, null, 2)}\n`);
  console.log(`wrote ${rooms.length} rooms to ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

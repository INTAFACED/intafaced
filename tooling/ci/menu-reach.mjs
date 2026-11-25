#!/usr/bin/env node
/**
 * Which journey steps showed a screen no link path reaches from the app's front doors on the hosted beta's build (owner
 * decision 24 Nov 2026: a step counts as proven only when it passes on the build the beta serves, reached through its
 * menus). It reads one Real-app journeys report:
 *   - the crawl's `menu reach` annotation (apps/customer/tests/real-app/menu-reach.pw.mjs, tooling/scripts/menu-crawl.mjs):
 *     every link the running app showed, page to page, signed out from the front page and the rooms an emailed link
 *     opens, and signed in from Home;
 *   - each step's `beta screens` annotations (apps/customer/tests/real-app/journey.mjs): the paths its test showed;
 *   - each passing step's `beta moves` annotations (tooling/scripts/journey-moves.mjs): the moves the app made on its own
 *     while the step ran, never a typed address. A fresh account the crawl signs up owns no record, so a room that shows
 *     one (`/agents/:agentId`, `/support/tickets/:ticketId`) has no link it can follow; a step that made the record and
 *     clicked through to it shows the way. Each move is one more link from a room to a room, followed only from a room a
 *     path already reaches, and only from a step whose every attempt passed first time.
 * Rooms the beta hides (tooling/ci/beta-hides.mjs, the beta build's own rule) are taken out of the link graph, since the
 * beta has no such page to pass through. A room is reached when a path of links from a front door leads to it; its
 * `reached` entry is that path, one address per room. A step is `notReached` when a screen it showed is on a room no
 * path reaches (a screen the beta hides is the verdict's `notOnBeta`, not this list; an alias room only forwards).
 * `unread` says why no step of the run is known to be reached: no crawl record, a broken crawl, no screens recorded, or
 * the route table or the beta's rule unreadable. project-state's count reads the file (tooling/scoreboard/scoreboard.mjs).
 * It judges nothing here: it always exits 0.
 *
 *   node tooling/ci/menu-reach.mjs --report <report.json> --out <menu-reach.json> [--beta-rule <script>] [--routes <module>]
 * `--beta-rule` and `--routes` are the tests' stand-ins for tooling/ci/beta-hides.mjs and the route table
 * (apps/customer/src/app/navigation.ts `findRoom`).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MENU_REACH } from '../scripts/menu-crawl.mjs';

/** The annotation each journey test carries with the customer-app paths it showed (tooling/scripts/journey-screens.mjs). */
export const BETA_SCREENS = 'beta screens';
/** The annotation each journey test carries with the in-app moves it made (tooling/scripts/journey-moves.mjs). */
export const BETA_MOVES = 'beta moves';
const CRAWL_FILE = /(?:^|\/)menu-reach\.pw\.mjs$/;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)(?:\s+#|,\s+part of #)(\d+)\b/;
/** A test title's step (`J-tax-01#3`), a part of a step (`J-identity-15, part of #1: …`) included; else null. */
export const stepOf = (title) => {
  const m = STEP_TITLE.exec(title ?? '');
  return m ? `${m[1]}#${Number(m[2])}` : null;
};

const annotationsOf = (tests) =>
  (tests ?? []).flatMap((t) => [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r) => r.annotations ?? [])]);

/** Whether every test of a spec passed on its first attempt: a failing or flaky step's moves are not read. */
const passed = (spec) => spec.ok !== false && (spec.tests ?? []).length > 0 && spec.tests.every((t) => t?.status === 'expected');

/**
 * { crawl, screens, moves }: the crawl's record (null when absent), each step's screens (a Set of paths), and the in-app
 * moves of the passing steps ([from, to] pairs, each once).
 */
export function readReport(report) {
  let crawl = null;
  const screens = {};
  const moves = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const notes = annotationsOf(spec.tests);
      // The crawl's record counts only from the crawl's own test, its last attempt (menu-reach.pw.mjs).
      if (CRAWL_FILE.test(spec.file ?? suite.file ?? '') && String(spec.title).startsWith('menu reach:')) {
        const last = (spec.tests ?? []).flatMap((t) => t.results ?? []).at(-1);
        const a = (last?.annotations ?? []).find((x) => x?.type === MENU_REACH);
        try {
          crawl = a ? JSON.parse(a.description) : { unread: 'the crawl test left no record' };
        } catch {
          crawl = { unread: 'the crawl record is not JSON' };
        }
      }
      const step = stepOf(spec.title);
      if (!step) continue;
      if (passed(spec))
        for (const a of notes) {
          if (a?.type !== BETA_MOVES) continue;
          try {
            for (const m of JSON.parse(a.description))
              if (Array.isArray(m) && m.length === 2 && m.every((p) => typeof p === 'string' && p.startsWith('/')))
                moves.set(JSON.stringify(m), m);
          } catch {
            /* not a list: no moves */
          }
        }
      for (const a of notes) {
        if (a?.type !== BETA_SCREENS) continue;
        try {
          for (const path of JSON.parse(a.description)) if (typeof path === 'string') (screens[step] ??= new Set()).add(path);
        } catch {
          /* not a list: no screens */
        }
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report?.suites ?? []) walk(s);
  return { crawl, screens, moves: [...moves.values()] };
}

/** Every concrete path the record, the screens and the moves name, for one call to the beta's rule. */
export function pathsOf(crawl, screens, moves = []) {
  const out = new Set();
  for (const side of [crawl?.signedOut, crawl?.signedIn]) {
    for (const r of side?.roots ?? []) out.add(r);
    for (const [a, b] of side?.edges ?? []) out.add(a).add(b);
  }
  for (const set of Object.values(screens ?? {})) for (const p of set) out.add(p);
  for (const [a, b] of moves) out.add(a).add(b);
  return [...out].sort();
}

/**
 * The reach of each step. `roomOf(path)` gives { room, alias } for a path of the route table, else null; `hidden` is the
 * Set of paths the beta hides; `moves` are passing steps' in-app moves (readReport), each a link from its first room. Returns { reached: { room: [path, ...] }, stepRooms: { step: [room, ...] }, notReached:
 * [{ step, paths }] } or { unread }.
 */
export function menuReach({ crawl, screens, moves = [], roomOf, hidden }) {
  if (!crawl) return { unread: 'no crawl record: apps/customer/tests/real-app/menu-reach.pw.mjs did not run in this run' };
  if (crawl.unread) return { unread: `the crawl broke: ${crawl.unread}` };
  if (!crawl.signedOut || !crawl.signedIn) return { unread: 'the crawl record lacks a signed-out or a signed-in crawl' };
  // A crawl cut short leaves rooms it never opened: what they would reach is unknown, not unreached.
  const left = (crawl.signedOut.left ?? 0) + (crawl.signedIn.left ?? 0);
  if (crawl.signedOut.partial || crawl.signedIn.partial) return { unread: `the crawl was cut short with ${left} rooms not opened` };
  if (!Object.keys(screens).length) return { unread: 'no journey test recorded its screens (beta screens)' };
  const node = (path) => {
    if (hidden.has(path)) return null;
    const r = roomOf(path);
    return r ? r.room : null;
  };
  // The rooms the crawl saw: where each page it opened landed. A link to a room that sent it elsewhere (a sign-in guard)
  // leads where it landed; a link to a room it never opened leads nowhere known.
  const seen = new Set();
  const landsAt = new Map();
  for (const side of [crawl.signedOut, crawl.signedIn])
    for (const [path, landed] of side.opened ?? []) {
      const at = node(landed);
      if (at === null) continue;
      seen.add(at);
      const from = node(path);
      if (from !== null && from !== at && !landsAt.has(from)) landsAt.set(from, [at, landed]);
    }
  const next = new Map();
  for (const side of [crawl.signedOut, crawl.signedIn])
    for (const [a, b] of side.edges ?? []) {
      const from = node(a);
      let to = node(b);
      let path = b;
      if (to !== null && !seen.has(to) && landsAt.has(to)) [to, path] = landsAt.get(to);
      if (from === null || to === null || from === to || !seen.has(to)) continue;
      if (!next.has(from)) next.set(from, []);
      next.get(from).push([to, path]);
    }
  // A passing step's in-app move landed on its room: it is a link from its first room, after every link the crawl saw.
  // It widens no crawl link and opens no front door, and a room the beta hides is no end of one, as for the crawl's links.
  for (const [a, b] of moves) {
    const from = node(a);
    const to = node(b);
    if (from === null || to === null || from === to) continue;
    if (!next.has(from)) next.set(from, []);
    next.get(from).push([to, b]);
  }
  const reached = {};
  const queue = [];
  for (const side of [crawl.signedOut, crawl.signedIn])
    for (const root of side.roots ?? []) {
      const room = node(root);
      if (room === null || reached[room] || !seen.has(room)) continue;
      reached[room] = [root];
      queue.push(room);
    }
  while (queue.length) {
    const room = queue.shift();
    for (const [to, path] of next.get(room) ?? []) {
      if (reached[to]) continue;
      reached[to] = [...reached[room], path];
      queue.push(to);
    }
  }
  const stepRooms = {};
  const notReached = [];
  for (const step of Object.keys(screens).sort()) {
    const rooms = new Set();
    const out = [];
    for (const path of [...screens[step]].sort()) {
      if (hidden.has(path)) continue; // the verdict's notOnBeta
      const r = roomOf(path);
      if (!r || r.alias) continue; // no room of the route table, or one that only forwards
      rooms.add(r.room);
      if (!reached[r.room]) out.push(path);
    }
    stepRooms[step] = [...rooms].sort();
    if (out.length) notReached.push({ step, paths: out });
  }
  return { reached, stepRooms, notReached };
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const firstLine = (e) =>
  String(e?.stderr || e?.message || e)
    .trim()
    .split('\n')[0]
    .slice(0, 300);
export const BETA_RULE = fileURLToPath(new URL('./beta-hides.mjs', import.meta.url));
export const ROUTES = fileURLToPath(new URL('../../apps/customer/src/app/navigation.ts', import.meta.url));

/** The paths the beta's rule hides, run as its own process (it loads the app's TypeScript through tsx). */
function hiddenBy(rule, paths) {
  if (!existsSync(rule)) throw new Error(`the beta's rule ${rule} is missing`);
  const got = JSON.parse(
    execFileSync(process.execPath, [rule], { input: JSON.stringify(paths), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
  ).hidden;
  if (!Array.isArray(got)) throw new Error('the beta rule gave no list');
  return new Set(got);
}

async function main() {
  const reportPath = arg('--report');
  const outPath = arg('--out');
  if (!reportPath || !outPath) throw new Error('usage: menu-reach.mjs --report <report.json> --out <menu-reach.json>');
  let out;
  try {
    const { crawl, screens, moves } = readReport(JSON.parse(readFileSync(reportPath, 'utf8')));
    const early = menuReach({ crawl, screens, roomOf: () => null, hidden: new Set() });
    if (early.unread) out = early;
    else {
      const { tsImport } = await import('tsx/esm/api');
      const { findRoom } = await tsImport(arg('--routes') ?? ROUTES, import.meta.url);
      const roomOf = (path) => {
        const room = findRoom(path);
        return room ? { room: room.path, alias: Boolean(room.alias) } : null;
      };
      const hidden = hiddenBy(arg('--beta-rule') ?? BETA_RULE, pathsOf(crawl, screens, moves));
      out = {
        ...menuReach({ crawl, screens, moves, roomOf, hidden }),
        moves: moves.length,
        crawl: {
          opened: (crawl.signedOut.opened?.length ?? 0) + (crawl.signedIn.opened?.length ?? 0),
          errors: [...(crawl.signedOut.errors ?? []), ...(crawl.signedIn.errors ?? [])].length,
          partial: Boolean(crawl.signedOut.partial || crawl.signedIn.partial),
        },
      };
    }
  } catch (e) {
    out = { unread: firstLine(e) };
  }
  writeFileSync(outPath, `${JSON.stringify(out)}\n`);
  const lines = [
    `### Reached through the menus on the hosted beta: ${out.unread ? 'unknown' : `${Object.keys(out.stepRooms).length - out.notReached.length} of ${Object.keys(out.stepRooms).length} steps`}`,
    '',
    'A step counts as proven only when a trader can reach its screens on the build the hosted beta serves, by links from the front page or Home (owner decision, 24 Nov 2026; menu-reach.json `notReached`). It does not turn this run red.',
    '',
    ...(out.unread
      ? [`Unknown: ${out.unread}. No step of this run is known to be reached.`]
      : out.notReached.length
        ? out.notReached.map((r) => `- ${r.step}: ${r.paths.join(', ')}`)
        : ['Every step is reached.']),
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

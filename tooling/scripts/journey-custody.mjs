// Which custody switch each real-app journey file runs with, and the check that it did (OWNER 226, 288: at launch
// INTAFACED holds no customer money; the custodial layer stays built and switched off, `LEDGER_CUSTODY_LAYER`).
// (Failure it prevents: every launch step was proven on a stack with custody on, so a launch step could pass by posting
// a custodial entry the launch build refuses. project-state research/fable-money-2026-11-10/changes/README.md §3,
// "Factory: launch journeys proven with custody off".)
//
// The rule, read from the journey records (docs/roadmap/journeys.json):
//   - a file of a journey marked `Later: custody` (`later: "custody"`) runs with custody on: those journeys are the
//     custodial layer's own proof;
//   - every other file runs with custody off, the launch build. That includes a launch journey with some steps marked
//     `Later (OWNER 226):` inside it: its launch steps must run off, and a file runs on one stack, so its later steps
//     run off too and show what they need.
// A file is a journey's when its name is the journey's id or starts with the id and a dash (J-ops-console-04-freeze);
// the longest such id wins. A file of no journey (a look sweep) runs off.
//
// Usage:
//   node tooling/scripts/journey-custody.mjs mode "<files>"            on or off for one shard's files; refuses a mix
//   node tooling/scripts/journey-custody.mjs check --state <dir> [--files "<files>"] [--report <report.json>]
//       fails when a ledger or bank start in this stack state ran a custody value other than its files' (the files come
//       from --files, or from the shard's report when the shard had no plan), or when no start was recorded
//   node tooling/scripts/journey-custody.mjs count --report <report.json>
//       launch steps a run's report ran (passed, failed or timed out) on a custody-off file, and the Later ones on on
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLater, isLaterStep } from './roadmap.mjs';

export const JOURNEYS_JSON = 'docs/roadmap/journeys.json';
/** The stack state's record of each custody-switched start (local-test-stack.mjs recordCustodyStart). */
export const CUSTODY_STARTS = path.join('run', 'custody-starts.jsonl');
/** The services whose custody switch decides what a journey can post. */
export const SWITCHED = ['ledger', 'bank'];
const RAN = new Set(['passed', 'failed', 'timedOut']);
const STEP_TITLE = /^(J-[a-z0-9-]+?-\d+) #(\d+)\b/;

const baseName = (file) => path.basename(String(file)).replace(/\.pw\.mjs$/, '');

/** The journey record a file belongs to, or undefined. */
export function journeyOf(file, journeys) {
  const name = baseName(file);
  let best;
  for (const j of journeys) if ((name === j.id || name.startsWith(`${j.id}-`)) && (!best || j.id.length > best.id.length)) best = j;
  return best;
}

/** `on` for a file of a journey marked `Later: custody`, else `off`. */
export function custodyOf(file, journeys) {
  const j = journeyOf(file, journeys);
  return j && isLater(j) ? 'on' : 'off';
}

/** The one custody value a shard's files need; throws when they need both. */
export function shardCustody(files, journeys) {
  const modes = new Set(files.map((f) => custodyOf(f, journeys)));
  if (modes.size > 1) {
    const on = files.filter((f) => custodyOf(f, journeys) === 'on');
    throw new Error(`a shard mixes custody-on files (${on.join(' ')}) with custody-off ones; plan them apart`);
  }
  return modes.has('on') ? 'on' : 'off';
}

/** Files split by the custody they run with, each list in its given order. */
export function partitionByCustody(files, journeys) {
  const out = { on: [], off: [] };
  for (const f of files) out[custodyOf(f, journeys)].push(f);
  return out;
}

/** Journey files a Playwright JSON report ran, relative names as the report gives them. */
export function reportFiles(report) {
  const out = new Set();
  const visit = (suite) => {
    if (suite.file && Array.isArray(suite.specs) && suite.specs.length) out.add(suite.file);
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return [...out].sort();
}

/** The custody-switched starts in a stack state's record, oldest first; a line that is not JSON is a problem. */
export function readStarts(text) {
  const starts = [];
  const problems = [];
  String(text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .forEach((line, i) => {
      try {
        starts.push(JSON.parse(line));
      } catch {
        problems.push(`line ${i + 1} of ${CUSTODY_STARTS} is not JSON`);
      }
    });
  return { starts, problems };
}

/**
 * Why a shard's stack did not run its files' custody value: a mix of files, a switched service never started, or a
 * start (the first or any restart) with another value. An empty list means every start ran what the files need.
 */
export function checkShard({ files, starts, journeys }) {
  const problems = [];
  if (!files.length) return ['the shard names no journey file, so its custody value cannot be checked'];
  let want;
  try {
    want = shardCustody(files, journeys);
  } catch (err) {
    return [err.message];
  }
  for (const service of SWITCHED) {
    const mine = starts.filter((s) => String(s.service).replace(/-2$/, '') === service);
    if (!mine.length) problems.push(`no start of ${service} was recorded with the custody switch`);
    for (const s of mine)
      if (s.custodyLayer !== want)
        problems.push(
          `${s.service} started at ${s.at} with LEDGER_CUSTODY_LAYER=${s.custodyLayer}, but this shard's files run with ${want}` +
            (want === 'off' ? ' (launch steps must run with custody off)' : ' (Later: custody journeys run with custody on)'),
        );
  }
  return problems;
}

/**
 * Steps a report ran, by the custody their file runs with: `launchOff` counts launch steps (a step of a journey not
 * marked Later that is not itself a later step) on a custody-off file, `laterOn` the steps of Later journeys on an on
 * file, `laterStepsOff` the later steps inside launch journeys (they run off with their file). Each journey step counts
 * once, however many files or results it has.
 */
export function countSteps(report, journeys) {
  const byId = new Map(journeys.map((j) => [j.id, j]));
  const sets = { launchOff: new Set(), laterOn: new Set(), laterStepsOff: new Set() };
  const visit = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      if (!(spec.tests ?? []).some((t) => (t.results ?? []).some((r) => RAN.has(r.status)))) continue;
      const m = STEP_TITLE.exec(spec.title ?? '');
      const j = m && byId.get(m[1]);
      const st = j?.steps.find((s) => s.n === Number(m[2]));
      if (!st) continue;
      const key = `${j.id} #${st.n}`;
      const mode = custodyOf(f, journeys);
      if (isLater(j)) {
        if (mode === 'on') sets.laterOn.add(key);
      } else if (mode === 'off') (isLaterStep(st) ? sets.laterStepsOff : sets.launchOff).add(key);
    }
    for (const child of suite.suites ?? []) visit(child, f);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.size]));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const split = (s) =>
  String(s ?? '')
    .split(/\s+/)
    .filter(Boolean);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const journeys = readJson(JOURNEYS_JSON);
  if (cmd === 'mode') {
    process.stdout.write(`${shardCustody(split(argv[0]), journeys)}\n`);
  } else if (cmd === 'check') {
    const state = opt('--state');
    if (!state) throw new Error('check needs --state <the stack state folder>');
    let files = split(opt('--files'));
    if (!files.length && opt('--report') && fs.existsSync(opt('--report'))) files = reportFiles(readJson(opt('--report')));
    const record = path.join(state, CUSTODY_STARTS);
    const { starts, problems: unread } = readStarts(fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '');
    const problems = [...unread, ...checkShard({ files, starts, journeys })];
    for (const p of problems) console.error(`::error::custody: ${p}`);
    if (problems.length) process.exit(1);
    console.log(
      `custody: ${starts.length} ledger and bank start(s), all with LEDGER_CUSTODY_LAYER=${shardCustody(files, journeys)}, for ${files.length} journey file(s)`,
    );
  } else if (cmd === 'count') {
    const report = opt('--report');
    if (!report) throw new Error('count needs --report <report.json>');
    process.stdout.write(`${JSON.stringify(countSteps(readJson(report), journeys))}\n`);
  } else {
    console.error(
      'usage: journey-custody.mjs mode "<files>" | check --state <dir> [--files "<files>"] [--report <r>] | count --report <r>',
    );
    process.exit(2);
  }
}

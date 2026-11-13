/**
 * The tests main's push runs leave out: journey tests nobody has built yet (INTAFACED/project-state#2065, d32 part 5a).
 * Measured on main's run 43362176980
 * (55e3dc226, 13 Nov 2026): 394 of its 414 failing tests were steps the baseline lists as unbuilt, 57 of the run's 640
 * test-minutes, each one failing fast (journey-fail-fast.mjs) and counting red on every run.
 *
 * A test is left out of a full run on a push to main only when all of these hold, read by code:
 *   - its step is `unbuilt` in the baseline (docs/runbooks/journey-baseline.json): it has never passed on main;
 *   - its step passed in no run on main since the baseline's run (the verdict's stored pass history, pass-history.json:
 *     a step the verdict would call "unbuilt, but passed on main" always runs, so a regression never hides here), and
 *     that exact test title passed in none of the finished runs the planner read (the last three and the two newest
 *     scheduled ones), so a step that passes anywhere, a proven one above all, always runs;
 *   - it ran and failed in one of those runs, and no commit on main after the newest such run names its journey in its
 *     subject or changes a file of its journey (apps/customer/tests/real-app/J-x-NN*.pw.mjs). So the moment a builder's
 *     pull request for it merges (its title names the steps), and whenever its test file changes, it runs again; and
 *     otherwise it stays out while a run read still shows it failing: the last three push runs, or the two newest
 *     finished scheduled runs, which leave nothing out (so at the latest after a scheduled run that passes it);
 *   - every test of its step is left out with it, so a step never turns green with one of its tests missing
 *     (project-state's passedSteps needs every test of a step to pass). A new test of a step changes its journey's file,
 *     so it never meets a step already left out;
 *   - its file is not serial (its steps run as one group in order, and leaving one out would run the next without it);
 *   - every test after it in its file is left out too: only a file's tail goes, since a later test may use what an earlier
 *     one made (journeyState, a module variable) in a file that is not serial (run 4788, 13 Nov 2026);
 *   - its file keeps at least one step in the run (the file's first step stays when all of it would go), so the run
 *     still holds every journey file and the verdict never reads it as short of a file (journey-verdict.mjs `missing`).
 * The daily scheduled run, every pull request's run, a targeted run and a run by hand leave nothing out, and without a
 * report, a readable git history or the pass history nothing is left out. No journey test imports this file, so no test's hash moves.
 *
 *   node tooling/scripts/journey-leave-out.mjs --log <git log> --history <pass-history.json> [--run <report.json> <head sha>]...
 * `--log` holds `git log --format='@%H%x09%s' --name-only` from main's head back past the runs read. Prints Playwright's
 * --test-list-invert lines (file › describe › title), one per test, and a count on stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINE_PATH, SERIAL_FILE, passedTitles, stepKey, unbuiltSteps } from './journey-fail-fast.mjs';

const JOURNEY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'customer', 'tests', 'real-app');
const JOURNEY_ID = /\bJ-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/gi;
const JOURNEY_PATH = /^apps\/customer\/tests\/real-app\/(J-[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+)(?:-[a-z0-9-]+)?\.pw\.mjs$/;
const SHA = /^[0-9a-f]{40}$/;
// Playwright splits a test-list line on `›`, or on `>` when the line has none; a title holding either is never listed.
const DELIMITER = '›';

/** Every test in a Playwright JSON report as { file, titles (describe titles, then the test's), title, failed, passed }. */
export function reportTests(report) {
  const out = [];
  const walk = (suite, file, titles) => {
    for (const spec of suite?.specs ?? []) {
      const tests = spec.tests ?? [];
      const passed = tests.length > 0 && tests.every((t) => t.status === 'expected' || t.status === 'flaky');
      const failed = tests.some((t) => t.status === 'unexpected');
      out.push({ file: spec.file ?? file, titles: [...titles, spec.title], title: spec.title, line: spec.line, failed, passed });
    }
    for (const child of suite?.suites ?? []) walk(child, file, [...titles, child.title]);
  };
  for (const s of report?.suites ?? []) walk(s, s.file, []);
  return out;
}

/** `git log --format='@%H%x09%s' --name-only` as [{ sha, subject, files }], newest first. */
export function parseLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('@')) {
      const [sha, ...subject] = line.slice(1).split('\t');
      out.push({ sha, subject: subject.join('\t'), files: [] });
    } else if (line.trim() && out.length) out.at(-1).files.push(line.trim());
  }
  return out;
}

/** The journeys a commit names in its subject or changes a journey file of. */
export function journeysOf(commit) {
  const out = new Set();
  for (const m of String(commit?.subject ?? '').matchAll(JOURNEY_ID)) out.add(`J-${m[0].slice(2).toLowerCase()}`);
  for (const f of commit?.files ?? []) {
    const m = JOURNEY_PATH.exec(f);
    if (m) out.add(m[1]);
  }
  return out;
}

const journeyOf = (key) => String(key).split('#')[0];
const idOf = (t) => [t.file, ...t.titles].join('\u0000');

/**
 * The tests to leave out, as [{ file, titles, key }], by the rules above. `runs` are the finished runs read, each
 * { report, sha } (its head); `log` is parseLog's list from main's head; `history` the verdict's stored pass history
 * ({ runs: { <run id>: { passed: [step keys] } } }; null leaves nothing out); `isSerial(file)` says whether a journey file
 * runs serial. A test whose newest failing run's head is not in `log` stays in. Pure but for `isSerial`.
 */
export function planLeaveOut({ baseline, runs = [], log = [], history = null, isSerial }) {
  if (!runs.length || !log.length || !history) return [];
  const everPassed = new Set(Object.values(history?.runs ?? {}).flatMap((r) => (Array.isArray(r?.passed) ? r.passed : [])));
  const unbuilt = unbuiltSteps(baseline);
  const at = new Map(log.map((c, i) => [c.sha, i]));
  // The journeys touched after each position in the log: since[i] covers the commits newer than log[i].
  const since = [new Set()];
  for (let i = 0; i < log.length; i++) since.push(new Set([...since[i], ...journeysOf(log[i])]));
  const passed = new Set();
  for (const r of runs) for (const t of passedTitles(r.report)) passed.add(t);
  const tests = new Map();
  for (const r of runs) {
    const pos = SHA.test(String(r.sha)) && at.has(r.sha) ? at.get(r.sha) : null;
    for (const t of reportTests(r.report)) {
      const seen = tests.get(idOf(t)) ?? { ...t, failedAt: null, order: tests.size };
      if (t.failed && pos !== null && (seen.failedAt === null || pos < seen.failedAt)) seen.failedAt = pos;
      if (t.failed && pos === null) seen.unknown = true;
      tests.set(idOf(t), seen);
    }
  }
  const serial = new Map();
  const serialFile = (f) => (serial.has(f) ? serial.get(f) : serial.set(f, Boolean(isSerial(f))).get(f));
  const can = (t) => {
    const key = stepKey(t.title);
    return (
      key !== null &&
      unbuilt.has(key) &&
      !everPassed.has(key) &&
      !passed.has(t.title) &&
      t.failedAt !== null &&
      !since[t.failedAt].has(journeyOf(key)) &&
      ![t.file, ...t.titles].some((x) => String(x).includes(DELIMITER) || String(x).includes('>')) &&
      !serialFile(t.file)
    );
  };
  const all = [...tests.values()].sort((a, b) => a.order - b.order);
  const byKey = new Map();
  for (const t of all) {
    const key = stepKey(t.title);
    if (key !== null) byKey.set(key, [...(byKey.get(key) ?? []), t]);
  }
  const keys = new Set([...byKey].filter(([, ts]) => ts.every(can)).map(([k]) => k));
  const byFile = new Map();
  for (const t of all) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  for (const ts of byFile.values()) if (ts.every((t) => keys.has(stepKey(t.title)))) keys.delete(stepKey(ts[0].title));
  // Only a file's tail goes: a test is left out only when every test after it in its file is left out too, since a later
  // test may act on what an earlier one made (journeyState, a module variable) even when the file is not serial. Run 4788
  // on main (43387754252, 13 Nov 2026) left out J-copy-bots-otc-06 #1 and #3, and #2 #4 #5 #6, which passed in the five
  // finished main runs before it, failed with "an earlier step made no follower". Source order is the spec's line, or the
  // report's order when a test has none. Repeated until nothing changes, as bringing one step back can expose another.
  for (const ts of byFile.values()) {
    const lined = ts.every((t) => Number.isFinite(t.line));
    const ordered = [...ts].sort((a, b) => (lined ? a.line - b.line : 0) || a.order - b.order);
    for (let changed = true; changed;) {
      changed = false;
      let keptAfter = false;
      for (const t of [...ordered].reverse()) {
        const key = stepKey(t.title);
        if (!keys.has(key)) keptAfter = true;
        else if (keptAfter) {
          keys.delete(key);
          changed = true;
        }
      }
    }
  }
  return all.filter((t) => keys.has(stepKey(t.title))).map((t) => ({ file: t.file, titles: t.titles, key: stepKey(t.title) }));
}

/** Playwright's --test-list-invert text for a plan: one `file › describe › title` line per test. */
export const testListText = (plan) => (plan ?? []).map((t) => [t.file, ...t.titles].join(` ${DELIMITER} `)).join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const runs = [];
  let log = [];
  let history = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log' && fs.existsSync(args[i + 1])) log = parseLog(fs.readFileSync(args[++i], 'utf8'));
    else if (args[i] === '--history' && fs.existsSync(args[i + 1]))
      try {
        history = JSON.parse(fs.readFileSync(args[++i], 'utf8'));
        if (!history?.runs || typeof history.runs !== 'object') history = null;
      } catch (e) {
        console.error(`no pass history: ${e.message}`);
      }
    else if (args[i] === '--run') {
      const [file, sha] = [args[++i], args[++i]];
      try {
        runs.push({ report: JSON.parse(fs.readFileSync(file, 'utf8')), sha });
      } catch (e) {
        console.error(`skipping ${file}: ${e.message}`);
      }
    }
  }
  const plan = planLeaveOut({
    baseline: JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')),
    runs,
    log,
    history,
    isSerial: (f) => {
      try {
        return SERIAL_FILE.test(fs.readFileSync(path.join(JOURNEY_DIR, f), 'utf8'));
      } catch {
        return true; // a file that can't be read is never left out
      }
    },
  });
  console.error(
    `${plan.length} tests of ${new Set(plan.map((t) => t.key)).size} unbuilt steps are left out (${runs.length} runs read, ${log.length} commits of history, ${history ? Object.keys(history.runs).length : 'no'} runs of pass history)`,
  );
  console.log(testListText(plan));
}

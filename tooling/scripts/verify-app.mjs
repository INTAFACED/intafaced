#!/usr/bin/env node
/**
 * The helpers of the verify-intafaced skill (.claude/skills/verify-intafaced/SKILL.md): prove a change in the running
 * app with one command per step, on this checkout's own local test stack and the journeys' own harness.
 *
 *   pnpm local:stack verify launch [<J-id> ...] [--only a,b]   start or reuse this checkout's stack, rebuild what changed,
 *                                                  ready it once, and say when it is usable
 *   pnpm local:stack verify doctor                 read-only: is this instance worth driving?
 *   pnpm local:stack verify drive <J-id> [#n ...]  drive those steps of a journey; evidence kept in .verify/runs/
 *   pnpm local:stack verify look <path> [--sign-up] [--selector <css>]   one page as a person sees it: screenshot and
 *                                                  ARIA snapshot (and one element's box and text), kept in .verify/runs/
 *   pnpm local:stack verify map [<J-id> ...]       write the feature map from docs/roadmap/journeys.json and the journey
 *                                                  tests' titles; with ids, print where those features' files are
 *   pnpm local:stack verify evidence               the kept runs, newest first
 *   pnpm local:stack verify stop                   stop the stack, only when `verify launch` started it; evidence stays
 *
 * A word of the stack's own start (local-test-stack.mjs `start verify`), as `journey` is, so every check that guards a
 * stack start on the Mac guards these too. Run directly, this file only says so.
 *
 * It wraps what exists and adds no second harness: the start, stop, status and plan of local-test-stack.mjs; the readying
 * of journey-local.mjs (`readyStack`); the journeys' Playwright config, fixtures and helpers. A drive is a run of the
 * journey's own step tests, so a step proves here exactly what it proves in CI. A local pass never counts as proof: the
 * proof is the Real-app journeys run on the pull request's exact head.
 *
 * Exit: 0 done (doctor: worth driving; drive and look: passed); 1 not (the line says why and what to run); 2 usage;
 * 3 no local stack (every slot held, or the start refused).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT, slotClaims, slotPorts } from './local-test-facts.mjs';
import { JOURNEY_DIR, onlyReady, readyStack, realIo, refusal } from './journey-local.mjs';
import { READS_PAST, withoutComments } from './journey-market-past.mjs';
import { WORLD, declaredWorld, marketLive, stackFresh } from '../../apps/customer/tests/real-app/world-line.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACK = path.join(HERE, 'local-test-stack.mjs');
const CONFIG = path.join(JOURNEY_DIR, 'real-app.playwright.config.mjs');
const LOOK_CONFIG = path.join(HERE, 'verify-look.config.mjs');
export const VERIFY_DIR = path.join(CHECKOUT, '.verify');
export const RUNS_DIR = path.join(VERIFY_DIR, 'runs');
const LAUNCH = path.join(VERIFY_DIR, 'launch.json');
export const FEATURES_DIR = path.join(CHECKOUT, '.claude/skills/verify-intafaced/features');
const JOURNEYS_JSON = path.join(CHECKOUT, 'docs', 'roadmap', 'journeys.json');
const PREFIX = 'verify:';
const RUN = 'pnpm local:stack verify';

// ── Arguments ───────────────────────────────────────────────────────────────

const USAGE = `usage: ${RUN} launch [<J-id> ...] [--only a,b] | doctor | drive <J-id> [#n ...] | look <path> [--sign-up] [--selector <css>] | map [<J-id> ...] | evidence | stop`;

/** argv -> { cmd, ... } or { error }. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const at = rest.indexOf(name);
    if (at === -1) return { value: null };
    const value = rest[at + 1];
    if (!value || value.startsWith('--')) return { error: `${name} needs a value` };
    rest.splice(at, 2);
    return { value };
  };
  const unknown = () => rest.find((a) => a.startsWith('--'));
  if (cmd === 'launch') {
    const only = flag('--only');
    if (only.error) return only;
    if (unknown()) return { error: `unknown option ${unknown()}` };
    return { cmd, ids: rest, only: only.value };
  }
  if (cmd === 'drive') {
    if (unknown()) return { error: `unknown option ${unknown()}` };
    const [id, ...steps] = rest;
    if (!id || !/^J-[a-z0-9-]+-\d+$/.test(id)) return { error: `drive needs a journey id: ${RUN} drive <J-id> [#n ...]` };
    const ns = steps.map((s) => s.replace(/^#/, ''));
    if (ns.some((n) => !/^\d+$/.test(n))) return { error: `steps are written #1 #2 (got ${steps.join(' ')})` };
    return { cmd, id, steps: [...new Set(ns.map(Number))].sort((a, b) => a - b) };
  }
  if (cmd === 'look') {
    const selector = flag('--selector');
    if (selector.error) return selector;
    const signUp = rest.includes('--sign-up');
    const left = rest.filter((a) => a !== '--sign-up');
    if (left.find((a) => a.startsWith('--'))) return { error: `unknown option ${left.find((a) => a.startsWith('--'))}` };
    if (left.length !== 1 || !left[0].startsWith('/')) return { error: `look needs one path that starts with /: ${RUN} look /predict` };
    return { cmd, path: left[0], signUp, selector: selector.value };
  }
  if (cmd === 'map') {
    if (unknown()) return { error: `unknown option ${unknown()}` };
    return { cmd, ids: rest };
  }
  if (['doctor', 'evidence', 'stop'].includes(cmd)) {
    if (rest.length) return { error: `${cmd} takes no arguments` };
    return { cmd };
  }
  return { error: USAGE };
}

// ── The feature map: journeys.json and the journey tests' own titles ────────

/** The title a step's test starts with (tooling/ci/journey-verdict.mjs STEP_TITLE): only such a test proves a step. */
export const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b\s*:?\s*(.*)$/s;

/**
 * Every test a journey source declares: its title (with the file's `const J = '…'` put in) and line. Titles are read
 * from the source, so a drive needs no running stack to plan, and the map needs no Playwright.
 */
export function testTitles(src) {
  const j = /^const J = (['"`])(J-[a-z0-9-]+-\d+)\1;?$/m.exec(src)?.[2] ?? null;
  const out = [];
  const re = /\btest(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(`|'|")((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  for (const m of src.matchAll(re)) {
    const title = m[2]
      .replace(/\$\{J\}/g, j ?? '${J}')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ title, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** The literal paths a journey source opens (`page.goto('/x')`), in order, once each; a templated part reads `…`. */
export function pagePaths(src) {
  const seen = [];
  for (const m of withoutComments(src).matchAll(/\.goto\(\s*(`|'|")(\/[^`'"]*)\1/g)) {
    const p = m[2].replace(/\$\{[^}]*\}/g, '…');
    if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * The journey test folder read once: per journey id, its files and, per step, the tests whose titles prove it.
 * `read(file)` returns a file's text; `files` names the `*.pw.mjs` files to read.
 */
export function journeyIndex(files, read) {
  const index = new Map();
  const entry = (id) => {
    if (!index.has(id)) index.set(id, { files: new Map(), steps: new Map() });
    return index.get(id);
  };
  for (const file of files) {
    const src = read(file);
    const titles = testTitles(src);
    let world;
    try {
      world = declaredWorld(src);
    } catch {
      world = 'unread'; // a `// World:` line in words of its own, not the harness's parts
    }
    const facts = {
      serial: /test\.describe\.configure\(\{\s*mode:\s*'serial'/.test(src),
      world: world instanceof Set ? [...world] : world,
      fresh: stackFresh(src),
      live: marketLive(src),
      past: READS_PAST.test(withoutComments(src)),
      paths: pagePaths(src),
      others: 0,
    };
    for (const t of titles) {
      const m = STEP_TITLE.exec(t.title);
      if (!m) continue;
      const e = entry(m[1]);
      if (!e.files.has(file)) e.files.set(file, { ...facts });
      const n = Number(m[2]);
      if (!e.steps.has(n)) e.steps.set(n, []);
      e.steps.get(n).push({ file, line: t.line, title: t.title, words: m[3].trim() });
    }
    // Tests in a step file that prove no step (a start, an end, a part of a step): counted for the gotchas.
    for (const [, e] of index)
      for (const [f, info] of e.files) if (f === file) info.others = titles.filter((t) => !STEP_TITLE.test(t.title)).length;
  }
  return index;
}

/** A step's marks in journeys.json, as words. */
function marks(step) {
  return [
    step.parked ? `parked${step.parkedUntil ? ` until ${step.parkedUntil}` : ''}` : null,
    step.later ? `later (${step.later})` : null,
    step.deferred ? `deferred${typeof step.deferred === 'string' ? ` (${step.deferred})` : ''}` : null,
  ].filter(Boolean);
}

const relJourney = (file) => `apps/customer/tests/real-app/${file}`;

/** One journey's feature file, in the map's four-section shape (features/README.md, "Feature entry contract"). */
export function featureMarkdown(j, found) {
  const files = found ? [...found.files.keys()] : [];
  const infos = found ? [...found.files.values()] : [];
  const out = [];
  out.push(`# ${j.id}: ${j.title}`, '');
  out.push(
    `A ${j.persona} person's ${j.tier} journey in the ${j.module} part of the app, order ${j.order}${marks(j).length ? `, ${marks(j).join(', ')}` : ''}. ` +
      (files.length
        ? `Its steps are driven by the tests titled \`${j.id} #<n>\` in ${files.map((f) => `\`${relJourney(f)}\``).join(', ')}.`
        : 'No journey test file holds a test titled with its id yet, so nothing drives it.') +
      ' Generated from `docs/roadmap/journeys.json` and those titles by `pnpm local:stack verify map`: change them, never this file.',
    '',
  );
  out.push('## Sub-features', '');
  for (const st of j.steps) {
    const tests = found?.steps.get(st.n) ?? [];
    const m = marks(st);
    const words = tests.length
      ? tests.map((t) => t.words || t.title).join(' / ')
      : 'no test is titled with this step yet: nothing drives it';
    out.push(`- \`#${st.n}\` ${words}${m.length ? ` (${m.join(', ')})` : ''}`);
  }
  for (const [n, tests] of found?.steps ?? [])
    if (!j.steps.some((st) => st.n === n))
      out.push(`- \`#${n}\` ${tests.map((t) => t.words).join(' / ')} (a test names this step; journeys.json does not list it)`);
  out.push('', '## How to get to it (user POV)', '');
  const paths = [...new Set(infos.flatMap((i) => i.paths))];
  if (paths.length) for (const p of paths) out.push(`- Open \`${p}\` in the app (the journey's tests open it).`);
  else out.push('- The tests open no page by a fixed path: read the step tests for how a person gets there.');
  out.push('', '## Driving it with verify', '', 'Preconditions:', '');
  out.push(`- \`${RUN} doctor\` ends \`worth driving\`.`);
  for (const [f, i] of found?.files ?? [])
    out.push(
      `- \`${f}\` changes in the shared stack: ${i.world === null ? 'unknown (no `// World:` line)' : i.world === 'unread' ? 'what its own `// World:` line says' : i.world.length ? i.world.map((w) => `${w} (${WORLD[w]})`).join('; ') : 'nothing'}.`,
    );
  out.push('');
  const proven = j.steps.filter((st) => found?.steps.has(st.n));
  for (const st of proven) {
    const tests = found.steps.get(st.n);
    out.push(
      `- **Step #${st.n}.** Run \`${RUN} drive ${j.id} '#${st.n}'\`. It passes when ${tests.map((t) => `\`${relJourney(t.file)}:${t.line}\``).join(' and ')} pass${tests.length === 1 ? 'es' : ''}; the screenshot of each page at its end, the report and summary.md are in the run folder it prints.`,
    );
  }
  if (proven.length > 1) out.push(`- **Every step.** Run \`${RUN} drive ${j.id}\`.`);
  if (!proven.length) out.push(`- Nothing to drive yet: no test is titled \`${j.id} #<n>\`.`);
  out.push('', '## Gotchas', '');
  const gotchas = [];
  for (const [f, i] of found?.files ?? []) {
    if (i.serial)
      gotchas.push(`\`${f}\` runs serially (its steps share one TEST person), so driving one of its steps runs the whole file.`);
    if (i.past)
      gotchas.push(
        `\`${f}\` reads past trades (charts, candles, the tape): launch with \`${RUN} launch ${j.id}\` so the TEST chart history is written, or its steps fail on an empty chart.`,
      );
    if (i.fresh)
      gotchas.push(
        `\`${f}\` needs a fresh stack (\`// Stack: fresh\`): drive it before anything else uses the stack, or relaunch on a new state folder.`,
      );
    if (i.live) gotchas.push(`\`${f}\` waits for the TEST market's own trades (\`// Market: live\`).`);
    if (i.others)
      gotchas.push(
        `\`${f}\` has ${i.others} test(s) that prove no step (a start, an end, or a part of a step); ${i.serial ? 'its whole-file drive runs them too' : 'a step drive leaves them out'}.`,
      );
  }
  const unproven = j.steps.filter((st) => !found?.steps.has(st.n) && !marks(st).length).map((st) => `#${st.n}`);
  if (unproven.length) gotchas.push(`Steps ${unproven.join(', ')} have no test titled with them: a drive cannot prove them.`);
  const marked = j.steps.filter((st) => marks(st).length).map((st) => `#${st.n} ${marks(st).join(', ')}`);
  if (marked.length)
    gotchas.push(`Marked in journeys.json: ${marked.join('; ')}. Such a step is not built for launch; never weaken it to pass.`);
  gotchas.push(
    'A seed that lacks what a step needs makes the step fail: report the failure and its reason; never weaken the test to pass.',
  );
  for (const g of gotchas) out.push(`- ${g}`);
  return `${out.join('\n')}\n`;
}

/** The map's index: every journey by module, with its feature file and how many steps a drive can prove. */
export function indexMarkdown(journeys, index) {
  const out = [
    '# Feature index (generated)',
    '',
    `Generated by \`${RUN} map\` from \`docs/roadmap/journeys.json\` and the journey tests' titles. Read [README.md](./README.md) first; open a journey's own file for its recipe.`,
    '',
  ];
  const byModule = new Map();
  for (const j of journeys) {
    if (!byModule.has(j.module)) byModule.set(j.module, []);
    byModule.get(j.module).push(j);
  }
  for (const [module, list] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`## ${module}`, '');
    for (const j of list) {
      const proven = j.steps.filter((st) => index.get(j.id)?.steps.has(st.n)).length;
      out.push(
        `- [${j.id}](./${j.id}.md) ${j.title} (${proven} of ${j.steps.length} steps drivable${marks(j).length ? `; ${marks(j).join(', ')}` : ''})`,
      );
    }
    out.push('');
  }
  return `${out.join('\n')}`;
}

/** The files a drive of these steps runs, and the --grep that picks the step tests (all of them when `steps` is empty). */
export function planDrive(id, steps, found) {
  if (!found || found.steps.size === 0) return { error: `no test is titled ${id} #<n> in apps/customer/tests/real-app` };
  const want = steps.length ? steps : [...found.steps.keys()].sort((a, b) => a - b);
  const missing = want.filter((n) => !found.steps.has(n));
  if (missing.length)
    return {
      error: `${id} has no test titled ${missing.map((n) => `#${n}`).join(', ')} (it has ${[...found.steps.keys()]
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(' ')})`,
    };
  const files = [...new Set(want.flatMap((n) => found.steps.get(n).map((t) => t.file)))].sort();
  // A serial file's steps share one person: a step alone would run without the steps before it, so the whole file runs.
  const serial = files.filter((f) => found.files.get(f)?.serial);
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const grep = serial.length ? null : `${esc} #(?:${want.join('|')})\\b`;
  return { files, grep, steps: want, serial, past: files.filter((f) => found.files.get(f)?.past) };
}

// ── Reading a Playwright JSON report ────────────────────────────────────────

const ESC = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Every test the report holds: title, status, first error line, and the screenshots it attached. */
export function reportTests(report) {
  const out = [];
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1);
        const error = String(last?.error?.message ?? last?.errors?.[0]?.message ?? '')
          .replace(ESC, '')
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean);
        out.push({
          file: spec.file ?? file,
          title: spec.title,
          status: t.status === 'expected' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed',
          error: t.status === 'expected' ? null : (error ?? t.status ?? 'failed'),
          shots: (last?.attachments ?? []).filter((a) => a.contentType === 'image/png' && a.path).map((a) => a.path),
          trace: (last?.attachments ?? []).find((a) => a.name === 'trace')?.path ?? null,
        });
      }
  };
  for (const s of report?.suites ?? []) walk(s, s.file);
  for (const e of report?.errors ?? [])
    out.push({ file: null, title: 'run error', status: 'failed', error: String(e.message ?? e).split('\n')[0], shots: [], trace: null });
  return out;
}

/** The run's summary.md: what was driven, how, on what, and what each test showed. */
export function summaryMarkdown(run) {
  const lines = [
    `# ${run.label}: ${run.verdict}`,
    '',
    `- What: ${run.what}`,
    `- Command: \`${run.command}\``,
    `- Code: ${run.head}${run.dirty ? ' with uncommitted edits' : ''} on branch ${run.branch}`,
    `- Stack: slot ${run.slot}, ${run.customer}`,
    `- Started ${run.startedAt}, ended ${run.endedAt}, exit ${run.exit}`,
    '',
    '## Tests',
    '',
  ];
  for (const t of run.tests) {
    lines.push(`- ${t.status.toUpperCase()} ${t.title}${t.error ? `: ${t.error}` : ''}`);
    for (const s of t.shots) lines.push(`  - screenshot: ${path.relative(run.dir, s)}`);
    if (t.trace) lines.push(`  - trace: ${path.relative(run.dir, t.trace)}`);
  }
  if (run.files?.length) lines.push('', '## Files kept', '', ...run.files.map((f) => `- ${f}`));
  lines.push('', "A local pass never counts as proof: the proof is the Real-app journeys run on the PR's exact head.");
  return `${lines.join('\n')}\n`;
}

// ── Doctor ──────────────────────────────────────────────────────────────────

/**
 * The doctor's verdict from what it read: `claim` (this checkout's slot claim and whether it is live), `status` (the
 * stack's own health table and its exit), `plan` (`plan --json`: running processes and what a start would build), and
 * `launch` (.verify/launch.json) and `stack` (this stack's identity, stackId). Each check is { ok, name, detail, fix }; the
 * instance is worth driving when all are ok.
 */
export function doctorChecks({ claim, status, plan, launch, stack }) {
  const checks = [];
  const add = (ok, name, detail, fix = null) => checks.push({ ok, name, detail, fix });
  if (!claim?.live) {
    add(false, 'stack', 'this checkout has no running stack of its own', `${RUN} launch`);
    return checks;
  }
  const ports = slotPorts(claim.slot).stack;
  add(true, 'stack', `slot ${claim.slot}, this checkout's, Customer at http://127.0.0.1:${ports.customer}`);
  const rows = parseHealth(status.text);
  const bad = rows.filter((r) => !/^(ok|absent)\b/.test(r.health) && r.name !== 'market-maker');
  // The table's own exit also fails on a stale market maker, which the next check names apart.
  add(
    rows.length > 0 && bad.length === 0,
    'health',
    rows.length === 0
      ? 'the health table did not print'
      : bad.length
        ? bad.map((r) => `${r.name} ${r.health}`).join(', ')
        : `${rows.length} rows ok`,
    `${RUN} launch`,
  );
  const market = rows.find((r) => r.name === 'market-maker');
  if (market) add(!/^(down|stale)\b/i.test(market.health), 'market', `TEST market maker: ${market.health}`, `${RUN} launch`);
  // Ownership: every service answering on this slot's ports is one this stack started (pid, command line, start time).
  const answering = rows.filter((r) => /^ok\b/.test(r.health) && r.name.startsWith('svc-')).map((r) => r.name.slice(4));
  const notOurs = plan ? answering.filter((n) => plan.services.find((s) => s.name === n)?.running === false) : [];
  add(
    Boolean(plan) && notOurs.length === 0,
    'owned',
    !plan
      ? 'plan --json did not answer'
      : notOurs.length
        ? `answering but not started by this stack: ${notOurs.join(', ')}`
        : "every answering service is this stack's own process",
    'stop whatever holds those ports; never drive an instance this run did not start',
  );
  const stale = plan ? plan.services.filter((s) => s.running && s.onCurrentBuild === false).map((s) => s.name) : [];
  const build = plan?.build ?? null;
  add(
    Boolean(build) && build.backend === 'none' && !build.customer && stale.length === 0,
    'build',
    !build
      ? 'plan --json says nothing of the build'
      : build.backend !== 'none' || build.customer
        ? `the source changed since the last build (a start would build: ${[build.backend !== 'none' ? `backend ${build.backend}` : null, build.customer ? 'customer' : null].filter(Boolean).join(', ')})`
        : stale.length
          ? `running on an older build: ${stale.join(', ')}`
          : `running the build of ${build.head?.slice(0, 10) ?? 'this checkout'} with this checkout's edits`,
    `${RUN} launch`,
  );
  const same = Boolean(stack) && launch?.stack === stack;
  add(
    same && Boolean(launch?.readiedAt),
    'readied',
    same && launch?.readiedAt
      ? `readied ${launch.readiedAt}${launch.history ? ', TEST chart history written' : ''}`
      : 'this stack was not readied by verify launch (gates, market, TEST content)',
    `${RUN} launch`,
  );
  return checks;
}

/** The stack's health table -> [{ name, health }]. */
export function parseHealth(text) {
  const rows = [];
  let inTable = false;
  for (const l of String(text ?? '').split('\n')) {
    if (/^\s{2}SERVICE\s+PORT\s+PID\s+HEALTH\s*$/.test(l)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const m = /^\s{2}(\S+(?: \(TEST\))?)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(l);
    if (!m) break; // the table ends at its first line that is not a row
    rows.push({ name: m[1].replace(/ \(TEST\)$/, ''), health: m[4].trim() });
  }
  return rows;
}

// ── The commands ────────────────────────────────────────────────────────────

/** This checkout's slot claim: { slot, claim, live } or null. */
const ourClaim = () => slotClaims().find((c) => c.claim?.repo === CHECKOUT) ?? null;

/**
 * One running stack's identity: its Postgres's pid and start time (postmaster.pid, lines 1 and 3), or null when it has
 * none. A service restart keeps it; a stop and a new start change it, so a readying is never credited to another stack.
 * (The slot claim's own time is rewritten by every start and restart, so it cannot be the identity.)
 */
export function stackId(postmaster) {
  const [pid, , started] = String(postmaster ?? '').split('\n');
  return /^\d+$/.test(pid ?? '') && /^\d+$/.test(started ?? '') ? `${pid}@${started}` : null;
}

function currentStackId(claim) {
  if (!claim?.live || !claim.claim?.state) return null;
  try {
    return stackId(fs.readFileSync(path.join(claim.claim.state, 'data', 'postgres', 'postmaster.pid'), 'utf8'));
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const git = (...args) => spawnSync('git', args, { cwd: CHECKOUT, encoding: 'utf8' }).stdout?.trim() ?? '';

function journeyFilesOnDisk() {
  return fs
    .readdirSync(JOURNEY_DIR)
    .filter((f) => /^J-[A-Za-z0-9._-]+\.pw\.mjs$/.test(f))
    .sort();
}

function loadIndex() {
  return journeyIndex(journeyFilesOnDisk(), (f) => fs.readFileSync(path.join(JOURNEY_DIR, f), 'utf8'));
}

/** A run folder under .verify/runs, named by its UTC start and label. */
function newRunDir(label) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const dir = path.join(RUNS_DIR, `${stamp}-${label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function doctor(io, { quiet = false } = {}) {
  const claim = ourClaim();
  let status = { code: 1, text: '' };
  let plan = null;
  if (claim?.live) {
    status = await io.run(['node', STACK, 'status'], { capture: true, echo: false });
    const p = await io.run(['node', STACK, 'plan', '--json'], { capture: true, echo: false });
    try {
      plan = JSON.parse(p.text);
    } catch {
      plan = null;
    }
  }
  const checks = doctorChecks({ claim, status, plan, launch: readJson(LAUNCH), stack: currentStackId(claim) });
  const ok = checks.every((c) => c.ok);
  if (!quiet || !ok) {
    for (const c of checks) io.say(`${PREFIX} doctor ${c.ok ? 'ok ' : 'NOT'} ${c.name}: ${c.detail}`);
    const first = checks.find((c) => !c.ok);
    io.say(ok ? `${PREFIX} doctor: worth driving` : `${PREFIX} doctor: not worth driving (${first.name}). Fix: ${first.fix}`);
  }
  return { ok, checks, claim };
}

async function launch(opts, io) {
  const t0 = Date.now();
  const before = ourClaim();
  const hadStack = Boolean(before?.live);
  const prev = readJson(LAUNCH);
  let files = null;
  if (opts.ids.length) {
    const index = loadIndex();
    const missing = opts.ids.filter((id) => !index.has(id));
    if (missing.length) {
      io.say(`${PREFIX} launch: no test is titled ${missing.join(', ')} #<n>`);
      return 2;
    }
    files = [...new Set(opts.ids.flatMap((id) => [...index.get(id).files.keys()]))];
  }
  io.say(
    `${PREFIX} launch: ${hadStack ? `this checkout's stack is up on slot ${before.slot}; starting what is not running and rebuilding what changed` : 'starting a stack for this checkout'}`,
  );
  const start = await io.run(['node', STACK, 'start', ...(opts.only ? ['--only', opts.only] : [])], { capture: true });
  const why = refusal(start.text);
  const ready = start.code === 0 || (opts.only && start.code === 1 && !why && onlyReady(start.text, opts.only).ready);
  if (!ready) {
    if (why) {
      io.say(
        `${PREFIX} launch: the start refused (${why}). Prove the change on CI's stack instead: gh workflow run real-app-journeys.yml --ref <branch> -f journeys="<J-x>.pw.mjs"`,
      );
      return 3;
    }
    io.say(`${PREFIX} launch: the stack did not come up healthy; see the table above. Then: ${RUN} doctor`);
    return 1;
  }
  const claim = ourClaim();
  const stack = currentStackId(claim);
  const same = Boolean(stack) && prev?.stack === stack;
  const startedByUs = same ? Boolean(prev.startedByUs) : !hadStack;
  const record = {
    checkout: CHECKOUT,
    slot: claim?.slot,
    stack,
    startedByUs,
    readiedAt: same ? prev.readiedAt : null,
    history: same ? Boolean(prev.history) : false,
  };
  writeJson(LAUNCH, record);
  const needHistory = files !== null && !record.history;
  if (!record.readiedAt || needHistory) {
    io.say(
      `${PREFIX} launch: readying it as a journeys shard is readied (gates, TEST market, TEST content${files ? ', chart history when these journeys read it' : ''})`,
    );
    try {
      const r = await readyStack(io, files);
      record.readiedAt = new Date().toISOString();
      record.history = record.history || r.history;
      writeJson(LAUNCH, record);
    } catch (e) {
      io.say(`${PREFIX} launch: the stack could not be readied: ${e.message}. Clean up: ${RUN} stop`);
      return 1;
    }
  } else io.say(`${PREFIX} launch: already readied ${record.readiedAt}`);
  const d = await doctor(io, { quiet: true });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!d.ok) return 1;
  const customer = `http://127.0.0.1:${slotPorts(claim.slot).stack.customer}`;
  io.say(
    `${PREFIX} launch: ready in ${secs}s: ${customer} (slot ${claim.slot}; ${startedByUs ? `${RUN} stop stops it` : 'not started by verify launch, so verify stop leaves it running'})`,
  );
  return 0;
}

async function drive(opts, io) {
  const index = loadIndex();
  const plan = planDrive(opts.id, opts.steps, index.get(opts.id));
  if (plan.error) {
    io.say(`${PREFIX} drive: ${plan.error}`);
    return 2;
  }
  const d = await doctor(io, { quiet: true });
  if (!d.ok) return 1;
  const launchRec = readJson(LAUNCH);
  if (plan.past.length && !launchRec?.history) {
    io.say(
      `${PREFIX} drive: ${plan.past.join(', ')} read past trades and this stack has no TEST chart history. Fix: ${RUN} launch ${opts.id}`,
    );
    return 1;
  }
  for (const f of plan.serial) io.say(`${PREFIX} drive: ${f} runs serially (one TEST person through its steps), so the whole file runs`);
  const label = `${opts.id}${opts.steps.length ? `-${opts.steps.map((n) => `s${n}`).join('-')}` : ''}`;
  const dir = newRunDir(label);
  const report = path.join(dir, 'report.json');
  const argv = [
    'pnpm',
    'exec',
    'playwright',
    'test',
    '--config',
    CONFIG,
    '--output',
    path.join(dir, 'results'),
    ...(plan.grep ? ['--grep', plan.grep] : []),
  ];
  const command = `JOURNEY_FILES="${plan.files.join(' ')}" ${argv.join(' ')}`;
  const startedAt = new Date().toISOString();
  io.say(`${PREFIX} drive: ${opts.id} ${plan.steps.map((n) => `#${n}`).join(' ')} in ${plan.files.join(', ')}`);
  const pw = await io.run(argv, { capture: false, env: { JOURNEY_FILES: plan.files.join(' '), JOURNEY_REPORT: report } });
  return finishRun(io, {
    dir,
    label,
    what: `journey ${opts.id}, steps ${plan.steps.map((n) => `#${n}`).join(' ')}`,
    command,
    startedAt,
    exit: pw.code,
    report,
    claim: d.claim,
  });
}

async function look(opts, io) {
  const d = await doctor(io, { quiet: true });
  if (!d.ok) return 1;
  const label = `look${opts.path.replace(/[/?#=&]+/g, '-')}`;
  const dir = newRunDir(label);
  const report = path.join(dir, 'report.json');
  const argv = ['pnpm', 'exec', 'playwright', 'test', '--config', LOOK_CONFIG, '--output', path.join(dir, 'results')];
  const env = {
    VERIFY_LOOK_PATH: opts.path,
    VERIFY_LOOK_OUT: dir,
    ...(opts.signUp ? { VERIFY_LOOK_SIGN_UP: '1' } : {}),
    ...(opts.selector ? { VERIFY_LOOK_SELECTOR: opts.selector } : {}),
    JOURNEY_REPORT: report,
  };
  const command = `${Object.entries(env)
    .filter(([k]) => k !== 'JOURNEY_REPORT')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')} ${argv.join(' ')}`;
  const startedAt = new Date().toISOString();
  io.say(
    `${PREFIX} look: ${opts.path}${opts.signUp ? ' as a new TEST person' : ' signed out'}${opts.selector ? `, element ${opts.selector}` : ''}`,
  );
  const pw = await io.run(argv, { capture: false, env });
  return finishRun(io, { dir, label, what: `page ${opts.path}`, command, startedAt, exit: pw.code, report, claim: d.claim });
}

function finishRun(io, { dir, label, what, command, startedAt, exit, report, claim }) {
  const tests = reportTests(readJson(report));
  const passed = exit === 0 && tests.length > 0 && tests.every((t) => t.status !== 'failed');
  const listFiles = (d) =>
    fs.existsSync(d)
      ? fs
          .readdirSync(d, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
      : [];
  const run = {
    dir,
    label,
    what,
    command,
    verdict: passed ? 'PASS' : 'FAIL',
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: git('status', '--porcelain', '--', 'services', 'packages', 'apps', 'pnpm-lock.yaml') !== '',
    slot: claim?.slot,
    customer: claim ? `http://127.0.0.1:${slotPorts(claim.slot).stack.customer}` : '?',
    startedAt,
    endedAt: new Date().toISOString(),
    exit,
    tests,
  };
  run.files = listFiles(dir)
    .filter((f) => f !== 'summary.md' && f !== 'summary.json')
    .sort();
  writeJson(path.join(dir, 'summary.json'), run);
  fs.writeFileSync(path.join(dir, 'summary.md'), summaryMarkdown(run));
  for (const t of tests) io.say(`${PREFIX} ${t.status.toUpperCase()} ${t.title}${t.error ? `: ${t.error}` : ''}`);
  if (!tests.length) io.say(`${PREFIX} FAIL: Playwright exited ${exit} and reported no test`);
  io.say(`${PREFIX} ${run.verdict}. Evidence: ${path.relative(CHECKOUT, dir)}/summary.md (kept after ${RUN} stop)`);
  return passed ? 0 : 1;
}

function evidence(io) {
  const runs = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).sort().reverse() : [];
  if (!runs.length) io.say(`${PREFIX} evidence: none yet in ${path.relative(CHECKOUT, RUNS_DIR)}`);
  for (const r of runs) {
    const s = readJson(path.join(RUNS_DIR, r, 'summary.json'));
    io.say(
      `${PREFIX} ${path.relative(CHECKOUT, path.join(RUNS_DIR, r))}/summary.md  ${s ? `${s.verdict} ${s.what}` : 'no summary (the run did not finish)'}`,
    );
  }
  return 0;
}

/**
 * What `stop` may do: 'none' (no stack runs here), 'stop' (verify launch started this very stack) or 'not-ours' (a stack
 * this checkout had running before launch, or another stack since): only 'stop' stops anything.
 */
export function stopDecision({ claim, launch, stack }) {
  if (!claim?.live) return 'none';
  return launch?.startedByUs && launch.stack && launch.stack === stack ? 'stop' : 'not-ours';
}

async function stop(io) {
  const claim = ourClaim();
  const rec = readJson(LAUNCH);
  const decision = stopDecision({ claim, launch: rec, stack: currentStackId(claim) });
  const kept = () => {
    const n = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).length : 0;
    io.say(`${PREFIX} stop: evidence kept: ${n} run(s) in ${path.relative(CHECKOUT, RUNS_DIR)} (${RUN} evidence lists them)`);
  };
  if (decision === 'none') {
    io.say(`${PREFIX} stop: this checkout has no running stack`);
    kept();
    return 0;
  }
  if (decision === 'not-ours') {
    io.say(
      `${PREFIX} stop: this checkout's stack on slot ${claim.slot} was not started by verify launch, so it is left running (pnpm local:stack:stop stops it, if it is yours to stop)`,
    );
    kept();
    return 1;
  }
  // The stack's own stop: only the processes its records name, checked by pid file and command line, then Postgres.
  const r = await io.run(['node', STACK, 'stop'], { capture: false });
  writeJson(LAUNCH, { ...rec, stoppedAt: new Date().toISOString() });
  kept();
  return r.code === 0 ? 0 : 1;
}

function map(opts, io) {
  const journeys = JSON.parse(fs.readFileSync(JOURNEYS_JSON, 'utf8'));
  const index = loadIndex();
  const unknown = opts.ids.filter((id) => !journeys.some((j) => j.id === id));
  if (unknown.length) {
    io.say(`${PREFIX} map: not in docs/roadmap/journeys.json: ${unknown.join(', ')}`);
    return 2;
  }
  fs.mkdirSync(FEATURES_DIR, { recursive: true });
  // Generated files only: README.md is the map's own contract and is never written here.
  for (const f of fs.readdirSync(FEATURES_DIR)) if (f !== 'README.md' && f.endsWith('.md')) fs.rmSync(path.join(FEATURES_DIR, f));
  for (const j of journeys) fs.writeFileSync(path.join(FEATURES_DIR, `${j.id}.md`), featureMarkdown(j, index.get(j.id)));
  fs.writeFileSync(path.join(FEATURES_DIR, 'index.md'), indexMarkdown(journeys, index));
  const rel = path.relative(CHECKOUT, FEATURES_DIR);
  io.say(`${PREFIX} map: ${journeys.length} feature files and index.md written in ${rel}`);
  for (const id of opts.ids) io.say(`${PREFIX} map: ${rel}/${id}.md`);
  return 0;
}

// ── The real outside world ──────────────────────────────────────────────────

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stdout.write(`${PREFIX} ${opts.error}\n`);
    process.exit(2);
  }
  const base = realIo();
  const io = {
    ...base,
    // `echo: false` keeps a read-only child's own output (status, plan) out of the doctor's lines.
    run: async (args, o) => {
      if (o.echo !== false) return base.run(args, o);
      const r = spawnSync(args[0], args.slice(1), { cwd: CHECKOUT, encoding: 'utf8', env: { ...process.env, ...o.env } });
      return { code: r.status ?? 1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, async () => {
      io.say(`${PREFIX} interrupted; nothing is stopped: ${RUN} stop`);
      await base.killChild();
      process.exit(130);
    });
  const run = {
    launch: () => launch(opts, io),
    doctor: async () => ((await doctor(io)).ok ? 0 : 1),
    drive: () => drive(opts, io),
    look: () => look(opts, io),
    map: () => map(opts, io),
    evidence: () => evidence(io),
    stop: () => stop(io),
  }[opts.cmd];
  process.exit(await run());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${PREFIX} run it as \`${RUN} <command>\`, a word of the stack's own start\n`);
  process.exit(2);
}

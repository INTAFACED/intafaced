#!/usr/bin/env node
/**
 * ONE COMMAND: run a journey on this checkout's own local test stack, start to stop.
 *
 *   pnpm local:stack journey <J-id> [<J-id> ...] [--only a,b] [--keep]
 *
 * A word of the stack's own start (local-test-stack.mjs `start journey`), so every check that guards a start guards it
 * too: the Mac's disk floor and any other hook that reads `pnpm local:stack` see it as the stack start it is. Run
 * directly, this file only says so.
 *
 * It takes a free slot and starts the stack (local-test-stack.mjs start, which claims the slot), readies it the way the
 * Real-app journeys workflow readies a shard (matching restarted, the TEST gates, the TEST market maker, the TEST
 * content), runs the journey files, waits for them, and prints one line per result: PASS, or FAIL with the failing
 * step's title and its first error line. Then it stops the stack it started, also when it is interrupted (Ctrl-C,
 * SIGTERM, SIGHUP). A stack this checkout already had running is reused and left running.
 *
 *   --only a,b   start only these services beside the journeys' core ones (the start's own --only); default: all, as CI
 *   --keep       leave the stack running after the run and print `Open:` with its address, to look at the pages live
 *
 * Every test that opens a page leaves a picture of its end (the journeys config's `screenshot: 'on'`), so `Pictures:`
 * names the folder to look at after the stack is stopped.
 *
 * Exit: 0 every test passed; 1 a test failed or the stack could not be readied; 2 a usage error; 3 no local stack (every
 * slot held, or the start refused): the line says what to do instead; 130 interrupted.
 *
 * It writes `.jr/run.json`: the tree of the checkout it ran (tracked and untracked files, as `git add -A` would commit
 * them), the files, when it started and its exit code (null until it ends). The Mac refuses a journey branch's first
 * push without a PASS of the tree pushed (a PreToolUse hook on the Mac).
 *
 * A local pass never counts as proof: the proof is the Real-app journeys run on the pull request's exact head.
 * Why one command (project-state #2561, rows 13 and 20): the words for doing this by hand were rewritten seven times in
 * four days, and 1 of 24 builders on 15 Nov ran a local journey it could trust.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT, localStackSlot, localStackState, slotClaims, slotPorts } from './local-test-facts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACK = path.join(HERE, 'local-test-stack.mjs');
export const JOURNEY_DIR = path.join(CHECKOUT, 'apps', 'customer', 'tests', 'real-app');
const CONFIG = path.join(JOURNEY_DIR, 'real-app.playwright.config.mjs');
const OUT = path.join(CHECKOUT, '.jr');

/** argv -> { ids, only, keep } or { error }. */
export function parseArgs(argv) {
  const ids = [];
  let only = null;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') keep = true;
    else if (a === '--only') {
      only = argv[++i];
      if (!only || only.startsWith('--')) return { error: '--only needs a comma list of services' };
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else ids.push(a);
  }
  if (!ids.length) return { error: 'name at least one journey: pnpm local:stack journey <J-id> [--only a,b] [--keep]' };
  return { ids, only, keep };
}

/** `J-bank-04`, `J-bank-04.pw.mjs` or a path -> the journey file's name, or { error }. */
export function journeyFiles(ids, dir = JOURNEY_DIR, exists = fs.existsSync) {
  const files = [];
  for (const id of ids) {
    const name = path.basename(id).replace(/(\.pw\.mjs)?$/, '.pw.mjs');
    if (!/^J-[a-z0-9-]+\.pw\.mjs$/.test(name) || !exists(path.join(dir, name)))
      return { error: `no journey file ${name} in apps/customer/tests/real-app` };
    files.push(name);
  }
  return { files };
}

/** The GitHub run that proves a journey, for a builder who cannot run it here. */
export const githubRun = (branch, files) => `gh workflow run real-app-journeys.yml --ref ${branch} -f journeys="${files.join(' ')}"`;

/** The start's output -> why it refused, in its own words, or null. */
export function refusal(text) {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('local-test-stack: '));
  return line ? line.replace(/^local-test-stack: /, '') : null;
}

/**
 * With --only the start reads every service left out as DOWN and exits 1; it is ready when each one asked for (and the
 * journeys' core, which the start refuses without) reads ok in its table.
 */
export function onlyReady(text, only) {
  const rows = new Map();
  for (const l of text.split('\n')) {
    const m = /^\s{2}(\S+)\s+\S+\s+\S+\s+(.+)$/.exec(l);
    if (m) rows.set(m[1].replace(/^svc-/, ''), m[2].trim());
  }
  const named = only.split(',').filter(Boolean);
  const bad = named.filter((n) => !/^(ok|absent)\b/.test(rows.get(n) ?? ''));
  return { ready: rows.size > 0 && bad.length === 0, bad };
}

/** The Playwright JSON report -> one line per test that did not pass, and the counts. */
export function readReport(report) {
  const out = { passed: 0, failed: [], skipped: 0 };
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1);
        if (t.status === 'skipped') out.skipped++;
        else if (t.status === 'expected') out.passed++;
        else {
          const msg = String(last?.error?.message ?? last?.errors?.[0]?.message ?? t.status ?? 'failed')
            .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '') // colour codes
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean);
          out.failed.push(`${spec.title}: ${msg}`);
        }
      }
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  for (const e of report.errors ?? []) out.failed.push(`run error: ${String(e.message ?? e).split('\n')[0]}`);
  return out;
}

/**
 * The whole run, with every outside effect passed in so the test can drive it: `run(argv, { env, capture })` starts a
 * child and resolves { code, text }, `say` prints a line, `ourStack()` says whether this checkout already has a live
 * stack, `slot()` reads this checkout's slot after the start, `readJson`, `branch`, `onSignal(fn)`.
 */
export async function journeyLocal(opts, io) {
  const { ids, only, keep } = opts;
  const found = journeyFiles(ids, io.dir, io.exists);
  if (found.error) {
    io.say(`local:stack journey: ${found.error}`);
    return 2;
  }
  const { files } = found;
  const instead = `Prove it on GitHub instead: ${githubRun(io.branch, files)}`;
  const hadStack = io.ourStack();
  let started = false;
  let stopping = null;
  // Set by a signal: the interrupted child's own failure then says nothing and the run ends 130, never 1 (proof run
  // 43782013433, case 3: the killed step's exit raced the signal's).
  let interrupted = null;
  const stop = async () => {
    if (!started || keep || hadStack) return;
    stopping ??= io.run(['node', STACK, 'stop'], { capture: false });
    await stopping;
  };
  io.onSignal(
    () =>
      (interrupted ??= (async () => {
        io.say('local:stack journey: interrupted; stopping what it started');
        await io.killChild();
        await stop();
        return 130;
      })()),
  );
  // What this run ran and how it ended, for the Mac's first-push check (a PreToolUse hook on the Mac): the first push
  // of a journey branch goes after a PASS (or a refused start) on the exact tree pushed. `code` stays null until the
  // run ends, so an interrupted or crashed run never reads as a pass.
  const ran = { tree: io.tree?.() ?? null, files, startedAt: io.now?.() ?? Date.now(), code: null };
  io.record?.(ran);
  const code = await body();
  if (!interrupted) io.record?.({ ...ran, code });
  return interrupted ? interrupted : code;

  async function body() {
    const say = (line) => interrupted || io.say(line); // an interrupted run says only that it was
    // 1. The stack: a free slot, started (or this checkout's own, already running).
    started = true;
    const start = await io.run(['node', STACK, 'start', ...(only ? ['--only', only] : [])], { capture: true });
    const why = refusal(start.text);
    const ready = start.code === 0 || (only && start.code === 1 && !why && onlyReady(start.text, only).ready);
    if (!ready) {
      if (why && /every slot is held/.test(why)) {
        started = false; // the start claimed nothing
        say(`local:stack journey: no free slot: every local stack slot is held. ${instead}`);
        return 3;
      }
      await stop();
      if (why) {
        say(`local:stack journey: the local start refused (${why}). ${instead}`);
        return 3;
      }
      const bad = only ? onlyReady(start.text, only).bad : [];
      say(`local:stack journey: the stack did not come up healthy${bad.length ? ` (${bad.join(', ')})` : ''}; see the table above`);
      return 1;
    }
    const slot = io.slot();
    const customer = `http://127.0.0.1:${slotPorts(slot).stack.customer}`;
    say(`local:stack journey: stack up on slot ${slot} (${customer})`);

    // 2. Readied as a Real-app journeys shard is (.github/workflows/real-app-journeys.yml, "Open the TEST markets ...").
    const step = async (argv, what) => {
      const r = await io.run(argv, { capture: false });
      if (r.code !== 0) throw new Error(`${what} exited ${r.code}`);
    };
    try {
      await step(['node', STACK, 'restart', 'matching'], 'restart matching');
      await step(['node', path.join(HERE, 'local-test-gates.mjs'), 'apply'], 'local-test-gates apply');
      const custody = await io.run(['node', STACK, 'custody'], { capture: true });
      await step(['node', path.join(HERE, 'local-test-market.mjs')], 'local-test-market');
      if (custody.text.trim() !== 'off') {
        await io.waitForTaker();
        await step(['node', path.join(HERE, 'local-test-market.mjs'), 'stop'], 'local-test-market stop');
        await step(['node', path.join(HERE, 'local-test-gates.mjs'), 'verify'], 'local-test-gates verify');
        const past = await io.run(['node', path.join(HERE, 'journey-market-past.mjs'), ...files], { capture: true });
        if (past.code !== 0 || past.text.trim() !== 'none')
          await step(['node', path.join(HERE, 'local-test-market.mjs'), 'history', '--markets', 'journeys'], 'TEST chart history');
        await step(['node', path.join(HERE, 'local-test-market.mjs')], 'local-test-market');
      } else await step(['node', path.join(HERE, 'local-test-gates.mjs'), 'verify'], 'local-test-gates verify');
      await io
        .run(['node', path.join(HERE, 'local-test-seed.mjs'), 'apply', '--state', io.state()], {
          capture: false,
          env: { LOCAL_TEST: '1' },
        })
        .then((r) => {
          if (r.code !== 0) throw new Error(`local-test-seed apply exited ${r.code}`);
        });
    } catch (e) {
      say(`local:stack journey: the stack could not be readied: ${e.message}`);
      await stop();
      return 1;
    }

    // 3. The journeys, waited for to the end.
    const report = path.join(io.out, 'report.json');
    const results = path.join(io.out, 'results');
    io.rm(report);
    const pw = await io.run(['pnpm', 'exec', 'playwright', 'test', '--config', CONFIG, '--output', results], {
      capture: false,
      env: { JOURNEY_FILES: files.join(' '), JOURNEY_REPORT: report },
    });
    let code = 1;
    const r = io.readJson(report);
    if (!r) say(`local:stack journey: FAIL: Playwright exited ${pw.code} and wrote no report`);
    else {
      const got = readReport(r);
      for (const f of got.failed) say(`local:stack journey: FAIL ${f}`);
      if (!got.failed.length && got.passed > 0 && pw.code === 0) {
        code = 0;
        say(`local:stack journey: PASS ${files.join(' ')}: ${got.passed} passed${got.skipped ? `, ${got.skipped} skipped` : ''}`);
      } else if (!got.failed.length) say(`local:stack journey: FAIL: ${got.passed} passed, Playwright exited ${pw.code}`);
    }
    say(`Pictures: ${results}   (each test's end, one per page)`);
    if (keep || hadStack) say(`Open: ${customer}   (the stack is left running; stop it: pnpm local:stack:stop)`);
    else say(`Open: ${customer} while it runs: add --keep to leave the stack up and look at the pages live`);
    say("A local pass never counts: the proof is the Real-app journeys run on the PR's exact head.");
    await stop();
    return code;
  }
}

// ── The real outside world ──────────────────────────────────────────────────

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stdout.write(`local:stack journey: ${opts.error}\n`);
    process.exit(2);
  }
  let child = null;
  let onSignal = null;
  const io = {
    dir: JOURNEY_DIR,
    exists: fs.existsSync,
    out: OUT,
    say: (l) => process.stdout.write(`${l}\n`),
    branch: gitBranch(),
    ourStack: () => slotClaims().some((c) => c.claim?.repo === CHECKOUT && c.live),
    slot: () => localStackSlot(),
    state: () => localStackStateFor(localStackSlot()),
    readJson: (f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    },
    rm: (f) => fs.rmSync(f, { force: true }),
    tree: () => workTree(),
    now: () => Date.now(),
    record: (ran) => {
      try {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'run.json'), `${JSON.stringify(ran)}\n`);
      } catch {}
    },
    // Its own process group, so a signal reaches the start's own re-run of itself on its slot, and Ctrl-C reaches it
    // only through this script (which then stops the stack).
    run: (argv, { capture, env = {} }) =>
      new Promise((resolve) => {
        let text = '';
        const c = spawn(argv[0], argv.slice(1), {
          cwd: CHECKOUT,
          env: { ...process.env, ...env },
          detached: true,
          stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
        });
        child = c;
        if (capture)
          for (const [from, to] of [
            [c.stdout, process.stdout],
            [c.stderr, process.stderr],
          ]) {
            from.setEncoding('utf8');
            from.on('data', (s) => {
              text += s;
              if (argv[2] !== 'custody' && !argv[1].endsWith('journey-market-past.mjs')) to.write(s);
            });
          }
        c.on('error', (e) => resolve({ code: 127, text: `${text}${e.message}` }));
        c.on('close', (code, sig) => {
          if (child === c) child = null;
          resolve({ code: code ?? (sig ? 128 : 1), text });
        });
      }),
    killChild: async () => {
      const c = child;
      if (!c?.pid) return;
      const gone = new Promise((r) => c.once('close', r));
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {}
      await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))]);
    },
    onSignal: (fn) => {
      onSignal = fn;
    },
    waitForTaker: async () => {
      const log = path.join(localStackStateFor(localStackSlot()), 'logs', 'market.log');
      for (let i = 0; i < 30; i++) {
        try {
          if (/taker (created|existing) \(test_taker\)/.test(fs.readFileSync(log, 'utf8'))) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
  };
  let signalled = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, async () => {
      if (signalled) return;
      signalled = true;
      process.exit((await onSignal?.()) ?? 130);
    });
  const code = await journeyLocal(opts, io);
  if (!signalled) process.exit(code); // else the signal's handler exits 130 once its stop ends
}

/** The tree `git add -A` would commit now, built in a copy of the index so the real one is untouched; null outside git. */
export function workTree(cwd = CHECKOUT, out = OUT) {
  const tmp = path.join(out, `index.${process.pid}`);
  try {
    const git = (args, env = {}) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.resolve(cwd, git(['rev-parse', '--git-path', 'index'])), tmp);
    git(['add', '-A'], { GIT_INDEX_FILE: tmp });
    return git(['write-tree'], { GIT_INDEX_FILE: tmp });
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function gitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: CHECKOUT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '<your branch>';
  }
}
/** The state folder of a slot (the start's own rule, local-test-facts.mjs localStackState). */
const localStackStateFor = (slot) => localStackState(undefined, { ...process.env, LOCAL_STACK_SLOT: String(slot) });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('local:stack journey: run it as `pnpm local:stack journey <J-id>`, a start of the stack like any other\n');
  process.exit(2);
}

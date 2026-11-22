#!/usr/bin/env node
/**
 * Which tooling files a journeys run or a unit-test job can reach, found from the repository itself and kept in
 * tooling/ci/tooling-reach.json, so the journeys planner (journey-touch.mjs) and its seal, which run the default
 * branch's copy without the pull request's tree, and the unit-test classifier (ci-affected.mjs) read one answer.
 * (Failure it prevents: on 22 Nov 2026 #9552, a change to tooling/design/RECIPE.md and a tooling script, ran 64 journey
 * files on 18 shards, about 23 minutes a push, and all sixteen unit-test shards: tooling/design was "a path no rule
 * places", and `tooling/` ran every unit test. 32 of the 179 pull requests merged in the 24 hours before touched no
 * product path, and each paid every unit test on every push.)
 *
 *   - `journeys`: the tooling files outside the folders journey-touch.mjs places by rule (tooling/scripts, ci, profiles,
 *     infra, lint) that the journeys run can reach. The roots: the journeys workflow and its actions, every app,
 *     service, package and crate file that is not a unit test (the journey files and their helpers, the apps' sources and
 *     build configs), the root build and deploy files, the stack's environment (tooling/profiles, tooling/infra), the CI
 *     files the journeys run uses (JOURNEY_CI) and the stack's shared setup, followed into every script under
 *     tooling/scripts they reach, as journey-touch.test.mjs proves FACTORY_SCRIPTS unreached (a script nothing there
 *     reaches, such as the runner of every tooling test, reaches no journey through what it names). Every tooling
 *     workspace package (tooling/pay-sim) counts whole.
 *   - `tests`: the tooling and .github files the unit-test jobs run or read: ci.yml and what its `changes`, `build` and
 *     `test-full` jobs execute (the classifier, the shard plan, the tooling tests that need the build), turbo.json's
 *     inputs, the root build files and the root `pnpm` scripts those run, followed through the files their code imports or
 *     names by path (not a workflow, a JOURNEY_CI file or a unit test it names only by file name); every tooling workspace
 *     package counts whole.
 *
 * A file is reached when a reached file's code (comments left out; a path split over `'a', 'b'` read as one) names it:
 * by its path from the root (`tooling/design/RECIPE.md`), by a folder or the start of a path holding it (`tooling/codemod`,
 * `tooling/codemod/**`, `` `tooling/codemod/${x}` ``: an entry ending `/` or `*`, which covers files added there later),
 * by a relative path from the file or the root (`../../tooling/vitest/setup.mjs`), or, from inside its own tooling
 * folder, by its file name; and a reached file is followed in turn. A file added outside every entry is unreached until
 * something reached names it, and that something is itself a change that keeps today's rules.
 *
 *   node tooling/ci/tooling-reach.mjs --write   (regenerate tooling-reach.json)
 *   node tooling/ci/tooling-reach.mjs --check   (fail when the file misses a reach the tree shows; tooling-reach.test.mjs)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JOURNEYS_WORKFLOW, isSharedSetup } from './journey-seal.mjs';
import { FACTORY_SCRIPTS, JOURNEY_CI, TOOLING_REACH_FILE, UNPLACED, joinedPaths, pathKind } from './journey-touch.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CI_WORKFLOW = '.github/workflows/ci.yml';
/** ci.yml's jobs that pick, build and run the unit tests. */
export const TEST_JOBS = ['changes', 'build', 'test-full'];

/** A file's text with its comment lines and trailing comments removed (a name in a comment reads nothing). */
export const codeOf = (f, text) =>
  /\.(m?[jt]sx?|cjs|mts|ya?ml|sh)$/.test(f) || !/\.[a-z]+$/i.test(f)
    ? text
        .split('\n')
        .map((l) =>
          l
            .replace(/^\s*(\/\/|\*|\/\*|#).*$/, '')
            .replace(/\s\/\/.*$/, '')
            .replace(/\s#\s.*$/, ''),
        )
        .join('\n')
    : text;

/** What is followed once reached: scripts, workflows and their config (a root is read whatever it is). */
const CODE = /\.(?:[cm]?[jt]sx?|sh|ya?ml)$/;
const unitTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !f.startsWith('apps/customer/tests/real-app/');
const PATH_CHARS = '[A-Za-z0-9_.@/-]';
const ABSOLUTE = new RegExp(`(?<![\\w.-])(?:tooling|\\.github)/${PATH_CHARS}*`, 'g');
const RELATIVE = new RegExp(`(?<![\\w./-])\\.{1,2}/${PATH_CHARS}*`, 'g');

/**
 * The paths `text` (the file `from`'s code) names under tooling/ or .github/, each a file (`files` holds it), a folder
 * (ending `/`) or the start of a path (ending `*`). The bare tops (`tooling/`, `.github/`) are prefixes of a list, never a
 * read of one file, and are left out; a split path joined past a file (`'a.mjs', 'b'`) names that file.
 */
const dirsOf = new WeakMap();
/** Every folder holding a file of `files`. */
const folders = (files) => {
  if (!dirsOf.has(files)) {
    const d = new Set();
    for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) d.add(f.slice(0, i));
    dirsOf.set(files, d);
  }
  return dirsOf.get(files);
};

export function namedPaths(from, text, files) {
  // As written, and with split paths joined: `['a.md', 'b.md']` joined would hide `a.md`, and `'tooling', 'x'` unjoined `tooling/x`.
  const plain = codeOf(from, text);
  const code = `${plain}\n${joinedPaths(plain)}`;
  const raw = [...code.matchAll(ABSOLUTE)].map((m) => m[0]);
  for (const m of code.matchAll(RELATIVE))
    for (const base of [dirname(from), '.']) {
      const to = normalize(join(base, m[0])).replace(/\\/g, '/');
      // A relative path is the file's own or the root's: only the reading that lands on a tracked path counts.
      if (/^(tooling|\.github)\/./.test(to) && (files.has(to) || folders(files).has(to))) raw.push(m[0].endsWith('/') ? `${to}/` : to);
    }
  const out = new Set();
  for (const r of raw) {
    let t = r.replace(/[.]+$/, '');
    if (t.includes('//') || /^(tooling|\.github)\/?$/.test(t)) continue;
    const parts = t.split('/');
    for (let i = 2; i < parts.length; i++)
      if (files.has(parts.slice(0, i).join('/'))) {
        t = parts.slice(0, i).join('/');
        break;
      }
    if (files.has(t)) out.add(t);
    else if (r.endsWith('/') || folders(files).has(t.replace(/\/+$/, ''))) out.add(`${t.replace(/\/+$/, '')}/`);
    else out.add(`${t}*`);
  }
  return out;
}

/** Whether `path` is covered by `entries` (a file, a folder ending `/`, a path start ending `*`). */
export function covers(entries, path) {
  for (const e of entries) {
    if (e.endsWith('/') || e.endsWith('*') ? String(path).startsWith(e.endsWith('*') ? e.slice(0, -1) : e) : e === path) return true;
  }
  return false;
}

/** The tooling workspace packages (`tooling/*` with a package.json), as folders. */
export function toolingPackages(files) {
  return [
    ...new Set([...files].filter((f) => /^tooling\/[^/]+\/package\.json$/.test(f)).map((f) => f.replace(/package\.json$/, ''))),
  ].sort();
}

/** ci.yml's text for `jobs` alone (two-space job keys under `jobs:`). */
export function jobsText(yml, jobs = TEST_JOBS) {
  const out = [];
  let keep = false;
  let inJobs = false;
  for (const line of String(yml).split('\n')) {
    if (/^\S/.test(line)) inJobs = /^jobs:\s*$/.test(line);
    const job = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (job) keep = jobs.includes(job[1]);
    else if (/^\S/.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.join('\n');
}

/**
 * Follow `roots` (repository paths, or `pnpm:<script>` for a root script) through every path their code names, and the
 * root `pnpm` scripts it runs. `read(f)` gives a file's text; `files` is every tracked file; `follows(f)` whether a
 * reached file's own code runs where the roots do (a root is always read). Returns the entries reached (files, folders,
 * path starts), each with the file that first named it.
 */
export function follow(roots, { files, read, pnpm = {}, follows = () => true, scripts = () => true }) {
  const tops = new Map();
  for (const f of files) {
    const m = /^tooling\/([^/]+)\//.exec(f);
    if (m) tops.set(m[1], [...(tops.get(m[1]) ?? []), f]);
  }
  const queue = [...roots];
  const scriptFrom = new Map();
  let current = null;
  const runScript = (n) => {
    for (const k of [`pre${n}`, n, `post${n}`])
      if (pnpm[k]) {
        if (!scriptFrom.has(`pnpm:${k}`)) scriptFrom.set(`pnpm:${k}`, current);
        queue.push(`pnpm:${k}`);
      }
  };
  const reached = new Map();
  const seen = new Set();
  // A file named by its own path runs or is read, so what its code names is followed; a folder or a path start is
  // kept as one entry, and the files under it are not followed (a listing reads names, and its files' own references
  // run only when one is named in turn). Only code is followed: a page or a record that names a path runs nothing.
  const reach = (e, from, how = 'path') => {
    if (reached.has(e)) return;
    reached.set(e, from);
    if (files.has(e) && CODE.test(e) && follows(e, how)) queue.push(e);
  };
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    current = f;
    let text = '';
    try {
      text = f.startsWith('pnpm:') ? pnpm[f.slice(5)] : read(f);
    } catch {
      text = '';
    }
    if (typeof text !== 'string' || !text) continue;
    const from = f.startsWith('pnpm:') ? 'package.json' : f === 'ci-jobs' ? CI_WORKFLOW : f;
    for (const e of namedPaths(from, text, files)) reach(e, f);
    // From inside a tooling folder no rule places, a sibling named by its file name (`join(here, 'report.mjs')`).
    const top = /^tooling\/([^/]+)\//.exec(from)?.[1];
    if (top && pathKind(from).why === UNPLACED) {
      const code = codeOf(from, text);
      for (const g of tops.get(top) ?? []) {
        const name = g.split('/').pop().replace(/[.]/g, '\\.');
        if (g !== from && new RegExp(`(?<![\\w.-])${name}(?![\\w-])`).test(code)) reach(g, f, 'name');
      }
    }
    if (scripts(f))
      for (const m of codeOf(from, text).matchAll(/\bpnpm(?:\s+-\S+)*(?:\s+run)?(?:\s+-\S+)*\s+([\w:.][\w:.-]*)/g)) runScript(m[1]);
  }
  return { reached, seen, scriptFrom };
}

const readRoot = (f) => readFileSync(join(ROOT, f), 'utf8');

/** Every tracked file of the checkout at `root`. */
export function trackedFiles(root = ROOT) {
  return new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean));
}

/**
 * Whether a reached file's code runs in a journeys run: not a unit test (a test runner runs it), another workflow, a CI check outside
 * JOURNEY_CI or a factory script (journey-touch.test.mjs proves the journeys run reaches neither).
 */
export const journeysRun = (f) =>
  !unitTest(f) &&
  !(f.startsWith('.github/workflows/') && f !== JOURNEYS_WORKFLOW) &&
  !(f.startsWith('tooling/ci/') && !JOURNEY_CI.includes(f)) &&
  !FACTORY_SCRIPTS.includes(f);

/** The journeys run's roots (see the header). */
export function journeyRoots(files) {
  return [...files].filter(
    (f) =>
      f === JOURNEYS_WORKFLOW ||
      f.startsWith('.github/actions/') ||
      (/^(apps|services|packages|crates)\//.test(f) && !unitTest(f)) ||
      /^(turbo\.json|package\.json|tsconfig[^/]*\.json|Cargo\.toml|docker-compose[^/]*\.ya?ml|Dockerfile[^/]*|\.env\.example)$/.test(f) ||
      /^tooling\/(profiles|infra)\//.test(f) ||
      JOURNEY_CI.includes(f) ||
      isSharedSetup(f),
  );
}

/**
 * The answer tooling-reach.json keeps, from the checkout at `root` (`read` and `files` for a test's own tree).
 * { journeys: [entries], tests: [entries] }, each sorted.
 */
export function scanReach({ files = trackedFiles(), read = readRoot } = {}) {
  let pnpm = {};
  try {
    pnpm = JSON.parse(read('package.json')).scripts ?? {};
  } catch {}
  const pkgs = toolingPackages(files);
  // The root package.json is a root by its install scripts and the scripts code runs, never by every script it lists.
  const { reached: jr } = follow(
    [
      ...journeyRoots(files).filter((f) => f !== 'package.json'),
      ...['preinstall', 'install', 'postinstall', 'prepare'].flatMap((n) => (pnpm[n] ? [`pnpm:${n}`] : [])),
    ],
    { files, read, pnpm, follows: journeysRun },
  );
  // A folder or path start stands for any file it starts: it is kept when such a file would be unplaced.
  const unplaced = (e) => e.startsWith('tooling/') && pathKind(/[*/]$/.test(e) ? `${e.replace(/[*]$/, '')}x` : e).why === UNPLACED;
  const journeys = [...new Set([...[...jr.keys()].filter(unplaced), ...pkgs])];
  let ci = '';
  try {
    ci = read(CI_WORKFLOW);
  } catch {}
  const testRoots = [
    'ci-jobs',
    ...[...files].filter((f) => /^(turbo\.json|tsconfig[^/]*\.json|\.npmrc)$/.test(f)),
    ...['preinstall', 'install', 'postinstall', 'prepare'].flatMap((n) => (pnpm[n] ? [`pnpm:${n}`] : [])),
  ];
  // Followed: what the test jobs run, the scripts they start and the code those import or name by path. Not a workflow
  // (ci.yml's test jobs are the root), not a unit test unless named by its path (the tooling tests that need the build),
  // and not a file the journeys run uses (JOURNEY_CI: a change there keeps today's tests, and its imports are JOURNEY_CI too).
  // A root `pnpm` script counts when a root or a script runs it, never when code merely prints its name.
  const { reached: tr } = follow(testRoots, {
    files,
    read: (f) => (f === 'ci-jobs' ? jobsText(ci) : read(f)),
    pnpm,
    follows: (f, how) => !f.startsWith('.github/workflows/') && !JOURNEY_CI.includes(f) && (!unitTest(f) || how === 'path'),
    scripts: (f) => testRoots.includes(f) || f.startsWith('pnpm:'),
  });
  // From the roots a folder or a path start counts (an action ci.yml uses, turbo's input globs); from code the jobs run,
  // only a file it names: there a folder is a listing or a prefix to match against (ci-affected.mjs lists tooling/ci for
  // baselines and matches paths against `tooling/lint/`), which reads no other file's content.
  const tests = [
    ...new Set([
      CI_WORKFLOW,
      ...[...tr.keys()].filter((e) => /^(tooling|\.github)\//.test(e) && (files.has(e) || testRoots.includes(tr.get(e)))),
      ...pkgs,
    ]),
  ];
  return { journeys: journeys.sort(), tests: tests.sort(), why: { journeys: jr, tests: tr } };
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which app, service and package folders hold a file whose code reads one of `paths` (a tooling, .github or agent-rule
 * file outside every package): it names the path, a folder holding it (`tooling/codemod`), or a relative path to
 * either, in any file of the folder (its tests, configs and scripts). Returns { <folder>: [paths] }, test-read-edges.json's
 * shape, for ci-affected.mjs: a change that reaches no journey runs these folders' tests and no others.
 */
export function readersOf(paths, { root = ROOT, files, read } = {}) {
  const list = [...new Set(paths)].filter(Boolean);
  if (!list.length) return {};
  const all = files ?? trackedFiles(root);
  const text = read ?? ((f) => readFileSync(join(root, f), 'utf8'));
  const pkgs = new Set([...all].filter((f) => /^(apps|services|packages)\/[^/]+\/package\.json$/.test(f)).map((f) => dirname(f)));
  // A folder counts when it is named as one (`tooling/codemod`, `tooling/codemod/`, `tooling/codemod/*`,
  // `` `tooling/codemod/${x}` ``), never as the start of another file's path (`tooling/ci/test-typecheck.mjs` reads no
  // other tooling/ci file).
  const wanted = list.map((p) => {
    const parts = p.split('/');
    const dirs = parts
      .slice(0, -1)
      .map((_, i) => parts.slice(0, i + 1).join('/'))
      .filter((d) => !/^(tooling|\.github)$/.test(d));
    const named = new RegExp(
      `(?<![\\w.-])(?:${esc(p)}(?![\\w-])|(?:${dirs.map(esc).join('|') || '(?!)'})(?=/?(?:['"\`\\s),\\]]|$|\\*|\\$\\{)))`,
    );
    return { p, dirs: new Set([p, ...dirs]), named, words: [...new Set(parts.filter((x) => !/^(tooling|\.github)$/.test(x)))] };
  });
  const out = {};
  for (const f of all) {
    const pkg = /^((?:apps|services|packages)\/[^/]+)\//.exec(f)?.[1];
    if (!pkg || !pkgs.has(pkg) || !/\.(?:[cm]?[jt]sx?|json|ya?ml|sh|mdx?|html|css)$/.test(f)) continue;
    let raw;
    try {
      raw = text(f);
    } catch {
      continue;
    }
    const maybe = wanted.filter((w) => w.words.some((x) => raw.includes(x)));
    if (!maybe.length) continue;
    const code = codeOf(f, raw);
    const both = `${code}\n${joinedPaths(code)}`;
    const rel = [...both.matchAll(RELATIVE)].map((m) =>
      normalize(join(dirname(f), m[0]))
        .replace(/\\/g, '/')
        .replace(/\/+$/, ''),
    );
    for (const w of maybe) {
      if (!w.named.test(both) && !rel.some((r) => w.dirs.has(r))) continue;
      out[pkg] ??= [];
      if (!out[pkg].includes(w.p)) out[pkg].push(w.p);
    }
  }
  return out;
}

/** The committed answer, or null when it can't be read. */
export function loadReach(file = join(ROOT, TOOLING_REACH_FILE)) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j.journeys) && Array.isArray(j.tests) ? j : null;
  } catch {
    return null;
  }
}

/** What the committed answer misses of a fresh scan: [{ list, entry, from }]. A stale extra entry costs runs, never a miss. */
export function missing(committed, fresh) {
  const out = [];
  for (const list of ['journeys', 'tests'])
    for (const e of fresh[list]) {
      const probe = e.endsWith('/') || e.endsWith('*') ? e.replace(/[*]$/, '') : e;
      if (!covers(committed?.[list] ?? [], probe)) out.push({ list, entry: e, from: fresh.why?.[list]?.get(e) ?? null });
    }
  return out;
}

export function render(fresh) {
  return `${JSON.stringify(
    {
      _comment:
        'Generated by `node tooling/ci/tooling-reach.mjs --write`; tooling-reach.test.mjs fails when the tree reaches a tooling file this misses. journeys: tooling files outside the folders journey-touch.mjs places by rule that the journeys run reaches. tests: tooling and .github files the unit-test jobs run or read. An entry ending / or * covers every path it starts.',
      journeys: fresh.journeys,
      tests: fresh.tests,
    },
    null,
    2,
  )}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const fresh = scanReach();
  if (process.argv.includes('--write')) {
    writeFileSync(join(ROOT, TOOLING_REACH_FILE), render(fresh));
    console.log(`${TOOLING_REACH_FILE}: ${fresh.journeys.length} journeys entries, ${fresh.tests.length} tests entries`);
  } else {
    const miss = missing(loadReach(), fresh);
    for (const m of miss) console.error(`${TOOLING_REACH_FILE} misses ${m.list}: ${m.entry} (reached from ${m.from})`);
    if (miss.length) {
      console.error('run: node tooling/ci/tooling-reach.mjs --write');
      process.exit(1);
    }
    console.log(`${TOOLING_REACH_FILE} holds every reach the tree shows`);
  }
}

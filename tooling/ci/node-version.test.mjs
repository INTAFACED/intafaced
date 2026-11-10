/**
 * One Node version for CI (U4, INTAFACED/project-state#1574): the root `.node-version` is the only place it is written.
 * Every `actions/setup-node` step in .github/workflows and .github/actions reads it with `node-version-file:
 * .node-version`, and no workflow hard-codes a `node-version:`, so CI cannot drift back to a mix (until 2026-11-10 the
 * CI ran Node 20 in 29 steps and 22 in the Dependency audit, while the shipped images ran 22). The version also has to
 * satisfy the root `engines.node` and match the major of every `FROM node:` image, so what CI tests is what ships.
 * Planted faults at the bottom prove each rule fails on the shape it forbids. Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const rel = (p) => relative(ROOT, p).split('\\').join('/');

function yamlFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...yamlFiles(full));
    else if (/\.ya?ml$/.test(e.name)) out.push(full);
  }
  return out.sort();
}

/**
 * The lines of the step whose `uses:` is line i, until the next step or a shallower line. The step's own keys sit
 * deeper than its `- ` (or at the `uses:` column when `uses:` is not the step's first key).
 */
function stepLines(lines, i, stepIndent) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const indent = l.length - l.trimStart().length;
    if (indent < stepIndent || (indent === stepIndent && l.trimStart().startsWith('-'))) break;
    out.push(l);
  }
  return out;
}

const NODE_VERSION_FILE = '/.node-version';

/** The events that start a workflow, from its `on:` key (a name, a list, or a block of keys). */
export function workflowTriggers(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l));
  if (at < 0) return new Set();
  const inline = lines[at]
    .replace(/#.*$/, '')
    .replace(/^['"]?on['"]?\s*:/, '')
    .trim();
  if (inline)
    return new Set(
      inline
        .replace(/[[\]]/g, '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
  const out = new Set();
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    const m = /^ {2}([A-Za-z_]+)\s*:/.exec(l) ?? /^ {2}-\s+([A-Za-z_]+)/.exec(l);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Events whose run holds a write token or secrets while it may read a pull request's code. */
const PRIVILEGED = ['pull_request_target', 'workflow_run'];
/** Jobs that check a pull request's head out at the root yet run main's rules (real-app-journeys `touch`: the seal's mode and target). */
const MAIN_RULES_JOBS = { 'real-app-journeys.yml': ['touch'] };
/** The one ref that checks main's rules out: the default branch, and nothing that may fall back to it. */
const MAIN_REF = /^['"]?\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}['"]?$/;
/** git commands that move or rewrite a checkout. */
const GIT_CHANGES = /\bgit\b[^\n;|&]*?\s(checkout|switch|reset|restore|fetch|pull|merge|rebase|cherry-pick|am|apply)\b/;
/** Commands and redirections that write files where the step runs (the root); a redirection to /dev/null or a runner file is not one. */
const ROOT_WRITES =
  /\b(cp|mv|ln|rsync|tar|unzip|curl|wget|patch|tee)\b|\bsed\s+-i|(?<!>)>>?(?!\s*(>|&|\/dev\/null|"?\$\{?(GITHUB_|RUNNER_TEMP)))/;
/** The touch job's fallback, allowed as written: it writes .base/.node-version only when main has none (the pull request that adds it). */
const MAIN_FALLBACK = '[ -f .base/.node-version ] || { mkdir -p .base && cp .node-version .base/.node-version; }';
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why a run step changes the checkout in folder dir, or null: a git command that moves it, or a write into it. */
function runChanges(run, dir) {
  if (run.trim().replace(/^'(.*)'$/s, '$1') === MAIN_FALLBACK) return null;
  const git = GIT_CHANGES.exec(run);
  if (git) return `git ${git[1]}`;
  if (dir === '.') return ROOT_WRITES.test(run) || /\.node-version\b/.test(run) ? 'writes into the root' : null;
  return new RegExp(`(^|[\\s'"=:(])${escape(dir)}(/|[\\s'";)]|$)`).test(run) ? `writes into ${dir}` : null;
}

/**
 * The faults in one workflow's text: a `node-version:` key anywhere (a hard-coded version, in a step or a matrix); an
 * `actions/setup-node` step without `node-version-file: .node-version` in its `with:` block; and one whose file is not
 * checked out yet in its job: `.node-version` needs an earlier checkout of the repo's root (actions/checkout without a
 * `path:`, or a plain `git checkout` in a run step), and `<dir>/.node-version` an earlier actions/checkout with
 * `path: <dir>`. In a workflow started by pull_request_target or workflow_run, and in a job of MAIN_RULES_JOBS, the
 * file must come from a checkout of main's rules: an actions/checkout whose `ref:` is the default branch (or, in those
 * two events only, names no ref, which checks out the base or default branch). A plain `git checkout` never counts there.
 * The ref must be exactly `${{ github.event.repository.default_branch }}`: one that merely mentions it (`head.sha ||
 * default_branch`) is the pull request's code. And no run step between that checkout and the setup-node step may change
 * it: a git command that moves or rewrites a checkout, or a write into its folder (the root, or e.g. `.base/`), except
 * the touch job's guarded fallback (MAIN_FALLBACK) as written.
 */
export function nodeVersionFaults(text, file = '<text>') {
  const faults = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(-\s+)?node-version\s*:/.test(line.replace(/#.*$/, ''))) {
      faults.push(`${file}:${i + 1} hard-codes a Node version (${line.trim()}); use node-version-file: .node-version`);
    }
  });
  const privileged = PRIVILEGED.some((t) => workflowTriggers(text).has(t));
  const mainRulesJobs = MAIN_RULES_JOBS[file.split('/').pop()] ?? [];
  let job = null;
  // the folders checked out so far in this job ('.' is the root) -> true (main's rules), false (not), or the
  // {line, why} of a later run step that changed main's checkout
  let checkedOut = new Map();
  lines.forEach((line, i) => {
    const jm = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jm) {
      job = jm[1]; // a new job
      checkedOut = new Map();
    }
    if (/\bgit checkout\b/.test(line.replace(/#.*$/, ''))) checkedOut.set('.', false);
    const rm = /^(\s*)(-\s+)?run:(.*)$/.exec(line);
    if (rm && (privileged || mainRulesJobs.includes(job))) {
      const run = [rm[3], ...stepLines(lines, i, rm[1].length)].join('\n');
      for (const [dir, main] of checkedOut) {
        const why = main === true && runChanges(run, dir);
        if (why) checkedOut.set(dir, { line: i + 1, why });
      }
    }
    const m = /^(\s*)(-\s+)?uses:\s*['"]?actions\/(checkout|setup-node)@/.exec(line);
    if (!m) return;
    const step = stepLines(lines, i, m[1].length);
    if (m[3] === 'checkout') {
      const path = step.map((l) => /^\s*path:\s*['"]?([^'"\s#]+)/.exec(l)?.[1]).find(Boolean);
      const ref = step.map((l) => /^\s*ref:\s*(.+?)\s*(#.*)?$/.exec(l)?.[1]).find(Boolean);
      const mainRules = ref === undefined ? privileged : MAIN_REF.test(ref);
      checkedOut.set(path === undefined ? '.' : path.replace(/\/$/, ''), mainRules);
      return;
    }
    const want = step.map((l) => /^\s*node-version-file:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/.exec(l)?.[1]).find(Boolean);
    const dir = want === '.node-version' ? '.' : want?.endsWith(NODE_VERSION_FILE) ? want.slice(0, -NODE_VERSION_FILE.length) : null;
    if (dir === null) faults.push(`${file}:${i + 1} runs actions/setup-node without node-version-file: .node-version`);
    else if (!checkedOut.has(dir))
      faults.push(`${file}:${i + 1} reads ${want} before its job checks out ${dir === '.' ? 'the repo root' : dir}`);
    else if (!(privileged || mainRulesJobs.includes(job))) return;
    else if (typeof checkedOut.get(dir) === 'object')
      faults.push(
        `${file}:${i + 1} reads ${want} after the run step at line ${checkedOut.get(dir).line} changes main's checkout of ${dir === '.' ? 'the repo root' : dir} (${checkedOut.get(dir).why}); read main's .node-version before any step changes it`,
      );
    else if (!checkedOut.get(dir))
      faults.push(
        `${file}:${i + 1} reads ${want} from a checkout that is not main's rules (${privileged ? 'a pull_request_target or workflow_run workflow' : `job ${job}`}); check main out (ref: default_branch) and read its .node-version`,
      );
  });
  return faults;
}

/** `.node-version`'s text as a version, or a fault: one line, a major or a full x.y.z, nothing else. */
export function readNodeVersion(text) {
  const v = text.trim();
  if (!/^\d+(\.\d+\.\d+)?$/.test(v) || text.trim().split('\n').length !== 1)
    return { fault: `.node-version must be one line like 22 or 22.11.0, got ${JSON.stringify(text)}` };
  return { version: v, major: Number(v.split('.')[0]) };
}

const FILES = [...yamlFiles(join(ROOT, '.github', 'workflows')), ...yamlFiles(join(ROOT, '.github', 'actions'))];

test('the root .node-version holds one version', () => {
  const r = readNodeVersion(readFileSync(join(ROOT, '.node-version'), 'utf8'));
  assert.equal(r.fault, undefined, r.fault);
});

test('every actions/setup-node step reads .node-version and no workflow hard-codes a Node version', () => {
  const steps = FILES.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => /uses:\s*['"]?actions\/setup-node@/.test(l)),
  );
  assert.ok(steps.length > 0, 'no actions/setup-node step found under .github: the walk is broken, NOTHING WAS CHECKED');
  const faults = FILES.flatMap((f) => nodeVersionFaults(readFileSync(f, 'utf8'), rel(f)));
  assert.deepEqual(faults, []);
});

test('the version satisfies engines.node and matches every node image the Dockerfiles ship', () => {
  const { major } = readNodeVersion(readFileSync(join(ROOT, '.node-version'), 'utf8'));
  const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node ?? '';
  const min = /^>=\s*(\d+)/.exec(engines);
  assert.ok(min, `root engines.node is ${JSON.stringify(engines)}; this test reads a >=N range`);
  assert.ok(major >= Number(min[1]), `.node-version ${major} is below engines.node ${engines}`);

  const dockerfiles = ['Dockerfile', 'apps/customer/Dockerfile'].filter((f) => existsSync(join(ROOT, f)));
  const images = dockerfiles.flatMap((f) =>
    [...readFileSync(join(ROOT, f), 'utf8').matchAll(/^FROM\s+node:(\d+)/gm)].map((m) => ({ f, major: Number(m[1]) })),
  );
  assert.ok(images.length > 0, 'no FROM node: image found: the read is broken, NOTHING WAS CHECKED');
  for (const img of images) assert.equal(img.major, major, `${img.f} ships node:${img.major}, CI tests ${major}`);
});

// ---- planted faults --------------------------------------------------------------------------------------------------

const GOOD = `jobs:
  a:
    steps:
      - uses: actions/checkout@abc # v5
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: node -v
`;

test('planted: the good shape passes', () => {
  assert.deepEqual(nodeVersionFaults(GOOD), []);
});

test('planted: a hard-coded node-version fails', () => {
  const bad = GOOD.replace('node-version-file: .node-version', 'node-version: 20');
  const faults = nodeVersionFaults(bad);
  assert.equal(faults.length, 2, faults.join('\n'));
  assert.match(faults[0], /hard-codes a Node version \(node-version: 20\)/);
  assert.match(faults[1], /without node-version-file/);
});

test('planted: both keys (a version beside the file) fails', () => {
  const bad = GOOD.replace('          cache: pnpm', '          cache: pnpm\n          node-version: 22');
  assert.match(nodeVersionFaults(bad).join('\n'), /hard-codes a Node version/);
});

test('planted: a setup-node step with no with: block fails', () => {
  const bad = GOOD.replace('        with:\n          node-version-file: .node-version\n          cache: pnpm\n', '');
  assert.match(nodeVersionFaults(bad).join('\n'), /without node-version-file/);
});

test('planted: a node-version-file under the NEXT step does not count for this one', () => {
  const bad = `steps:
      - uses: actions/setup-node@x
      - uses: other/action@y
        with:
          node-version-file: .node-version
`;
  assert.match(nodeVersionFaults(bad).join('\n'), /without node-version-file/);
});

test('planted: a node-version in a matrix fails', () => {
  const bad = `jobs:\n  a:\n    strategy:\n      matrix:\n        node-version: [20, 22]\n`;
  assert.match(nodeVersionFaults(bad).join('\n'), /hard-codes a Node version/);
});

test('planted: another file name or a bad .node-version fails', () => {
  assert.match(nodeVersionFaults(GOOD.replace('.node-version', '.nvmrc')).join('\n'), /without node-version-file/);
  assert.ok(readNodeVersion('lts/*\n').fault);
  assert.ok(readNodeVersion('v22\n').fault);
  assert.ok(readNodeVersion('22\n20\n').fault);
  assert.equal(readNodeVersion('22\n').major, 22);
  assert.equal(readNodeVersion('22.11.0\n').version, '22.11.0');
});

test('planted: setup-node before its job checks the repo out fails, and a checkout in another job does not count', () => {
  const before = GOOD.replace('      - uses: actions/checkout@abc # v5\n', '');
  assert.match(nodeVersionFaults(before).join('\n'), /reads \.node-version before its job checks out the repo root/);
  const otherJob = `jobs:
  a:
    steps:
      - uses: actions/checkout@abc
  b:
    steps:
      - uses: actions/setup-node@x
        with:
          node-version-file: .node-version
`;
  assert.match(nodeVersionFaults(otherJob).join('\n'), /before its job checks out the repo root/);
});

test('planted: a checkout into a folder needs that folder named, and a plain git checkout counts as the root', () => {
  const based = `jobs:
  a:
    steps:
      - uses: actions/checkout@abc
        with:
          path: .base
          sparse-checkout: tooling/ci
      - uses: actions/setup-node@x
        with:
          node-version-file: .node-version
`;
  assert.match(nodeVersionFaults(based).join('\n'), /before its job checks out the repo root/);
  const fixed = based.replace('node-version-file: .node-version', 'node-version-file: .base/.node-version');
  assert.deepEqual(nodeVersionFaults(fixed), []);
  const other = based.replace('node-version-file: .node-version', 'node-version-file: other/.node-version');
  assert.match(nodeVersionFaults(other).join('\n'), /reads other\/\.node-version before its job checks out other/);
  const plain = `jobs:
  a:
    steps:
      - run: |
          git init -q .
          git checkout -q --detach FETCH_HEAD
      - uses: actions/setup-node@x
        with:
          node-version-file: .node-version
`;
  assert.deepEqual(nodeVersionFaults(plain), []);
});

test("planted: a privileged workflow reads .node-version only from main's rules", () => {
  const real = readFileSync(join(ROOT, '.github', 'workflows', 'ci-review.yml'), 'utf8');
  assert.deepEqual(nodeVersionFaults(real, 'ci-review.yml'), []);
  const head = real.replaceAll('ref: ${{ github.event.repository.default_branch }}', 'ref: ${{ github.event.pull_request.head.sha }}');
  assert.notEqual(head, real, 'ci-review.yml no longer checks main out by ref: this planted fault plants nothing');
  assert.match(nodeVersionFaults(head, 'ci-review.yml').join('\n'), /from a checkout that is not main's rules \(a pull_request_target/);
  const target = `on:\n  pull_request_target:\n${GOOD}`;
  assert.deepEqual(nodeVersionFaults(target), [], 'no ref: in pull_request_target checks out the base branch');
  const plainGit = `on: [workflow_run]\njobs:\n  a:\n    steps:\n      - run: git checkout -q FETCH_HEAD\n      - uses: actions/setup-node@x\n        with:\n          node-version-file: .node-version\n`;
  assert.match(nodeVersionFaults(plainGit).join('\n'), /not main's rules/);
  assert.deepEqual([...workflowTriggers('on:\n  push:\n    branches: [main]\n  workflow_run:\njobs:\n')], ['push', 'workflow_run']);
  assert.deepEqual([...workflowTriggers('on: pull_request_target\n')], ['pull_request_target']);
});

test("planted: real-app-journeys' touch job reading the pull request's root .node-version fails", () => {
  const real = readFileSync(join(ROOT, '.github', 'workflows', 'real-app-journeys.yml'), 'utf8');
  assert.deepEqual(nodeVersionFaults(real, '.github/workflows/real-app-journeys.yml'), []);
  const touch = real.indexOf('\n  touch:\n');
  const at = real.indexOf('node-version-file: .base/.node-version', touch);
  assert.ok(touch > 0 && at > touch, 'the touch job no longer reads .base/.node-version: this planted fault plants nothing');
  const bad = real.slice(0, at) + 'node-version-file: .node-version' + real.slice(at + 'node-version-file: .base/.node-version'.length);
  assert.match(
    nodeVersionFaults(bad, '.github/workflows/real-app-journeys.yml').join('\n'),
    /reads \.node-version from a checkout that is not main's rules \(job touch\)/,
  );
});

test("planted: a ref that only mentions default_branch is not main's rules", () => {
  const real = readFileSync(join(ROOT, '.github', 'workflows', 'ci-review.yml'), 'utf8');
  const main = 'ref: ${{ github.event.repository.default_branch }}';
  assert.ok(real.includes(main), 'ci-review.yml no longer checks main out by ref: this planted fault plants nothing');
  const fallback = real.replaceAll(main, 'ref: ${{ github.event.pull_request.head.sha || github.event.repository.default_branch }}');
  assert.match(nodeVersionFaults(fallback, 'ci-review.yml').join('\n'), /from a checkout that is not main's rules \(a pull_request_target/);
  const spaced = real.replaceAll(main, "ref: '${{github.event.repository.default_branch}}'");
  assert.deepEqual(nodeVersionFaults(spaced, 'ci-review.yml'), [], 'spacing and quotes inside the expression still name main');
});

test("planted: a run step that moves main's checkout before setup-node fails", () => {
  const real = readFileSync(join(ROOT, '.github', 'workflows', 'ci-review.yml'), 'utf8');
  const setup = '      - uses: actions/setup-node@';
  assert.ok(real.includes(setup), 'ci-review.yml has no setup-node step: this planted fault plants nothing');
  const moved = real.replace(setup, `      - run: git fetch origin x; git reset --hard FETCH_HEAD\n${setup}`);
  assert.match(
    nodeVersionFaults(moved, 'ci-review.yml').join('\n'),
    /reads \.node-version after the run step at line \d+ changes main's checkout of the repo root \(git fetch\)/,
  );
  const written = real.replace(setup, `      - run: echo 20 > .node-version\n${setup}`);
  assert.match(nodeVersionFaults(written, 'ci-review.yml').join('\n'), /changes main's checkout of the repo root \(writes into the root\)/);
  const output = real.replace(setup, `      - run: echo ok=1 >> "$GITHUB_OUTPUT"\n${setup}`);
  assert.deepEqual(nodeVersionFaults(output, 'ci-review.yml'), [], 'a write to a runner file is not a write into the checkout');
});

test("planted: the touch job copying the pull request's .node-version into .base without the guard fails", () => {
  const real = readFileSync(join(ROOT, '.github', 'workflows', 'real-app-journeys.yml'), 'utf8');
  const guarded = "'[ -f .base/.node-version ] || { mkdir -p .base && cp .node-version .base/.node-version; }'";
  assert.ok(real.includes(guarded), "the touch job's guarded fallback changed: this planted fault plants nothing");
  const bad = real.replace(guarded, 'cp .node-version .base/.node-version');
  assert.match(
    nodeVersionFaults(bad, '.github/workflows/real-app-journeys.yml').join('\n'),
    /reads \.base\/\.node-version after the run step at line \d+ changes main's checkout of \.base \(writes into \.base\)/,
  );
});

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

/**
 * The faults in one workflow's text: a `node-version:` key anywhere (a hard-coded version, in a step or a matrix); an
 * `actions/setup-node` step without `node-version-file: .node-version` in its `with:` block; and one whose file is not
 * checked out yet in its job: `.node-version` needs an earlier checkout of the repo's root (actions/checkout without a
 * `path:`, or a plain `git checkout` in a run step), and `<dir>/.node-version` an earlier actions/checkout with
 * `path: <dir>`.
 */
export function nodeVersionFaults(text, file = '<text>') {
  const faults = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(-\s+)?node-version\s*:/.test(line.replace(/#.*$/, ''))) {
      faults.push(`${file}:${i + 1} hard-codes a Node version (${line.trim()}); use node-version-file: .node-version`);
    }
  });
  let checkedOut = new Set(); // the folders checked out so far in this job; '.' is the root
  lines.forEach((line, i) => {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) checkedOut = new Set(); // a new job
    if (/\bgit checkout\b/.test(line.replace(/#.*$/, ''))) checkedOut.add('.');
    const m = /^(\s*)(-\s+)?uses:\s*['"]?actions\/(checkout|setup-node)@/.exec(line);
    if (!m) return;
    const step = stepLines(lines, i, m[1].length);
    if (m[3] === 'checkout') {
      const path = step.map((l) => /^\s*path:\s*['"]?([^'"\s#]+)/.exec(l)?.[1]).find(Boolean);
      checkedOut.add(path === undefined ? '.' : path.replace(/\/$/, ''));
      return;
    }
    const want = step.map((l) => /^\s*node-version-file:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/.exec(l)?.[1]).find(Boolean);
    const dir = want === '.node-version' ? '.' : want?.endsWith(NODE_VERSION_FILE) ? want.slice(0, -NODE_VERSION_FILE.length) : null;
    if (dir === null) faults.push(`${file}:${i + 1} runs actions/setup-node without node-version-file: .node-version`);
    else if (!checkedOut.has(dir))
      faults.push(`${file}:${i + 1} reads ${want} before its job checks out ${dir === '.' ? 'the repo root' : dir}`);
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

#!/usr/bin/env node
/**
 * Codemod: replace local copies of `isRecord` and `sleep` with the shared ones in `@intafaced/contracts`.
 *
 *   node tooling/lint/garden-shared-helpers-codemod.mjs            dry run: counts and the plan, writes nothing
 *   node tooling/lint/garden-shared-helpers-codemod.mjs --write    rewrites the files it would change
 *   node tooling/lint/garden-shared-helpers-codemod.mjs --only isRecord|sleep
 *
 * A copy is replaced only when its body means exactly what the shared one means:
 *   isRecord  a non-null, non-array object (`Boolean(v && typeof v === 'object' && !Array.isArray(v))` and its three
 *             spellings). A copy without the array check is looser and is left alone, under its own name.
 *   sleep     `(ms) => new Promise((resolve) => setTimeout(resolve, ms))` under the names sleep, delay, wait or pause.
 *             A copy that takes no argument, waits a fixed time or wraps `act` is left alone.
 * Only module-level, unexported declarations are replaced.
 *
 * Skipped, and listed: every file an open pull request touches (read from `gh`, or from `--open-files <file>`), the
 * journey tests `apps/customer/tests/real-app/*.pw.mjs` and every file they import, anything under `tooling/`, the
 * contracts package itself, and a package or app that does not depend on `@intafaced/contracts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GROUPS = ['apps', 'packages', 'services'];
const SOURCE = /\.(ts|tsx|mts)$/;

const ID = '([A-Za-z_$][\\w$]*)';
const TS_PARAM = (n) => `${n}\\s*(?::\\s*unknown)?`;
// The four spellings of "a non-null, non-array object", with any parameter name.
const RECORD_BODIES = [
  (v) => `Boolean\\(\\s*${v}\\s*&&\\s*typeof\\s+${v}\\s*===\\s*'object'\\s*&&\\s*!Array\\.isArray\\(${v}\\)\\s*\\)`,
  (v) => `!!${v}\\s*&&\\s*typeof\\s+${v}\\s*===\\s*'object'\\s*&&\\s*!Array\\.isArray\\(${v}\\)`,
  (v) => `typeof\\s+${v}\\s*===\\s*'object'\\s*&&\\s*${v}\\s*!==\\s*null\\s*&&\\s*!Array\\.isArray\\(${v}\\)`,
  (v) => `${v}\\s*!==\\s*null\\s*&&\\s*typeof\\s+${v}\\s*===\\s*'object'\\s*&&\\s*!Array\\.isArray\\(${v}\\)`,
];
const GUARD_RET = (v) => `(?::\\s*${v}\\s+is\\s+Record<string,\\s*unknown>)?`;

function recordPatterns() {
  const out = [];
  for (const body of RECORD_BODIES) {
    const b = body('\\1');
    // function isRecord(v: unknown): v is Record<string, unknown> { return BODY; }
    out.push(
      new RegExp(`^function isRecord\\(${TS_PARAM(ID)}\\)${GUARD_RET('\\1')}\\s*\\{\\s*return\\s+${b}\\s*;?\\s*\\}[ \\t]*\\n?`, 'm'),
    );
    // const isRecord = (v: unknown): v is Record<string, unknown> => BODY;
    out.push(new RegExp(`^const isRecord\\s*=\\s*\\(${TS_PARAM(ID)}\\)${GUARD_RET('\\1')}\\s*=>\\s*${b}\\s*;[ \\t]*\\n?`, 'm'));
  }
  return out;
}
const RECORD_PATTERNS = recordPatterns();
const ANY_RECORD_DECL = /^(export\s+)?(?:function\s+isRecord\b|const\s+isRecord\s*=)/m;

const SLEEP_NAMES = ['sleep', 'delay', 'wait', 'pause'];
const SLEEP_PATTERN = new RegExp(
  `^const (${SLEEP_NAMES.join('|')})\\s*=\\s*\\(${ID}(?:\\s*:\\s*number)?\\)(?:\\s*:\\s*Promise<void>)?\\s*=>\\s*` +
    `new Promise(?:<void>)?\\(\\(?${ID}\\)?\\s*=>\\s*setTimeout\\(\\3,\\s*\\2\\)\\)\\s*;[ \\t]*\\n?`,
  'm',
);
const SLEEP_FN_PATTERN = new RegExp(
  `^function (${SLEEP_NAMES.join('|')})\\(${ID}(?:\\s*:\\s*number)?\\)(?:\\s*:\\s*Promise<void>)?\\s*\\{\\s*return\\s+` +
    `new Promise(?:<void>)?\\(\\(?${ID}\\)?\\s*=>\\s*setTimeout\\(\\3,\\s*\\2\\)\\)\\s*;?\\s*\\}[ \\t]*\\n?`,
  'm',
);

/** Adds `name` (as `local` when it differs) to the file's import from `spec`, or adds that import after the last one. */
export function addImport(text, spec, name, local = name) {
  const member = local === name ? name : `${name} as ${local}`;
  const existing = new RegExp(`^import \\{([^}]*)\\} from '${spec.replace(/[/.]/g, '\\$&')}';`, 'm');
  const m = text.match(existing);
  if (m) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.includes(member)) return text;
    return text.replace(existing, `import { ${[...names, member].join(', ')} } from '${spec}';`);
  }
  const imports = [...text.matchAll(/^import\s[\s\S]*?from\s+'[^']+';[ \t]*\n/gm)];
  const line = `import { ${member} } from '${spec}';\n`;
  if (imports.length === 0) return line + text;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return text.slice(0, at) + line + text.slice(at);
}

/**
 * Rewrites one file's text. Returns `{ text, changed: [{ helper, as }], kept: [{ helper, reason }] }`.
 * Pure: no file system.
 */
export function rewrite(text, only = null) {
  let out = text;
  const changed = [];
  const kept = [];
  if (!only || only === 'isRecord') {
    if (ANY_RECORD_DECL.test(out)) {
      const exported = /^export\s+(?:function\s+isRecord\b|const\s+isRecord\s*=)/m.test(out);
      const pattern = RECORD_PATTERNS.find((p) => p.test(out));
      if (exported) kept.push({ helper: 'isRecord', reason: 'exported' });
      else if (!pattern) kept.push({ helper: 'isRecord', reason: 'body differs from the shared one' });
      else {
        out = addImport(out.replace(pattern, ''), '@intafaced/contracts/guards', 'isRecord');
        changed.push({ helper: 'isRecord', as: 'isRecord' });
      }
    }
  }
  if (!only || only === 'sleep') {
    for (const pattern of [SLEEP_PATTERN, SLEEP_FN_PATTERN]) {
      const m = out.match(pattern);
      if (!m) continue;
      const local = m[1];
      out = addImport(out.replace(pattern, ''), '@intafaced/contracts/sleep', 'sleep', local);
      changed.push({ helper: 'sleep', as: local });
    }
  }
  out = out.replace(/\n{3,}/g, '\n\n');
  return { text: out, changed, kept };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'vendor' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function packageOf(rel) {
  const [group, name] = rel.split('/');
  return GROUPS.includes(group) ? `${group}/${name}` : null;
}

function dependsOnContracts(pkgDir) {
  const p = join(ROOT, pkgDir, 'package.json');
  if (!existsSync(p)) return false;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Boolean({ ...j.dependencies, ...j.devDependencies }['@intafaced/contracts']);
}

/** Every file the journey tests import, followed through relative imports. */
export function journeyClosure(root = ROOT) {
  const dir = join(root, 'apps/customer/tests/real-app');
  const seen = new Set();
  if (!existsSync(dir)) return seen;
  const queue = readdirSync(dir)
    .filter((f) => f.endsWith('.pw.mjs'))
    .map((f) => join(dir, f));
  while (queue.length) {
    const f = queue.pop();
    const rel = relative(root, f);
    if (seen.has(rel) || !existsSync(f)) continue;
    seen.add(rel);
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)'(\.{1,2}\/[^']+)'/g)) {
      const base = resolve(dirname(f), m[1]);
      const candidates = [
        base,
        ...['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.mjs'].map((x) => base + x),
        base.replace(/\.js$/, '.ts'),
      ];
      const hit = candidates.find((c) => SOURCE_OR_JS.test(c) && existsSync(c) && statSync(c).isFile());
      if (hit) queue.push(hit);
    }
  }
  return seen;
}
const SOURCE_OR_JS = /\.(ts|tsx|mts|mjs|js)$/;

function openPrFiles(path) {
  if (path) return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '-R', 'INTAFACED/intafaced', '--state', 'open', '--limit', '500', '--json', 'number,files'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return new Set(JSON.parse(raw).flatMap((pr) => (pr.files ?? []).map((f) => f.path)));
}

export function plan({ root = ROOT, only = null, open = new Set() } = {}) {
  const journeys = journeyClosure(root);
  const result = { change: [], skip: [], kept: [] };
  for (const group of GROUPS) {
    for (const f of walk(join(root, group))) {
      if (!SOURCE.test(f)) continue;
      const rel = relative(root, f);
      const text = readFileSync(f, 'utf8');
      const r = rewrite(text, only);
      for (const k of r.kept) result.kept.push({ file: rel, ...k });
      if (r.changed.length === 0) continue;
      const pkg = packageOf(rel);
      let why = null;
      if (open.has(rel)) why = 'an open pull request touches it';
      else if (journeys.has(rel)) why = 'a journey test imports it';
      else if (pkg === 'packages/contracts') why = 'the contracts package itself';
      else if (!pkg || !dependsOnContracts(pkg)) why = `${pkg} does not depend on @intafaced/contracts`;
      if (why) result.skip.push({ file: rel, why, helpers: r.changed });
      else result.change.push({ file: rel, helpers: r.changed, text: r.text });
    }
  }
  return result;
}

function main(argv) {
  const write = argv.includes('--write');
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const openPath = argv.includes('--open-files') ? argv[argv.indexOf('--open-files') + 1] : null;
  const open = openPrFiles(openPath);
  const p = plan({ only, open });
  const sites = (list) => list.reduce((n, x) => n + x.helpers.length, 0);
  console.log(`would change: ${sites(p.change)} copies in ${p.change.length} files`);
  console.log(`skipped:      ${sites(p.skip)} copies in ${p.skip.length} files`);
  console.log(`kept:         ${p.kept.length} copies whose body or export differs`);
  for (const s of p.skip) console.log(`  skip ${s.file}: ${s.why}`);
  for (const k of p.kept) console.log(`  keep ${k.file}: ${k.helper}, ${k.reason}`);
  if (!write) {
    for (const c of p.change)
      console.log(`  change ${c.file}: ${c.helpers.map((h) => (h.as === h.helper ? h.helper : `${h.helper} as ${h.as}`)).join(', ')}`);
    return;
  }
  for (const c of p.change) writeFileSync(join(ROOT, c.file), c.text);
  if (p.change.length)
    execFileSync('pnpm', ['exec', 'prettier', '--write', ...p.change.map((c) => c.file)], { cwd: ROOT, stdio: 'ignore' });
  console.log(`wrote ${p.change.length} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

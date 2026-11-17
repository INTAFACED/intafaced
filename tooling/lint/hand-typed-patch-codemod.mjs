#!/usr/bin/env node
/**
 * Codemod for garden/no-hand-typed-patch: a prototype patch's hand-written member type becomes the class's own,
 * `open: (input: OpenPositionInput) => Promise<unknown>` → `open: PositionService['open']`, as the rule asks.
 *
 *   node tooling/lint/hand-typed-patch-codemod.mjs <package dir>...            dry run: what it would rewrite
 *   node tooling/lint/hand-typed-patch-codemod.mjs <package dir>... --write    rewrites what tsc accepts
 *
 * A type is erased when TypeScript compiles, so the rewrite cannot change what runs. What it changes is what the
 * compiler checks: the patch now meets the real method's arguments and return. So each package is type-checked with
 * its test tsconfig (tsconfig.test.json, else tsconfig.json) before and after, and a member whose class type tsc
 * rejects (the member is not on the class, or the patch calls or replaces it in a way the real signature refuses, the
 * mismatch the rule exists to show) is put back as it was and listed: each is a judgement. An error that names no
 * rewritten member puts back every member of its file. The loop starts from the original files each round with fewer
 * members, until tsc reports nothing new. Rewritten files are formatted with prettier. TradeService patches are left:
 * the rule names TradeServiceInternal for them, which a boundary test keeps inside spot/trade-service, so each is a
 * judgement. tsc is the only check it runs; the package's tests prove the rest in CI. Needs the dependencies' dist/
 * built. Deleted once garden/no-hand-typed-patch is at zero on main (#8649).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = (name) => join(ROOT, 'node_modules', '.bin', name);
const RULE = 'garden(no-hand-typed-patch)';

/** `file(line,col): error TSnnnn: message` lines → [{ file, line, col, code, message }], file relative to the package. */
export function parseTsc(out) {
  const errors = [];
  for (const line of out.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/u.exec(line.trim());
    if (m) errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
  }
  return errors;
}
const keyOf = (e) => `${e.file}|${e.code}|${e.message}`;
/** Errors in `after` beyond those in `before`, counted by file, code and message (a line can move, a count cannot). */
export function newErrors(before, after) {
  const left = new Map();
  for (const e of before) left.set(keyOf(e), (left.get(keyOf(e)) ?? 0) + 1);
  return after.filter((e) => {
    const n = left.get(keyOf(e)) ?? 0;
    if (n > 0) left.set(keyOf(e), n - 1);
    return n === 0;
  });
}

const tsconfigOf = (pkg) => ['tsconfig.test.json', 'tsconfig.json'].find((n) => existsSync(join(pkg, n))) ?? null;
const tsc = (pkg, config) =>
  parseTsc(
    (({ stdout, stderr }) => stdout + stderr)(
      spawnSync(BIN('tsc'), ['-p', config, '--noEmit', '--pretty', 'false'], { cwd: pkg, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
    ),
  );

function oxlint(config, paths, extra = [], env = process.env) {
  const run = spawnSync(BIN('oxlint'), ['-c', config, '--format', 'json', ...extra, ...paths], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(run.stdout).diagnostics;
}

function runPackage(pkgArg, write, dir) {
  const pkg = resolve(ROOT, pkgArg);
  const name = relative(ROOT, pkg);
  const config = tsconfigOf(pkg);
  if (!config) return { name, refused: 'no tsconfig' };
  const found = oxlint(join(ROOT, '.oxlintrc.json'), [pkg]).filter((d) => d.code === RULE);
  let targets = {};
  for (const d of found) {
    const m = /^'([^']+)'/u.exec(d.message);
    if (m) (targets[resolve(ROOT, d.filename)] ??= []).push({ name: m[1], line: d.labels?.[0]?.span?.line });
  }
  const files = Object.keys(targets);
  const originals = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const pluginConfig = join(dir, 'oxlintrc.json');
  writeFileSync(
    pluginConfig,
    JSON.stringify({
      plugins: [],
      categories: { correctness: 'off' },
      jsPlugins: [join(ROOT, 'tooling/lint/hand-typed-patch-codemod-plugin.js')],
      rules: { 'hand-patch-codemod/fix': 'error' },
    }),
  );
  const env = { ...process.env, HAND_PATCH_TARGETS: join(dir, 'targets.json') };
  const apply = () => {
    for (const [f, text] of originals) writeFileSync(f, text);
    writeFileSync(join(dir, 'targets.json'), JSON.stringify(targets));
    const live = Object.keys(targets).filter((f) => targets[f].length);
    const planned = live.length ? oxlint(pluginConfig, live, [], env) : [];
    if (write && live.length) oxlint(pluginConfig, live, ['--fix'], env);
    return planned;
  };
  if (!write) {
    const planned = apply();
    return { name, findings: found.length, planned: planned.length };
  }
  const baseline = tsc(pkg, config);
  if (baseline.some((e) => e.code === 'TS2307'))
    return { name, refused: 'baseline cannot resolve a module (TS2307): build the dependencies first' };
  const putBack = [];
  for (let round = 1; round <= 12; round++) {
    apply();
    const fresh = newErrors(baseline, tsc(pkg, config));
    if (!fresh.length) break;
    let dropped = 0;
    for (const e of fresh) {
      const f = resolve(pkg, e.file);
      const list = targets[f] ?? [];
      if (!list.length && originals.has(f)) continue; // its members were all put back earlier this round
      if (!list.length) {
        for (const [g, text] of originals) writeFileSync(g, text);
        return { name, refused: `a new type error outside the rewritten files: ${e.file}(${e.line}) ${e.code} ${e.message}`, putBack };
      }
      const line = readFileSync(f, 'utf8').split('\n')[e.line - 1] ?? '';
      const named = list.filter((t) => new RegExp(`\\b${t.name}\\b`, 'u').test(line) || e.message.includes(`'${t.name}'`));
      const drop = named.length ? named : list;
      for (const t of drop) putBack.push(`${relative(ROOT, f)} '${t.name}': ${e.code} ${e.message.slice(0, 160)}`);
      targets[f] = list.filter((t) => !drop.includes(t));
      dropped += drop.length;
    }
    if (!dropped || round === 12) {
      for (const [g, text] of originals) writeFileSync(g, text);
      return { name, refused: `type errors left after ${round} round(s); every file put back`, putBack };
    }
  }
  const changed = Object.keys(targets).filter((f) => readFileSync(f, 'utf8') !== originals.get(f));
  if (changed.length) spawnSync(BIN('prettier'), ['--write', '--log-level', 'warn', ...changed], { cwd: ROOT, stdio: 'inherit' });
  const kept = Object.values(targets).reduce((n, l) => n + l.length, 0);
  return { name, findings: found.length, kept, files: changed.length, putBack };
}

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const pkgs = argv.filter((a) => !a.startsWith('--'));
  if (!pkgs.length) {
    console.error('usage: hand-typed-patch-codemod.mjs <package dir>... [--write]');
    return 2;
  }
  let failed = 0;
  for (const p of pkgs) {
    const dir = mkdtempSync(join(tmpdir(), 'hand-patch-codemod-'));
    try {
      const r = runPackage(p, write, dir);
      if (r.refused) {
        failed++;
        console.log(`✖ ${r.name}: ${r.refused}`);
      } else if (!write) console.log(`· ${r.name}: ${r.findings} finding(s), ${r.planned} member(s) planned`);
      else
        console.log(
          `✓ ${r.name}: ${r.findings} finding(s), ${r.kept} member(s) rewritten in ${r.files} file(s), ${r.putBack.length} put back`,
        );
      for (const s of r.putBack ?? []) console.log(`    put back: ${s}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

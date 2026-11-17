#!/usr/bin/env node
/**
 * Codemod for garden/no-double-cast in test files: `fake as unknown as T` becomes `fake as T`, the shape the rule's own
 * message names for a partial test fake, wherever the compiler accepts the single cast.
 *
 *   node tooling/lint/garden-double-cast-codemod.mjs <package dir>...            dry run: what it would change
 *   node tooling/lint/garden-double-cast-codemod.mjs <package dir>... --write    rewrites, keeping only what tsc accepts
 *
 * Why it keeps behaviour: a type assertion is erased when TypeScript is compiled, so `x as unknown as T` and `x as T`
 * emit the same JavaScript. The only thing that can change is what the type checker says, so each package is checked
 * with the tsconfig its test typecheck uses (tsconfig.test.json, else tsconfig.json) before and after: a site whose
 * single cast tsc rejects (TS2352, the types do not overlap) is put back as it was and listed, since its fake is a wrong
 * type on purpose or has drifted from the real one, which is a judgement. A new error anywhere else in a rewritten file
 * puts the whole file back. The loop ends when the package has no type error it did not have before.
 *
 * Only test files (the rule plugin's TEST_FILE) the package's tsconfig includes are touched: a file tsc does not check
 * could not prove its cast. The dependencies' dist/ must be built first (pnpm turbo run build --filter='./packages/*'),
 * and a package whose baseline cannot resolve a module (TS2307) is refused, since unresolved types accept any cast.
 * Rewritten files are formatted with prettier. Deleted once garden/no-double-cast is at zero on main (#8649).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = (name) => join(ROOT, 'node_modules', '.bin', name);
export const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
const RULE = 'garden(no-double-cast)';
const DOUBLE = /\bas\s+unknown\s+as\b/gu;

/**
 * The rewrite of one finding: `bytes` is the file as UTF-8 (oxlint's spans count bytes), `offset`/`length` the span of
 * the outer `as` expression. Returns { start, end, text } in bytes: the `as unknown as` that joins the inner expression
 * to the outer type, and `as` to put there, or null with why it was left.
 */
export function planSite(bytes, offset, length) {
  const span = bytes.subarray(offset, offset + length).toString('utf8');
  const matches = [...span.matchAll(DOUBLE)];
  if (!matches.length) return { skip: 'no `as unknown as` in the span' };
  const last = matches.at(-1);
  if (/\n/u.test(last[0])) return { skip: 'the cast spans lines' };
  // The outer cast's own `as unknown as` is the last one; anything after it is the target type.
  const before = Buffer.byteLength(span.slice(0, last.index), 'utf8');
  const start = offset + before;
  return { start, end: start + Buffer.byteLength(last[0], 'utf8'), text: 'as' };
}

/** Applies plans (byte ranges) to a file's bytes, last first. */
export function apply(bytes, plans) {
  let out = bytes;
  for (const p of [...plans].sort((a, b) => b.start - a.start)) {
    out = Buffer.concat([out.subarray(0, p.start), Buffer.from(p.text, 'utf8'), out.subarray(p.end)]);
  }
  return out;
}

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
  const fresh = [];
  for (const e of after) {
    const n = left.get(keyOf(e)) ?? 0;
    if (n > 0) left.set(keyOf(e), n - 1);
    else fresh.push(e);
  }
  return fresh;
}

function tsconfigOf(pkg) {
  for (const name of ['tsconfig.test.json', 'tsconfig.json']) if (existsSync(join(pkg, name))) return name;
  return null;
}

function tsc(pkg, config, extra = []) {
  const run = spawnSync(BIN('tsc'), ['-p', config, '--noEmit', '--pretty', 'false', ...extra], {
    cwd: pkg,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return run.stdout + run.stderr;
}

function findings(pkg) {
  const run = spawnSync(BIN('oxlint'), ['-c', join(ROOT, '.oxlintrc.json'), '--format', 'json', relative(ROOT, pkg)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(run.stdout).diagnostics.filter((d) => d.code === RULE);
}

/** Line and 1-based column (UTF-16, as tsc counts) of a byte offset. */
function position(bytes, offset) {
  const before = bytes.subarray(0, offset).toString('utf8');
  const lines = before.split('\n');
  return { line: lines.length, col: lines.at(-1).length + 1 };
}

function runPackage(pkgArg, write) {
  const pkg = resolve(ROOT, pkgArg);
  const name = relative(ROOT, pkg);
  const config = tsconfigOf(pkg);
  if (!config) return { name, refused: 'no tsconfig' };
  const checked = new Set(
    tsc(pkg, config, ['--listFilesOnly'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((f) => resolve(pkg, f)),
  );
  const sites = new Map();
  const skipped = [];
  for (const d of findings(pkg)) {
    const file = resolve(ROOT, d.filename);
    const rel = relative(ROOT, file);
    if (!TEST_FILE.test(rel)) continue;
    const span = d.labels?.[0]?.span;
    if (!checked.has(file)) {
      skipped.push(`${rel}:${span?.line} not in ${name}/${config}`);
      continue;
    }
    if (!sites.has(file)) sites.set(file, []);
    sites.get(file).push(span);
  }
  const originals = new Map();
  const plans = new Map();
  for (const [file, spans] of sites) {
    const bytes = readFileSync(file);
    originals.set(file, bytes);
    const list = [];
    for (const s of spans) {
      const plan = planSite(bytes, s.offset, s.length);
      if (plan.skip) skipped.push(`${relative(ROOT, file)}:${s.line} ${plan.skip}`);
      else list.push({ ...plan, at: position(bytes, s.offset), endAt: position(bytes, s.offset + s.length) });
    }
    if (list.length) plans.set(file, list);
  }
  const total = [...plans.values()].reduce((n, l) => n + l.length, 0);
  if (!write) return { name, config, planned: total, skipped, reverted: [] };

  const baseline = parseTsc(tsc(pkg, config));
  if (baseline.some((e) => e.code === 'TS2307'))
    return { name, refused: `baseline cannot resolve a module (TS2307): build the dependencies first`, baseline: baseline.length };
  const reverted = [];
  const writeAll = () => {
    for (const [file, list] of plans) writeFileSync(file, apply(originals.get(file), list));
  };
  for (let round = 1; round <= 8; round++) {
    writeAll();
    const fresh = newErrors(baseline, parseTsc(tsc(pkg, config)));
    if (!fresh.length) break;
    // An error in a file the codemod did not rewrite cannot be put back site by site: stop and put everything back.
    const elsewhere = fresh.filter((e) => !plans.has(resolve(pkg, e.file)));
    if (round === 8 || elsewhere.length) {
      for (const [file, bytes] of originals) writeFileSync(file, bytes);
      const why = elsewhere.length
        ? `${elsewhere.length} new type error(s) in files it did not rewrite`
        : `still ${fresh.length} new type error(s) after 7 rounds`;
      return { name, refused: `${why}; every file put back`, fresh: elsewhere.length ? elsewhere : fresh };
    }
    for (const e of fresh) {
      const file = resolve(pkg, e.file);
      const list = plans.get(file);
      if (!list) continue; // already put back this round
      const inside = (p) =>
        (e.line > p.at.line || (e.line === p.at.line && e.col >= p.at.col)) &&
        (e.line < p.endAt.line || (e.line === p.endAt.line && e.col <= p.endAt.col));
      const hit = list.filter(inside);
      const drop = hit.length ? hit : list;
      for (const p of drop)
        reverted.push(`${relative(ROOT, file)}:${p.at.line} ${e.code} ${hit.length ? '' : '(outside a site: whole file) '}${e.message}`);
      const keep = list.filter((p) => !drop.includes(p));
      if (keep.length) plans.set(file, keep);
      else {
        plans.delete(file);
        writeFileSync(file, originals.get(file));
      }
    }
  }
  const changed = [...plans.keys()];
  if (changed.length) spawnSync(BIN('prettier'), ['--write', '--log-level', 'warn', ...changed], { cwd: ROOT, stdio: 'inherit' });
  return { name, config, rewritten: [...plans.values()].reduce((n, l) => n + l.length, 0), files: changed.length, skipped, reverted };
}

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const pkgs = argv.filter((a) => !a.startsWith('--'));
  if (!pkgs.length) {
    console.error('usage: garden-double-cast-codemod.mjs <package dir>... [--write]');
    return 2;
  }
  let failed = 0;
  for (const p of pkgs) {
    const r = runPackage(p, write);
    if (r.refused) {
      failed++;
      console.log(`✖ ${r.name}: ${r.refused}`);
      for (const e of r.fresh ?? []) console.log(`    ${e.file}(${e.line},${e.col}) ${e.code} ${e.message}`);
      continue;
    }
    console.log(
      write
        ? `✓ ${r.name} (${r.config}): ${r.rewritten} site(s) in ${r.files} file(s) rewritten, ${r.reverted.length} put back, ${r.skipped.length} left`
        : `· ${r.name} (${r.config}): ${r.planned} site(s) planned, ${r.skipped.length} left`,
    );
    for (const s of r.reverted) console.log(`    put back: ${s}`);
    for (const s of r.skipped) console.log(`    left: ${s}`);
  }
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

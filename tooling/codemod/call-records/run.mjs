#!/usr/bin/env node
// The whole call-records codemod for one service, end to end (the steps this file runs):
//   1. index.mjs writes the records, mounts them in the router and moves every caller;
//   2. contracts is built and samples.mjs writes each record's samples, and names any record JSON Schema can't carry;
//   3. portable.mjs gives a refused construct with an exact JSON form that form in its source, and step 2 runs again;
//      any record still refused: everything step 1 wrote is put back (portable.mjs's edits kept) and step 1 runs again
//      without those calls (they stay as they were);
//   4. with --refusals, refusals.mjs lists what the service's own tests see each new record's handler refuse;
//   5. procedures:write regenerates the registry and procedures/<service>.schema.json;
//   with --door (a service the Rust door serves, its router read --from-rev), door-check.mjs holds each record to it;
//   6. doubles.mjs gives every test's API client double that reaches a record caller a `call` (its own query or mutate);
//   7. dead-hand-schemas.mjs deletes each bank hand schema the moved callers were the last to name, in the same change.
// With --callers-only (a service whose Rust port is in flight) the service and its crate are never touched: step 1 mounts
// nothing and moves no declaration out of the service, step 3 is skipped (its fixes would change a record away from the
// router it copies, or the service's replay test), so a refused record is left by name; and the run fails if anything
// under services/svc-* or crates/svc-* changed.
// It starts only on a clean tree (nothing uncommitted under apps/, services/ or packages/contracts/), so step 3 can put
// back exactly what step 1 wrote.
//
//   node tooling/codemod/call-records/run.mjs --module notify [--service svc-notify] [--paths a.,b.] [--refusals] [--summary out.json]
// --summary writes the last line's summary (records, calls moved, each call left and why) to a file: report.mjs --deep reads it.
// --skip-file leaves.json starts the run with those calls left ({ "<path>": { "why": "..." } }, index.mjs's own form): a
// call whose schema edit would still break its service once it is left, since a left call keeps portable.mjs's edits.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const here = (f) => join(REPO, 'tooling/codemod/call-records', f);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8' });
// A step handed the changed record files does nothing when none changed (a re-run on a branch whose records already
// exist), and the run goes on: prettier given no paths fails, and the others would read nothing.
const prettier = (files) => files.length && sh(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...files]);

/**
 * Each app's type errors now, and the run's own service's (`services/<service>`, which mounts the records), keyed
 * without the line (a moved file's lines shift).
 */
export function appTypeErrors(repo = REPO, service = undefined) {
  const errors = [];
  const projects = existsSync(join(repo, 'apps')) ? readdirSync(join(repo, 'apps')).map((app) => `apps/${app}`) : [];
  if (service) projects.push(`services/${service}`);
  for (const dir of projects) {
    if (!existsSync(join(repo, dir, 'tsconfig.json'))) continue;
    const r = spawnSync('node', [join(repo, 'tooling', 'scripts', 'tsc.mjs'), '--noEmit', '-p', '.'], {
      cwd: join(repo, dir),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /^([^(]+)\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(line);
      if (m)
        errors.push({
          file: `${dir}/${m[1]}`,
          key: `${dir}/${m[1]}: ${m[4]}`,
          text: `${dir}/${line}`,
          line: Number(m[2]),
          col: Number(m[3]),
        });
    }
  }
  return errors;
}

// The parser is loaded only when a run has a type error to place, so the run's other steps need nothing beside them.
const load = createRequire(import.meta.url);
const walk = (...args) => load('./ast.mjs').walk(...args);

/** A parsed program, or undefined when the text does not parse. */
function programOf(file, text) {
  try {
    const { program, errors } = load('oxc-parser').parseSync(file, text);
    return errors.length ? undefined : program;
  } catch {
    return undefined;
  }
}

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

/**
 * The name another file calls a node by: a member that is a function (`payments: () => ...`, a method), or a
 * declaration at the top of the file (`export const paymentsApi = ...`, `function payments()`). A local (`const page =
 * await queryRecord(...)`) or a data key (`{ kind: 'x' }`) names nothing outside, and would match any screen's `page`.
 */
function declaredName(node, parents) {
  if (
    (node.type === 'MethodDefinition' || (node.type === 'Property' && FUNCTIONS.has(node.value?.type))) &&
    node.key?.type === 'Identifier'
  )
    return node.key.name;
  const top = (n) => {
    const up = parents.get(n);
    return up?.type === 'Program' || (up?.type === 'ExportNamedDeclaration' && parents.get(up)?.type === 'Program');
  };
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && top(parents.get(node))) return node.id.name;
  if (node.type === 'FunctionDeclaration' && node.id && top(node)) return node.id.name;
  return undefined;
}

/**
 * The names each moved record is reached by in one caller file: the record's own name, and every member or declaration
 * name around a use of it (`payments` in `payments: (...) => queryRecord(PAY_PAYMENT_LIST, ...)`). Map: path → Set.
 */
function handlesIn(file, text, moved) {
  const program = programOf(file, text);
  const records = new Map(moved.filter((m) => m.record).map((m) => [m.record, m.path]));
  const handles = new Map();
  if (!program || !records.size) return handles;
  const parents = new Map();
  walk(program, (node, parent) => {
    parents.set(node, parent);
    if (node.type === 'ImportDeclaration') return false;
  });
  for (const node of parents.keys()) {
    const path = node.type === 'Identifier' ? records.get(node.name) : undefined;
    if (!path) continue;
    const names = handles.get(path) ?? new Set([node.name]);
    for (let n = parents.get(node); n; n = parents.get(n)) {
      const name = declaredName(n, parents);
      if (name) names.add(name);
    }
    handles.set(path, names);
  }
  return handles;
}

/**
 * Of the paths that might own an error, the ones the code around it names: from the innermost node at the error's line
 * and column outwards, the first enclosing node, short of the whole file, that names a path's record or a member around
 * a use of it. A call two lines on in the same api file, or one the screen never touches, owns nothing; none named, or
 * no position: every path, as before.
 */
function nearestOwners(e, paths, callerFiles, moved, strict = false) {
  const none = strict ? [] : paths;
  if (!e.line || (!strict && paths.length < 2)) return none;
  const program = programOf(e.file, e.source);
  if (!program) return none;
  const handles = new Map();
  for (const [f, text] of callerFiles)
    for (const [path, names] of handlesIn(f, text, moved)) {
      if (!paths.includes(path)) continue;
      // In a service the record's own name only: the router's const holds every record, and would own any error.
      const record = moved.find((m) => m.path === path)?.record;
      if (strict) for (const n of names) if (n !== record) names.delete(n);
      const all = handles.get(path) ?? new Set();
      for (const n of names) all.add(n);
      handles.set(path, all);
    }
  const lines = e.source.split('\n');
  const at = lines.slice(0, e.line - 1).reduce((n, l) => n + l.length + 1, 0) + Math.max(0, (e.col ?? 1) - 1);
  const chain = [];
  walk(program, (node) => {
    if (node.start > at || node.end <= at) return false;
    chain.push(node);
  });
  for (const node of chain.reverse()) {
    if (node === program) break;
    const named = new Set();
    walk(node, (n) => {
      if (n.type === 'Identifier') named.add(n.name);
    });
    const found = paths.filter((p) => [...(handles.get(p) ?? [])].some((h) => named.has(h)));
    // In a service, only the one call that mounts the record (`mountRecord(PAY_X, handler)`): a node holding several
    // is the router around them, and the error is in none of their handlers.
    if (strict && found.length) return node.type === 'CallExpression' && found.length === 1 ? found : [];
    if (found.length) return found;
  }
  return none;
}

/**
 * Which moved calls own each new type error: the paths with a caller in the erring file, else in the nearest files it
 * reaches by relative imports (a screen, or its test, reading a type the moved file now takes from its record), up to
 * four imports away; of those, only the ones the code around the error names (nearestOwners), so one error leaves one
 * call, not every moved call in its file. `moved` is the step-1 summary's [{ path, record, files }]. Map: file →
 * Map(path → error).
 */
export function ownersOf(errors, moved, read = (f) => readFileSync(join(REPO, f), 'utf8')) {
  const byFile = new Map();
  const noExt = (f) => f.replace(/\.(js|jsx|ts|tsx|mts|mjs)$/, '');
  for (const m of moved) for (const f of m.files) byFile.set(noExt(f), [...(byFile.get(noExt(f)) ?? []), m.path]);
  const readOr = (f) => {
    try {
      return read(f);
    } catch {
      return undefined;
    }
  };
  // An import's target as the file it is: `./x` is x.ts, x.tsx or x/index.ts(x); [file, its text], or none.
  const open = (target) => {
    for (const f of [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`]) {
      const text = readOr(f);
      if (text !== undefined) return [f, text];
    }
    return undefined;
  };
  const owners = new Map();
  for (const e of errors) {
    let paths = [];
    const source = readOr(e.file) ?? '';
    // In the run's own service (which mounts the records) the owner is the record the code around the error names
    // (`mountRecord(PAY_X, handler)` whose handler no longer fits it); an error that names none is the run's, unowned.
    if (e.file.startsWith('services/')) {
      const found = nearestOwners(
        { ...e, source },
        moved.map((m) => m.path),
        [[e.file, source]],
        moved,
        true,
      );
      if (!found.length) continue;
      const own = owners.get(e.file) ?? new Map();
      for (const p of found) if (!own.has(p)) own.set(p, e.text.replace(/^\S+?\(\d+,\d+\): /, ''));
      owners.set(e.file, own);
      continue;
    }
    let ring = [[e.file, source]];
    const seen = new Set([noExt(e.file)]);
    for (let hop = 0; hop <= 4 && ring.length; hop++) {
      paths = ring.flatMap(([f]) => byFile.get(noExt(f)) ?? []);
      if (paths.length) break;
      const next = [];
      for (const [f, text] of ring) {
        const dir = f.split('/').slice(0, -1).join('/');
        for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
          const t = noExt(normalize(join(dir, m[1])));
          if (seen.has(t)) continue;
          seen.add(t);
          const found = open(t);
          if (found) next.push(found);
        }
      }
      ring = next;
    }
    if (!paths.length) continue;
    const callerFiles = ring.filter(([f]) => byFile.has(noExt(f)));
    paths = nearestOwners({ ...e, source }, [...new Set(paths)], callerFiles, moved);
    const own = owners.get(e.file) ?? new Map();
    for (const p of paths) if (!own.has(p)) own.set(p, e.text.replace(/^\S+?\(\d+,\d+\): /, ''));
    owners.set(e.file, own);
  }
  return owners;
}

export function run(argv) {
  const refusals = argv.includes('--refusals');
  const summaryOut = argv.includes('--summary') ? argv[argv.indexOf('--summary') + 1] : undefined;
  const seed = argv.includes('--skip-file') ? JSON.parse(readFileSync(argv[argv.indexOf('--skip-file') + 1], 'utf8')) : {};
  const pass = argv.filter(
    (a, i) => !['--refusals', '--summary', '--skip-file'].includes(a) && !['--summary', '--skip-file'].includes(argv[i - 1]),
  );
  const service =
    pass[pass.indexOf('--service') + 1] && pass.includes('--service')
      ? pass[pass.indexOf('--service') + 1]
      : `svc-${pass[pass.indexOf('--module') + 1]}`;

  const dirty = out('git', [
    'status',
    '--porcelain',
    '--',
    'apps',
    'services',
    'packages/contracts/src',
    'packages/contracts/procedures',
  ]).trim();
  if (dirty) {
    console.error(`commit or put back these first, so a retry can undo exactly what the codemod wrote:\n${dirty}`);
    process.exit(1);
  }

  const door = pass.includes('--door') ? ['--door', pass[pass.indexOf('--door') + 1]] : [];
  const callersOnly = pass.includes('--callers-only');
  const summary = join(tmpdir(), `call-records-${process.pid}.json`);
  const unportable = join(tmpdir(), `call-records-unportable-${process.pid}.json`);
  const step1 = (extra = []) => {
    sh('node', [here('index.mjs'), ...pass, '--write', '--json', summary, ...extra], { stdio: ['ignore', 'ignore', 'inherit'] });
    return JSON.parse(readFileSync(summary, 'utf8'));
  };
  const recordFiles = () =>
    out('git', ['status', '--porcelain', '--', 'packages/contracts/src'])
      .split('\n')
      .map((l) => l.slice(3))
      .filter((f) => /-(procedures|records)\.ts$/.test(f));
  const build = () => sh('pnpm', ['--filter', '@intafaced/contracts', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const putBack = () => {
    sh('git', ['checkout', '--', 'apps', 'services', 'packages/contracts/src']);
    sh('git', ['clean', '-fdq', '--', 'apps', 'services', 'packages/contracts/src']);
  };

  // Steps 2 and 3, with portable.mjs between: a record the export refuses for a construct with an exact JSON form is fixed
  // in its schema's source and tried again. What portable.mjs edits in files the repo already has is kept across a put
  // back (as a patch); records still refused are put back and left out, until a round leaves none.
  const tracked = new Set(out('git', ['ls-files', '--', 'apps', 'services', 'packages/contracts/src']).split('\n').filter(Boolean));
  const kept = new Set();
  const patchFile = join(tmpdir(), `call-records-portable-${process.pid}.patch`);
  const skipFile = join(tmpdir(), `call-records-skip-${process.pid}.json`);
  let skip = { ...seed };
  if (Object.keys(skip).length) writeFileSync(skipFile, JSON.stringify(skip));
  let result;
  // Step 8: the apps are typechecked against what they were before the run. A new error in a file a moved caller is in,
  // or in a file that imports one, leaves that call's path by name (the screen reads its answer, or sends its input, other
  // than the router's types say), and the run starts again without it; an error no moved call can own fails the run.
  build();
  const before = new Set(appTypeErrors(REPO, service).map((e) => e.key));
  for (let pass = 0; ; pass++) {
    for (let round = 0; ; round++) {
      result = step1(Object.keys(skip).length ? ['--skip-file', skipFile] : []);
      build();
      let skipped;
      for (;;) {
        const files = recordFiles();
        if (!files.length) {
          skipped = {};
          break;
        }
        sh('node', [here('samples.mjs'), '--unportable', unportable, ...door, ...files]);
        skipped = JSON.parse(readFileSync(unportable, 'utf8'));
        if (!Object.keys(skipped).length || callersOnly) break;
        const fixed = JSON.parse(out('node', [here('portable.mjs'), '--unportable', unportable, '--write', ...door, ...files]));
        if (!fixed.fixed) break;
        // A record file is written again by the next round's step 1 (and fixed again by portable.mjs), so only the
        // schema sources it edited are kept: keeping a record file would bring back this round's records after a put back.
        for (const f of fixed.files) if (tracked.has(f) && !files.includes(f)) kept.add(f);
        build();
      }
      if (!Object.keys(skipped).length) break;
      if (round > 5) throw new Error(`records still refused after ${round} rounds: ${Object.keys(skipped).join(', ')}`);
      const patch = kept.size ? out('git', ['diff', '--', ...kept]) : '';
      putBack();
      if (patch) {
        writeFileSync(patchFile, patch);
        sh('git', ['apply', patchFile]);
      }
      skip = { ...skip, ...skipped };
      writeFileSync(skipFile, JSON.stringify(skip));
    }
    prettier(recordFiles());
    if (refusals && recordFiles().length) {
      build();
      sh('node', [here('refusals.mjs'), '--service', service, ...recordFiles()]);
      prettier(recordFiles());
    }
    build();
    // A door's records are held to the door before anything else reads them: kind, access and the exact input tree.
    if (door.length && recordFiles().length) sh('node', [here('door-check.mjs'), ...door, '--service', service, ...recordFiles()]);
    sh('pnpm', ['procedures:write'], { cwd: join(REPO, 'packages/contracts'), stdio: ['ignore', 'ignore', 'inherit'] });
    sh('node', [here('doubles.mjs'), '--write'], { stdio: ['ignore', 'ignore', 'inherit'] });
    sh('node', [here('dead-hand-schemas.mjs'), '--write'], { stdio: ['ignore', 'ignore', 'inherit'] });
    const fresh = appTypeErrors(REPO, service).filter((e) => !before.has(e.key));
    if (!fresh.length) break;
    const owners = ownersOf(fresh, result.moved ?? []);
    const orphans = fresh.filter((e) => !owners.has(e.file));
    if (orphans.length || pass > 5)
      throw new Error(
        `the apps or the service don't typecheck after the run, and no moved call owns these errors:\n${(orphans.length ? orphans : fresh).map((e) => e.text).join('\n')}`,
      );
    for (const [file, paths] of owners)
      for (const [path, text] of paths)
        skip[path] ??= {
          why: file.startsWith('services/')
            ? `the service's handler no longer typechecks against its record: ${text}`
            : `the app's own types disagree with its record: ${text}`,
        };
    writeFileSync(skipFile, JSON.stringify(skip));
    const patch = kept.size ? out('git', ['diff', '--', ...kept]) : '';
    putBack();
    sh('git', ['checkout', '--', 'packages/contracts/procedures']);
    if (patch) {
      writeFileSync(patchFile, patch);
      sh('git', ['apply', patchFile]);
    }
  }
  for (const f of [summary, unportable, patchFile, skipFile]) if (existsSync(f)) rmSync(f);
  if (callersOnly) {
    const touched = out('git', ['status', '--porcelain', '--', 'services', 'crates']).trim();
    if (touched) {
      console.error(`--callers-only touched a service mid-port, which it never may:\n${touched}`);
      process.exit(1);
    }
  }
  const done = { service, records: result.records.length, rewritten: result.rewritten, hand: result.hand };
  if (summaryOut) writeFileSync(summaryOut, JSON.stringify(done));
  console.log(JSON.stringify(done, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) run(process.argv.slice(2));

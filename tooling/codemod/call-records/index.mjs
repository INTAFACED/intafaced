#!/usr/bin/env node
// The call-records codemod: moves an app's calls to a service from "by name" (`api.query('bank', 'deposits.list', input,
// schema)`) to the call's written record (`api.call(BANK_DEPOSITS_LIST, input)`), and writes the record from the
// service's own router: its guard, input and answer schemas, moved into @intafaced/contracts, and the router mounting it
// (`mountRecord`). What it can't move safely it leaves untouched and names. See run.mjs for the whole run.
//
//   node tooling/codemod/call-records/index.mjs --module bank [--paths deposits.,global.] [--service svc-bank]
//        [--file bank-deposit-procedures] [--callers-only] [--write]
//
// --callers-only, for a service whose Rust port is in flight: the records are written from its router as it stands and its
// callers move to them, but the service and its crate are never touched (the router keeps its own schemas and mounts).
//
// Safe to rerun: a call already made through its record is no site, and a record already written is reused.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSync } from 'oxc-parser';
import {
  applyEdits,
  bindingOf,
  forget,
  keyOf,
  leadingDoc,
  load,
  resolveRelative,
  statementEnd,
  statementStart,
  text,
  walk,
} from './ast.mjs';
import { answerFromCallers } from './answer.mjs';
import { brandAssetIds, unbranded } from './asset-id.mjs';
import { chainOf, procedures } from './router.mjs';
import { asWritten, closureOf, contractsExports, declaresSame, usedOutside } from './closure.mjs';
import { accessText, doorOf } from './door.mjs';
import { founderPartsFor } from './founder-guard.mjs';
import { partsFor } from './guard-check.mjs';
import { fanBranch, fanIn } from './fan.mjs';
import { wrapperBranch, wrapperIn } from './wrapper.mjs';
import { findSites } from './sites.mjs';
import { BUSINESS_FORMS, businessCall } from './pay-business.mjs';
import { checkedTool, toolCall, toolChecked, toolFormsIn, toolInput, toolItem, toolSchema, toolShape } from './tool-forms.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const CONTRACTS = join(REPO, 'packages/contracts/src');
const MARK = '// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.';

export const recordName = (mod, path) =>
  [mod, ...path.split('.').filter((seg, i) => !(i === 0 && seg === mod && path.includes('.')))]
    .map((s) =>
      s
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/-/g, '_')
        .toUpperCase(),
    )
    .join('_');
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function args(argv) {
  const out = { paths: [], write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--module') out.module = argv[++i];
    else if (a === '--service') out.service = argv[++i];
    else if (a === '--paths') out.paths = argv[++i].split(',').filter(Boolean);
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--router-fn') out.routerFn = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--skip-file') out.skip = JSON.parse(readFileSync(argv[++i], 'utf8'));
    else if (a === '--door') out.door = argv[++i];
    else if (a === '--from-rev') out.fromRev = argv[++i];
    else if (a === '--callers-only') out.callersOnly = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.module) throw new Error('--module is required');
  if (Boolean(out.door) !== Boolean(out.fromRev)) throw new Error('--door and --from-rev go together');
  if (out.callersOnly && out.door) throw new Error('--callers-only is for a port in flight, --door for one switched: not both');
  out.service ??= `svc-${out.module}`;
  return out;
}

/**
 * The refusal readers a service declares (`const x: RefusalOf = ...`). A procedure takes the one in its own file, else an
 * exported one (an `errors` or `refusal` file first). The reader only names what a handler throws (strict test runs and
 * the refusal coverage); outside tests a refusal leaves as it was thrown, so the choice never changes the wire.
 */
function refusalReaders(serviceDir) {
  const out = [];
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], {
    cwd: serviceDir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  for (const f of files) {
    const src = readFileSync(join(serviceDir, f), 'utf8');
    for (const m of src.matchAll(/^(export )?const (\w+): RefusalOf\b/gm))
      out.push({ name: m[2], file: join(serviceDir, f), exported: Boolean(m[1]) });
    // The parts a router hands its mount (`const p2pParts: ServiceParts = { refusalOf, checks }`), in its own scope.
    for (const m of src.matchAll(/^ *const (\w+): ServiceParts\b/gm)) out.push({ name: m[1], file: join(serviceDir, f), parts: true });
  }
  return out;
}
/** A record naming its service's own check (`check:`) is mounted with the parts that hand it over, in its router's file. */
function readerFor(readers, file, guard = undefined) {
  if (guard?.founder) return founderPartsFor(file, guard, readerFor(readers, file));
  if (/\bcheck: '/.test(guard?.text ?? '')) return partsFor(readers, file, guard, () => readerFor(readers, file));
  return (
    readers.find((r) => !r.parts && r.file === file) ??
    readers
      .filter((r) => r.exported)
      .sort((a, b) => Number(!/errors|refusal/.test(a.file)) - Number(!/errors|refusal/.test(b.file)) || a.file.length - b.file.length)[0]
  );
}

const relImport = (fromFile, toFile) => {
  let r = relative(join(fromFile, '..'), toFile).replace(/\.tsx?$/, '.js');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
};
const contractsSpec = (file) => `@intafaced/contracts/${basename(file).replace(/\.ts$/, '')}`;

/** Per file: edits, and the imports to add (`spec -> Set(names)`). */
export class Changes {
  constructor() {
    this.files = new Map();
  }
  of(file) {
    if (!this.files.has(file)) this.files.set(file, { edits: [], imports: new Map(), exports: new Set() });
    return this.files.get(file);
  }
  edit(file, start, end, text) {
    this.of(file).edits.push({ start, end, text });
  }
  imp(file, spec, name) {
    const f = this.of(file);
    if (!f.imports.has(spec)) f.imports.set(spec, new Set());
    f.imports.get(spec).add(name);
  }
}

function plan(opts) {
  const serviceDir = join(REPO, 'services', opts.service);
  const { procedures: procs, unread } = procedures(serviceDir, opts.routerFn);
  const all = findSites(REPO);
  const wanted = (s) =>
    s.module === opts.module &&
    (opts.paths.length === 0 || opts.paths.some((p) => s.path === p || (p.endsWith('.') && s.path?.startsWith(p))));
  const sites = all.filter(wanted);
  const hand = [];
  const byPath = new Map();
  for (const s of sites) {
    if (s.problem) {
      hand.push({ site: s, why: s.problem });
      continue;
    }
    const arg = schemaArgOf(s);
    // A portal list's item schema is one row of the answer: what it checks is lost with it all the same.
    const checked = arg ?? (toolShape(s) ? toolChecked(s) : undefined);
    const checks = s.schema ? answerChecks(s.schema.p, s.schema.node) : checked ? answerChecks(load(s.file), checked) : [];
    // A customer query or mutate whose schema only checks the answer (no transform) keeps that schema: the call goes to its
    // record through `callAs`, which holds the answer to it and returns what it parses (apps/customer/src/shared/api.ts).
    if (checks.length && checkedCall(s, arg, checks)) s.checked = text(load(s.file), arg);
    // A portal tool's caller keeps its checking schema the same way, in the tool's checked form (tool-forms.mjs).
    else if (checks.length && checked && checkedToolCall(s, checks)) s.checked = text(load(s.file), checked);
    else if (checks.length) {
      hand.push({
        site: s,
        why: `its own schema checks the answer, ${checks.join(', ')}: move the check to the call's \`accept\` by hand`,
      });
      continue;
    }
    if (!byPath.has(s.path)) byPath.set(s.path, []);
    byPath.get(s.path).push(s);
  }
  const readers = opts.door ? [] : refusalReaders(serviceDir);
  const door = opts.door ? doorOf(join(REPO, opts.door), opts.module) : undefined;
  const exportsIndex = contractsExports(REPO);
  const records = [];
  const existing = [];
  for (const [path, list] of byPath) {
    if (opts.skip?.[path]) {
      for (const s of list) hand.push({ site: s, why: `its record can't be exported as the router writes it: ${opts.skip[path]}` });
      continue;
    }
    const proc = procs.get(path);
    if (!proc) {
      // A path the reader found but could not take as one procedure is named with its own reason.
      const own = unread.find((u) => u.path === path);
      for (const s of list)
        hand.push({
          site: s,
          why: own
            ? `${opts.service} ${path}: ${own.why}`
            : `${opts.service} has no procedure ${path} the codemod can read${unread.length ? ` (${unread.length} router parts unread)` : ''}`,
        });
      continue;
    }
    if (proc.mounted) {
      const recArg = proc.node.arguments[0];
      const b = recArg?.type === 'Identifier' ? bindingOf(proc.p, recArg, recArg.name) : undefined;
      const name = b?.kind === 'import' ? b.imported : recArg?.name;
      const file = name ? exportsIndex.get(name) : undefined;
      if (!file) for (const s of list) hand.push({ site: s, why: `${path} is mounted from a record the codemod can't find` });
      else existing.push({ path, name, file, sites: list, kind: proc.node.callee?.property?.name });
      continue;
    }
    const chain = chainOf(proc);
    if (!chain.output) {
      // No answer schema in the router: the record takes its callers' own, or the reason it can't names the caller.
      const taken = answerFromCallers(REPO, list, { schemaOf: schemaArgOf, checksOf: answerChecks, itemOf: listItemOf });
      const at = chain.problems.findIndex((x) => x.startsWith('no .output()'));
      if (taken.output) {
        chain.problems.splice(at, 1);
        chain.output = taken.output.node;
        chain.outputP = taken.output.p;
        chain.outputPage = Boolean(taken.output.page);
      } else chain.problems[at] = `no .output(), and the callers' own can't stand for it: ${taken.why}`;
    }
    let reader = door ? undefined : readerFor(readers, proc.p.file, chain.guard);
    if (door) {
      // The door is the wire: its kind and access stand for the router's, which only checks them against it; a guard
      // the router writes its own way is the door's access all the same.
      const row = door.calls.get(path);
      chain.problems = chain.problems.filter((x) => !/^guard |^scopedProcedure /.test(x));
      if (!row) chain.problems.push(`${opts.door} serves no call ${path}`);
      else if (row.kind !== chain.kind) chain.problems.push(`${opts.door} serves ${path} as a ${row.kind}, the router as a ${chain.kind}`);
      else if (!row.access) chain.problems.push(`${opts.door} serves ${path} to ${row.why}`);
      else {
        chain.guard = { text: accessText(row.access) };
        try {
          reader = { refusals: door.refusals(path) };
        } catch (e) {
          chain.problems.push(e.message);
        }
      }
    }
    const kindMismatch = list.filter((s) => s.kind && s.kind !== chain.kind);
    if (chain.problems.length || !reader) {
      const why =
        chain.problems.join('; ') ||
        (/\bcheck: '/.test(chain.guard?.text ?? '')
          ? `${path} names its service's own check, but its router's file declares no \`: ServiceParts\` and the check is not exported to mount it with`
          : `${opts.service} has no refusal reader this file can import (no exported \`: RefusalOf\`)`);
      for (const s of list) hand.push({ site: s, why });
      continue;
    }
    const name = recordName(opts.module, path);
    if (exportsIndex.has(name) && door && recordOfPath(exportsIndex.get(name), name, path)) {
      // A door call with its record already written: the callers move to it.
      existing.push({ path, name, file: exportsIndex.get(name), sites: list, kind: chain.kind });
      continue;
    }
    if (exportsIndex.has(name)) {
      for (const s of list) hand.push({ site: s, why: `contracts already exports ${name}` });
      continue;
    }
    // A call that takes no input is sent none: `{}` or `undefined` from the caller is the same request today.
    const badInput = chain.input ? [] : list.filter((s) => !kindMismatch.includes(s) && !noInput(s));
    for (const s of badInput) hand.push({ site: s, why: `${path} takes no input, but the caller sends one` });
    records.push({ path, name, proc, chain, reader, sites: list.filter((s) => !kindMismatch.includes(s) && !badInput.includes(s)) });
    for (const s of kindMismatch) hand.push({ site: s, why: `calls ${path} as a ${s.kind}, but the service mounts a ${chain.kind}` });
  }
  return { serviceDir, procs, unread, sites, records, existing, hand };
}

/** The kind a record already written in contracts `file` declares: `query` or `mutation`. */
function recordKind(file, name) {
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`export const ${name} = defineProcedure(`);
  return at < 0 ? undefined : /kind: '(query|mutation)'/.exec(src.slice(at, src.indexOf('\n});', at)))?.[1];
}

/** Whether `name` in contracts `file` is the record of `path`: its `defineProcedure({ … path: '<path>' … })`. */
function recordOfPath(file, name, path) {
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`export const ${name} = defineProcedure(`);
  if (at < 0) return false;
  const end = src.indexOf('\n});', at);
  return src.slice(at, end).includes(`path: '${path}',`);
}

/** The input argument of a site, and whether it is no input at all (`undefined`, `{}`, or absent). */
const INPUT_AT = { founderCall: 4, founderEdgeCall: 4, payCall: 3, useBankRead: 1, payQuery: 1, payMutate: 1 };
const inputArg = (s) =>
  s.fan?.input ??
  (s.shape === 'desk-read'
    ? s.inputProp?.value
    : s.shape === 'ops-entry'
      ? s.dispatchers[0].arguments[4]
      : s.shape === 'write-spec'
        ? undefined // the spec's `input` builds it from the form; the record's input type holds it at the typecheck
        : toolShape(s)
          ? toolInput(s)
          : s.node.arguments[INPUT_AT[s.shape] ?? 2]);
function noInput(s) {
  // A wrapper sends the input it sent before: its record only names the call.
  if (s.shape === 'wrapper') return true;
  const a = inputArg(s);
  return !a || (a.type === 'Identifier' && a.name === 'undefined') || (a.type === 'ObjectExpression' && a.properties.length === 0);
}

/**
 * The record file a path lands in: its first segment's (`depth` 1), or once a helper name it needs is taken there, its
 * sub-area's (`depth` 2: `own.schedules.list` to `<module>-own-schedules-procedures.ts`). A call with no sub-area
 * (`loans.open`) takes its area's second file (`<module>-loans-2-procedures.ts`), so the calls that read one router's
 * helper land together beside it.
 */
function recordFile(opts, path, depth = 1) {
  if (opts.file && depth === 1) return join(CONTRACTS, `${opts.file.replace(/\.ts$/, '')}.ts`);
  const segs = path.split('.');
  const seg = depth > 1 && segs.length <= depth ? `${kebab(segs[0])}-2` : segs.slice(0, depth).map(kebab).join('-');
  const primary = join(CONTRACTS, `${opts.module}-${seg}-procedures.ts`);
  if (!existsSync(primary) || readFileSync(primary, 'utf8').includes(MARK)) return primary;
  return join(CONTRACTS, `${opts.module}-${seg}-records.ts`);
}

/** A record's file: its area's, or, once a helper name it needs is taken there, its own sub-area's (`fileDepth` 2). */
const fileOf = (opts, r) => recordFile(opts, r.path, r.fileDepth ?? 1);

/**
 * What each top-level name of a file (its text) is bound to: `{ decl: true }` for a declaration, `{ from, imported }`
 * for an import. A record file or the shared file can take a helper or an import only under a name it leaves free.
 */
function bindingsOf(src) {
  const out = new Map();
  const { program } = parseSync('bindings.ts', src);
  for (const stmt of program.body) {
    if (stmt.type === 'ImportDeclaration') {
      for (const sp of stmt.specifiers ?? [])
        out.set(sp.local.name, { from: stmt.source.value, imported: sp.imported?.name ?? sp.imported?.value ?? 'default' });
      continue;
    }
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) if (d.id.type === 'Identifier') out.set(d.id.name, { decl: true });
    } else if (decl.id?.name) out.set(decl.id.name, { decl: true });
  }
  return out;
}

/**
 * The first name `file` (as `src`, or `undefined` while it has no text) already binds otherwise than this group needs:
 * a declaration it would add under a name taken there, or an import under a name the file declares or imports from
 * elsewhere. An import from the file itself is the file's own declaration, never a clash.
 */
function takenIn(file, src, decls, imports) {
  if (src === undefined) return undefined;
  const have = bindingsOf(src);
  const self = `./${basename(file).replace(/\.ts$/, '.js')}`;
  for (const name of decls) if (have.has(name)) return name;
  for (const { local, spec, imported } of imports) {
    if (spec === self) continue;
    const b = have.get(local);
    if (b && !(b.from === spec && b.imported === imported)) return local;
  }
  return undefined;
}

/** The contracts files a contracts file's text imports (`./x.js`), as paths. */
function importsOf(src) {
  const out = new Set();
  for (const m of (src ?? '').matchAll(/^import\b[^;]*?from '\.\/([\w-]+)\.js';/gms)) out.add(join(CONTRACTS, `${m[1]}.ts`));
  return out;
}

/**
 * Whether contracts file `from` reaches `to` through its imports (`textOf` reads a file as this run has written it) and
 * the `[importer, imported]` edges a group is about to add.
 */
function reaches(from, to, textOf, added = []) {
  const seen = new Set();
  const next = [from];
  while (next.length) {
    const f = next.pop();
    if (f === to) return true;
    if (seen.has(f)) continue;
    seen.add(f);
    next.push(...importsOf(textOf(f)), ...added.filter(([a]) => a === f).map(([, b]) => b));
  }
  return false;
}

function build(opts, planned) {
  // The router is read, never edited: mid-port (callers only), or a door's, read from the commit before its deletion.
  const routerKept = Boolean(opts.callersOnly || opts.door);
  const changes = new Changes();
  const created = new Map();
  const groups = new Map();
  for (const r of planned.records) {
    const file = fileOf(opts, r);
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(r);
  }
  const problems = [];
  const done = [];
  const movedTo = new Map();
  const schemaNames = new Map();
  for (const [file, recs] of groups) {
    const roots = recs.flatMap((r) => [
      { p: r.proc.p, node: r.chain.input, where: `${r.path} input` },
      { p: r.chain.outputP ?? r.proc.p, node: r.chain.output, where: `${r.path} output` },
    ]);
    const closure = closureOf(REPO, roots);
    if (closure.problems.length) {
      // One bad record must not hold the rest: retry record by record and keep those whose closure is clean.
      const good = [];
      for (const r of recs) {
        const c = closureOf(
          REPO,
          roots.filter((x) => x.where.startsWith(`${r.path} `)),
        );
        if (c.problems.length) for (const s of r.sites) planned.hand.push({ site: s, why: c.problems.join('; ') });
        else good.push(r);
      }
      if (good.length === 0) continue;
      if (good.length < recs.length) {
        groups.set(file, good);
        return build(opts, { ...planned, records: planned.records.filter((r) => good.includes(r) || fileOf(opts, r) !== file) });
      }
    }
    // Two different declarations under one name (svc-bank's routers each keep their own `amountString`, some with a
    // message, some without; svc-pay's registries and deposit freezes each their own `networkIdSchema`) cannot land in
    // one file. Keep the records whose helpers agree; the rest go to their own sub-area's file in this same run
    // (`founderAdmin.depositFreezes.*` to pay-founder-admin-deposit-freezes-procedures.ts), where the name is free. A
    // record already in its sub-area's file that still clashes stays by name, named.
    // Mid-port, and for a door (its router read from the commit before its deletion), the router is never edited, so two
    // of its files declaring one helper the same way (svc-agents' `idInput` in own/routes.ts and own/automation-routes.ts)
    // give contracts one copy; elsewhere each declaration is its file's.
    const keyOfMoved = (m) =>
      !m.q
        ? `inline#${m.name}`
        : routerKept && serviceFiles([m.q.file]).length
          ? `as written#${m.name}#${asWritten(m.text)}`
          : `${m.q.file}#${m.name}`;
    const clashing = (moved, seen = new Map()) =>
      moved.find((m) => {
        if (seen.has(m.name) && seen.get(m.name) !== keyOfMoved(m)) return true;
        seen.set(m.name, keyOfMoved(m));
        return false;
      });
    if (clashing(closure.moved)) {
      const keep = [];
      const moved = [];
      const seen = new Map();
      for (const r of recs) {
        const c = closureOf(
          REPO,
          roots.filter((x) => x.where.startsWith(`${r.path} `)),
        );
        const trial = new Map(seen);
        const bad = clashing(c.moved, trial);
        if (bad && keep.length) {
          if (!r.fileDepth) {
            moved.push(r);
            continue;
          }
          for (const site of r.sites)
            planned.hand.push({ site, why: `helper ${bad.name} clashes with another ${bad.name} in this record file and its sub-area's` });
          continue;
        }
        keep.push(r);
        for (const [k, v] of trial) seen.set(k, v);
      }
      groups.set(file, keep);
      return build(opts, {
        ...planned,
        records: planned.records
          .filter((r) => keep.includes(r) || moved.includes(r) || fileOf(opts, r) !== file)
          .map((r) => {
            if (moved.includes(r)) r.fileDepth = 2;
            return r;
          }),
      });
    }
    // Each moved declaration lands once: in the service's shared schema file, or, when its name is taken there by
    // another declaration, with all of this file's new ones in the record file itself.
    const shared = join(CONTRACTS, `${opts.module}-call-schemas.ts`);
    if (!schemaNames.has(shared))
      schemaNames.set(
        shared,
        new Map(
          existsSync(shared)
            ? [...readFileSync(shared, 'utf8').matchAll(/^export (?:const|function|type) (\w+)/gm)].map((m) => [m[1], 'existing'])
            : [],
        ),
      );
    const taken = schemaNames.get(shared);
    const keyOf = keyOfMoved;
    // Mid-port or for a door, an earlier run already copied the router's helper into the shared file: the router still
    // declares it, so the same text there is that copy. The record imports it; declaring it again beside it would clash.
    if (routerKept)
      for (const m of closure.moved) {
        const k = keyOf(m);
        if (!m.q || movedTo.has(k) || taken.get(m.name) !== 'existing' || !declaresSame(shared, m.name, m.text)) continue;
        movedTo.set(k, shared);
        taken.set(m.name, k);
      }
    // A helper the record file already declares as written (an earlier run put svc-pay's `userIdSchema` there) is that
    // copy: the record reads it where it stands, and its old home imports it from there.
    const reused = [];
    for (const m of closure.moved) {
      const k = keyOf(m);
      if (!m.q || movedTo.has(k) || !declaresSame(file, m.name, m.text)) continue;
      movedTo.set(k, file);
      reused.push(m);
    }
    const fresh = [...new Map(closure.moved.filter((m) => !movedTo.has(keyOf(m))).map((m) => [keyOf(m), m])).values()];
    const clash =
      fresh.some((m) => taken.has(m.name) && taken.get(m.name) !== keyOf(m)) ||
      // A helper this group reads from a record file, under a name the shared file already gives another helper.
      closure.moved.some(
        (m) => !fresh.includes(m) && movedTo.get(keyOf(m)) !== shared && taken.has(m.name) && taken.get(m.name) !== keyOf(m),
      );
    // Every name the group adds to a file must be free there, or bound there to the same thing: svc-pay's mandateView
    // reads pay-subscription-procedures' `amountSchema`, which the shared file can't import beside its own.
    const textOf = (f) => created.get(f) ?? (existsSync(f) ? readFileSync(f, 'utf8') : undefined);
    const specOf = (f) => `./${basename(f).replace(/\.ts$/, '.js')}`;
    const fromContracts = [...closure.fromContracts].map(([local, c]) => ({ local, spec: specOf(c.file), imported: c.imported }));
    const fromHomes = (target) =>
      closure.moved
        .map((m) => movedTo.get(keyOf(m)) ?? target)
        .flatMap((home, i) =>
          home === file ? [] : [{ local: closure.moved[i].name, spec: specOf(home), imported: closure.moved[i].name }],
        );
    const names = fresh.map((m) => m.name);
    const sharedTaken = clash
      ? (fresh.find((m) => taken.has(m.name) && taken.get(m.name) !== keyOf(m))?.name ?? 'a helper')
      : (takenIn(shared, textOf(shared), names, fromContracts) ??
        takenIn(file, textOf(file), [], [...fromContracts, ...fromHomes(shared)]));
    const fileTaken = sharedTaken && takenIn(file, textOf(file), names, [...fromContracts, ...fromHomes(file)]);
    if (fileTaken) {
      // Neither file has the name free: the group goes to its sub-area's file, or, already there, stays by name.
      // Only the records that need the name move: the rest of the group stays in its file.
      for (const m of reused) movedTo.delete(keyOf(m));
      const needs = recs.filter((r) => {
        const c = closureOf(
          REPO,
          roots.filter((x) => x.where.startsWith(`${r.path} `)),
        );
        return c.moved.some((m) => m.name === fileTaken) || c.fromContracts.has(fileTaken);
      });
      const offenders = needs.length ? needs : recs;
      const stay = offenders.filter((r) => r.fileDepth);
      for (const r of stay)
        for (const site of r.sites)
          planned.hand.push({ site, why: `helper ${fileTaken} clashes with another ${fileTaken} in this record file and its sub-area's` });
      return build(opts, {
        ...planned,
        records: planned.records
          .filter((r) => !stay.includes(r))
          .map((r) => {
            if (offenders.includes(r)) r.fileDepth = 2;
            return r;
          }),
      });
    }
    // Each import the group adds between two contracts files. One back to a file that already reaches the importer is a
    // cycle, and a schema read at the top of either file is then read before it is declared (svc-bank's shared file
    // importing `signed` from bank-ops-procedures, which imports `figures` from it).
    const edgesFor = (target) => {
      const homeOf = (m) => (fresh.includes(m) ? target : (movedTo.get(keyOf(m)) ?? target));
      return [
        ...[...closure.fromContracts.values()].map((c) => [file, c.file]),
        ...closure.moved.map((m) => [file, homeOf(m)]),
        ...(target === shared && fresh.length
          ? [
              ...[...closure.fromContracts.values()].map((c) => [shared, c.file]),
              ...closure.moved.filter((m) => !fresh.includes(m)).map((m) => [shared, homeOf(m)]),
            ]
          : []),
      ].filter(([a, b]) => a !== b && !importsOf(textOf(a)).has(b));
    };
    const cycleIn = (edges) => edges.find(([a, b]) => reaches(b, a, textOf, edges));
    // A group whose new helpers would close a cycle through the shared file (svc-pay's deposit-freeze inputs read the
    // `userIdSchema` an earlier run left in pay-founder-admin-procedures) keeps them beside its records instead, when
    // their names are free there; only a cycle that way too leaves the group by name, named.
    let target = sharedTaken ? file : shared;
    let cycle = cycleIn(edgesFor(target));
    if (cycle && target === shared && !takenIn(file, textOf(file), names, [...fromContracts, ...fromHomes(file)])) {
      const beside = cycleIn(edgesFor(file));
      if (!beside) [target, cycle] = [file, undefined];
    }
    if (cycle) {
      const [a, b] = cycle.map((f) => basename(f));
      for (const r of recs)
        for (const site of r.sites)
          planned.hand.push({ site, why: `its record would import ${b} into ${a}, which ${b} already imports: an import cycle` });
      return build(opts, { ...planned, records: planned.records.filter((r) => !recs.includes(r)) });
    }
    for (const m of fresh) {
      movedTo.set(keyOf(m), target);
      if (target === shared) taken.set(m.name, keyOf(m));
    }
    const placed = closure.moved.map((m) => ({ name: m.name, file: movedTo.get(keyOf(m)) }));
    created.set(file, writeRecords(opts, file, recs, { ...closure, moved: target === file ? fresh : [] }, placed, created.get(file)));
    if (target === shared && fresh.length) {
      // A helper this group sends to the shared file may read one an earlier group kept beside its own record (a name
      // clash put it there): the shared file imports it from that record file.
      const fromRecords = new Map();
      for (const m of closure.moved) {
        const home = movedTo.get(keyOf(m));
        if (home && home !== shared && !fresh.includes(m)) fromRecords.set(m.name, home);
      }
      created.set(shared, writeSchemas(opts, shared, { ...closure, moved: fresh, fromRecords }, created.get(shared)));
    }
    // Moved declarations: their old home imports them from contracts.
    for (const m of [...fresh, ...reused]) {
      if (m.inline || !m.q) continue;
      // Mid-port or for a door, the service's own declaration stays where it is: contracts gets a copy.
      if (routerKept && serviceFiles([m.q.file]).length) continue;
      const b = m.binding;
      const stmt = b.statement;
      if (b.kind === 'var' && b.declaration.declarations.length > 1) {
        problems.push(`${relative(REPO, m.q.file)}#${m.name}: shares its statement with other declarations; split it by hand first`);
        continue;
      }
      changes.edit(m.q.file, statementStart(m.q, stmt), statementEnd(m.q, stmt), '');
      changes.imp(m.q.file, contractsSpec(movedTo.get(keyOf(m))), b.kind === 'type' ? `type ${m.name}` : m.name);
      // Re-exported only for a file that imports it from here; anyone else reads it from contracts.
      if (b.exported && importersOf(m.q.file, m.name).length > 0)
        changes.of(m.q.file).exports.add(b.kind === 'type' ? `type ${m.name}` : m.name);
    }
    // The router: each procedure is mounted from its record.
    for (const r of recs) {
      const { p, node } = r.proc;
      const { reader } = r;
      // A door serves its records itself (its records test holds it to them), and a service mid-port keeps its router as
      // it is (callers only): only the callers move.
      if (opts.door || opts.callersOnly) {
        for (const s of r.sites) rewriteSite(changes, s, r.name, contractsSpec(file), !r.chain.input);
        done.push(r);
        continue;
      }
      changes.edit(p.file, node.start, node.end, `mountRecord(${r.name}, ${text(p, r.chain.handler)}, ${reader.name})`);
      changes.imp(p.file, contractsSpec(file), r.name);
      changes.imp(p.file, '@intafaced/contracts/procedure-mount', 'mountRecord');
      for (const i of reader.imports ?? [{ file: reader.file, name: reader.name }])
        if (i.file !== p.file) changes.imp(p.file, relImport(p.file, i.file), i.name);
      for (const s of r.sites) rewriteSite(changes, s, r.name, contractsSpec(file), !r.chain.input);
      done.push(r);
    }
  }
  for (const e of planned.existing) for (const s of e.sites) rewriteSite(changes, s, e.name, contractsSpec(e.file));
  tables(changes, planned, done);
  fanIn(changes, planned, done, callText);
  const kinds = new Map(planned.existing.map((e) => [e.name, recordKind(e.file, e.name)]));
  wrapperIn(changes, planned, done, (name) => kinds.get(name));
  toolFormsIn(changes);
  return { changes, created, problems, done };
}

/**
 * A table whose every entry moved: its calls send the entry's record (`founderRecordRead`, the page's own reader kept).
 * A table with an entry that stays keeps every entry as it was, each named, since one call sends them all.
 */
function tables(changes, planned, done) {
  for (const [file, f] of changes.files) {
    for (const [table, { site, moved }] of f.tables ?? []) {
      const entries = table.properties.filter(
        (pr) => pr.type === 'Property' && pr.value.type === 'ObjectExpression' && pr.value.properties.some((x) => keyOf(x) === 'procedure'),
      );
      const takesNone = moved.filter((m) => m.takesNone).length;
      const why =
        moved.length < entries.length
          ? `${site.tableName} has an entry that stays, and one call sends them all`
          : takesNone && takesNone < moved.length
            ? `${site.tableName} mixes calls that take no input with calls that do`
            : undefined;
      if (why) {
        f.edits = f.edits.filter((e) => !moved.some((m) => m.edit === e));
        const back = new Set(moved.map((m) => m.s));
        for (const r of [...done, ...planned.existing]) r.sites = r.sites.filter((s) => !back.has(s));
        for (const s of back) planned.hand.push({ site: s, why });
        continue;
      }
      const p = load(file);
      for (const d of site.dispatchers) {
        const a = d.arguments;
        const input = takesNone ? 'undefined' : text(p, a[4]);
        const rest = [text(p, a[0]), `${text(p, a[2].object)}.record`, input, text(p, a[5]), ...(a[6] ? [text(p, a[6])] : [])];
        changes.edit(file, d.start, d.end, `founderRecordRead(${rest.join(', ')})`);
      }
      changes.imp(file, site.founderCallFrom, 'founderRecordRead');
      // The calls the table sent by name are sent by record now.
      planned.hand = planned.hand.filter((h) => !site.dispatchers.some((d) => d.start === h.site.node.start && h.site.file === file));
    }
  }
}

/** A portal list caller's row schema (its answer is a page of it), or undefined. */
export const listItemOf = (s) => (toolShape(s) ? toolItem(s) : undefined);
/** A record's answer as written: its schema, or for a portal list, the page of the row schema its callers parsed. */
const outputText = (r, schema) => (r.chain.outputPage ? pageOf(schema) : schema);
/** The page a list answers with, as the portal's tool parsed it (`page` in apps/customer/src/features/pay/portal/schemas.ts). */
export const pageOf = (item) => `z.object({ items: z.array(${item}), nextCursor: z.string().nullable() })`;

/** The schema a caller parses the answer with, or undefined. */
export function schemaArgOf(s) {
  // A wrapper keeps its own schema, read through `callAs`.
  if (s.shape === 'desk-read' || s.shape === 'ops-entry' || s.shape === 'write-spec' || s.shape === 'wrapper') return undefined;
  const a = s.node.arguments;
  if (s.shape === 'founderCall') return s.reader ? undefined : a[5]?.arguments?.[0];
  if (s.shape === 'payCall') return s.reader ? undefined : a[4]?.arguments?.[0];
  if (BUSINESS_FORMS[s.shape]) return a[2];
  if (toolShape(s)) return toolSchema(s);
  // useBankRead's schema is `bankReads[path]` in its own file (`s.schema`); founderEdgeCall parses nothing.
  if (s.shape === 'useBankRead' || s.shape === 'founderEdgeCall') return undefined;
  return a[3];
}

/** Each wrapper's record form, and what it keeps of the call after its record and input. */
const RECORD_FORMS = {
  founderEdgeCall: (s, a) => ({ fn: 'founderEdgeRecordCall', head: [a[0]], tail: a.slice(5) }),
  payCall: (s, a) => (s.reader ? { fn: 'payRecordRead', head: [a[0]], tail: [a[4]] } : { fn: 'payRecordCall', head: [a[0]], tail: [] }),
  useBankRead: (s, a) => ({ fn: 'useBankRecord', head: [], tail: a.slice(2) }),
};

// zod methods that check or change an answer beyond its shape: a record's `output` copies the router's shape, so a caller's
// own check would be lost with its schema. Such a call stays as it is, for its check to move to `accept` by hand.
const ANSWER_CHECKS = new Set(['refine', 'superRefine', 'transform', 'pipe', 'check', 'preprocess', 'catch', 'overwrite']);

/** The checks a caller's schema makes on the answer: `name (file:line)`, following the app's own consts and imports. */
/** A check that changes the answer, not only refuses one: the caller's schema can't stand as an `accept`. */
const CHANGES_ANSWER = /^\.(transform|pipe|preprocess|catch|overwrite)\(\)/;
const CUSTOMER_SRC = '/apps/customer/src/';
/** The customer app's API client file, in the same checkout as `file`. */
const customerApi = (file) => `${file.slice(0, file.indexOf(CUSTOMER_SRC))}${CUSTOMER_SRC}shared/api.ts`;

/** Whether a site with answer checks moves through `callAs`: a customer `query`/`mutate` whose schema only refuses. */
export function checkedCall(s, arg, checks) {
  return (
    (s.shape === 'query' || s.shape === 'mutate') &&
    Boolean(arg) &&
    s.file.includes(CUSTOMER_SRC) &&
    !checks.some((c) => CHANGES_ANSWER.test(c))
  );
}

/**
 * Whether a portal tool site with answer checks moves to its tool's checked form: only zod checks it writes itself
 * (`.refine()`); a schema built by its own function, or one that changes the answer, stays for its own move.
 */
export const checkedToolCall = (s, checks) => checkedTool(s) && checks.every((c) => /^\.(refine|superRefine|check)\(\)/.test(c));

export function answerChecks(p, node, seen = new Set()) {
  const found = [];
  const visit = (q, n) => {
    if (!n || seen.has(`${q.file}:${n.start}`)) return;
    seen.add(`${q.file}:${n.start}`);
    walk(n, (m) => {
      if (
        m.type === 'CallExpression' &&
        m.callee.type === 'MemberExpression' &&
        !m.callee.computed &&
        ANSWER_CHECKS.has(m.callee.property.name)
      )
        found.push(
          `.${m.callee.property.name}() (${relative(REPO, q.file)}:${q.src.slice(0, m.callee.property.start).split('\n').length})`,
        );
      if (m.type !== 'Identifier') return;
      const parent = q.parents.get(m);
      if (parent?.type === 'MemberExpression' && parent.property === m && !parent.computed) return;
      if (parent?.type === 'Property' && parent.key === m && !parent.computed && !parent.shorthand) return;
      const b = bindingOf(q, m, m.name);
      if (b.kind === 'var' && b.declarator.init) visit(q, b.declarator.init);
      else if (b.kind === 'import' && b.from.startsWith('.')) {
        const file = resolveRelative(q.file, b.from);
        if (!file || !file.includes('/apps/')) return;
        const r = load(file);
        const d = bindingOf(r, r.program, b.imported);
        if (d.kind === 'var' && d.declarator.init) visit(r, d.declarator.init);
      }
    });
  };
  // A schema built by the caller's own function (`verificationStatus(userId, limit)`) checks against what it captures:
  // whatever its body says, its answer check is the caller's, so the call stays for that check to move to accept. A
  // builder imported from contracts (`payPageSchema(row)`) is the one the routers use, not the caller's: its arguments are
  // read like any schema.
  let top = node;
  while (top?.type === 'TSAsExpression' || top?.type === 'TSSatisfiesExpression' || top?.type === 'ParenthesizedExpression')
    top = top.expression;
  if (
    top?.type === 'CallExpression' &&
    top.callee.type === 'Identifier' &&
    !/^@intafaced\/contracts(\/|$)/.test(bindingOf(p, top.callee, top.callee.name).from ?? '')
  )
    found.push(`${top.callee.name}() builds the schema (${relative(REPO, p.file)}:${p.src.slice(0, top.start).split('\n').length})`);
  visit(p, node);
  return [...new Set(found)];
}

/** The record call that replaces one caller: `recv.call(RECORD, input, opts)` or `founderRecordCall/Read(...)`. */
export function callText(changes, s, name, takesNone) {
  const p = load(s.file);
  const n = s.node;
  const a = n.arguments;
  const input = takesNone ? 'undefined' : text(p, inputArg(s));
  if ((s.shape === 'query' || s.shape === 'mutate') && s.checked) {
    // The customer app imports its own files with no extension.
    changes.imp(s.file, relImport(s.file, customerApi(s.file)).replace(/\.js$/, ''), 'callAs');
    const rest = [input, s.checked, ...(a[4] ? [text(p, a[4])] : [])];
    return `callAs(${text(p, n.callee.object)}, ${name}, ${rest.join(', ')})`;
  }
  if (s.shape === 'query' || s.shape === 'mutate') {
    const recv = text(p, n.callee.object);
    const rest = [input, ...(a[4] ? [text(p, a[4])] : [])];
    return `${recv}.call(${name}, ${rest.join(', ')})`;
  }
  if (BUSINESS_FORMS[s.shape]) return businessCall(p, s, name, input);
  if (toolShape(s)) {
    const { fn, args: rest } = toolCall(changes, s, name, input);
    return `${fn}(${rest.map((x) => (typeof x === 'string' ? x : text(p, x))).join(', ')})`;
  }
  if (RECORD_FORMS[s.shape]) {
    const { fn, head, tail } = RECORD_FORMS[s.shape](s, a);
    if (s.wrapperFrom) changes.imp(s.file, s.wrapperFrom, fn);
    return `${fn}(${[...head.map((x) => text(p, x)), name, input, ...tail.map((x) => text(p, x))].join(', ')})`;
  }
  // A page's own reader stays, reading the record's parsed answer into its view (`founderRecordRead`).
  const fn = s.reader ? 'founderRecordRead' : 'founderRecordCall';
  const rest = [text(p, a[0]), name, input, ...(s.reader ? [text(p, a[5])] : []), ...(a[6] ? [text(p, a[6])] : [])];
  changes.imp(s.file, s.founderCallFrom, fn);
  return `${fn}(${rest.join(', ')})`;
}

/** One caller, rewritten to its record. */
export function rewriteSite(changes, s, name, spec, takesNone) {
  const n = s.node;
  // The hand schema the caller parsed with: its types now come from the record (`retype`).
  const schemaArg = schemaArgOf(s);
  // A checked call keeps its schema as the caller wrote it (`callAs`), so it is not retyped from the record.
  if (schemaArg?.type === 'Identifier' && !s.checked) {
    const f = changes.of(s.file);
    f.schemas ??= new Map();
    if (!f.schemas.has(schemaArg.name)) f.schemas.set(schemaArg.name, new Set());
    f.schemas.get(schemaArg.name).add(name);
  }
  if (s.shape === 'desk-read') {
    // `module: 'x', ... procedure: 'y'` becomes `...readOf(RECORD)` where `procedure` was (`toolOf` for an operator tool,
    // its `edgeModule` and `kind` dropped too); the record names them.
    const props = s.obj.properties;
    for (const d of s.drop) {
      const i = props.indexOf(d);
      // To the next key; the last key goes from the end of the one before it, so no comma is left behind.
      if (props[i + 1]) changes.edit(s.file, d.start, props[i + 1].start, '');
      else changes.edit(s.file, props[i - 1].end, d.end, '');
    }
    changes.edit(s.file, n.start, n.end, `...${s.helper}(${name})`);
    if (s.helperFrom) changes.imp(s.file, s.helperFrom, s.helper);
    changes.imp(s.file, spec, name);
    return;
  }
  if (s.shape === 'ops-entry') {
    // The entry names its record; its table's calls are sent by record once every entry of the table has moved (`tables`).
    const edit = { start: n.start, end: n.end, text: `record: ${name}` };
    changes.of(s.file).edits.push(edit);
    changes.imp(s.file, spec, name);
    const f = changes.of(s.file);
    f.tables ??= new Map();
    if (!f.tables.has(s.table)) f.tables.set(s.table, { site: s, moved: [] });
    f.tables.get(s.table).moved.push({ s, edit, takesNone });
    return;
  }
  if (s.shape === 'write-spec') {
    // `procedure: 'x.y'` becomes `record: RECORD`: the dialog sends a spec by its record (features/money/write-flow.ts).
    changes.edit(s.file, n.start, n.end, `record: ${name}`);
    changes.imp(s.file, spec, name);
    return;
  }
  // One caller of a wrapper that takes its call name: written once every caller has its record (`wrapperIn`).
  if (s.wrapper) return wrapperBranch(changes, s, name, spec);
  // One value of a call named by a `? :` or a closed set: written once every value has its record (`fanIn`).
  if (s.fan) return fanBranch(changes, s, name, spec, takesNone);
  changes.edit(s.file, n.start, n.end, callText(changes, s, name, takesNone));
  changes.imp(s.file, spec, name);
}

/** The record file's text: its header and imports, the moved declarations, then one `defineProcedure` per call. */
function writeRecords(opts, file, recs, closure, placed, pending) {
  const fresh = pending === undefined && !existsSync(file);
  const svc = opts.service;
  const lines = [];
  const imports = new Map();
  const imp = (spec, name) => {
    if (!imports.has(spec)) imports.set(spec, new Set());
    imports.get(spec).add(name);
  };
  imp('zod', 'z');
  imp('./procedure.js', 'defineProcedure');
  if (recs.some((r) => !r.chain.input)) imp('./procedure.js', 'NO_INPUT');
  for (const [local, c] of closure.fromContracts) {
    if (c.file === file) continue;
    imp(
      `./${basename(c.file).replace(/\.ts$/, '.js')}`,
      `${c.typeOnly ? 'type ' : ''}${c.imported === local ? local : `${c.imported} as ${local}`}`,
    );
  }
  for (const [spec, names] of closure.fromPackages) for (const n of names) if (!(spec === 'zod' && n === 'z')) imp(spec, n);
  for (const m of placed) if (m.file !== file) imp(`./${basename(m.file).replace(/\.ts$/, '.js')}`, m.name);
  const importText = [...imports]
    .map(
      ([spec, names]) =>
        `import { ${[...names].sort((x, y) => (x === 'z' ? -1 : y === 'z' ? 1 : x.localeCompare(y))).join(', ')} } from '${spec}';`,
    )
    .join('\n');
  const segs = recs[0].path.split('.');
  const area = segs.slice(0, Math.min(recs[0].fileDepth ?? 1, segs.length - 1)).join('.');
  if (fresh) {
    lines.push(
      importText,
      '',
      MARK,
      opts.callersOnly
        ? `/** ${svc} \`${area}.*\`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */`
        : `/** ${svc} \`${area}.*\`, one record per call: ${svc} mounts each (\`mountRecord\`) and every app caller calls it by its record. */`,
      '',
    );
    lines.push(`const base = { service: '${svc}', module: '${opts.module}', transport: 'trpc' } as const;`, '');
  }
  for (const m of closure.moved) lines.push(m.text, '');
  for (const r of recs) {
    const { p } = r.proc;
    const doc = leadingDoc(p, r.proc.prop?.type === 'Property' ? r.proc.prop : r.proc.node);
    if (doc) lines.push(doc.replace(/^\s+\*/gm, ' *'));
    lines.push(
      `export const ${r.name} = defineProcedure({`,
      '  ...base,',
      `  name: '${opts.module}.${r.path}',`,
      `  kind: '${r.chain.kind}',`,
      `  path: '${r.path}',`,
      `  access: ${r.chain.guard.text},`,
      `  refusals: ${r.reader.refusals ? JSON.stringify(r.reader.refusals).replace(/"/g, "'").replace(/','/g, "', '").replace(/':'/g, "': '") : '{}'},`,
      `  input: ${r.chain.input ? exactInput(p, r.chain.input, lines, r.path) : 'NO_INPUT'},`,
      `  output: ${outputText(r, text(r.chain.outputP ?? p, r.chain.output))},`,
      `  samples: ${r.chain.input ? "[{ verdict: 'accept', input: {} }, { verdict: 'refuse', input: 42 }]" : "[{ verdict: 'accept' }]"},`,
      '});',
      '',
    );
  }
  let body = lines.join('\n');
  if (!fresh) {
    // Appending to a file the codemod wrote before: the new imports go on top, merged with what it has.
    const old = pending ?? readFileSync(file, 'utf8');
    body = `${mergeImports(old, imports)}\n${body}`;
  }
  return body;
}

/** The service's shared schema file: every declaration a record reads that lived in the service, moved here once. */
export function writeSchemas(opts, file, closure, pending) {
  const fresh = pending === undefined && !existsSync(file);
  const imports = new Map([['zod', new Set(['z'])]]);
  const self = `./${basename(file).replace(/\.ts$/, '.js')}`;
  const imp = (spec, name) => {
    if (spec === self) return; // a declaration already in this file is read where it stands, never imported from itself
    if (!imports.has(spec)) imports.set(spec, new Set());
    imports.get(spec).add(name);
  };
  for (const [local, c] of closure.fromContracts)
    imp(
      `./${basename(c.file).replace(/\.ts$/, '.js')}`,
      `${c.typeOnly ? 'type ' : ''}${c.imported === local ? local : `${c.imported} as ${local}`}`,
    );
  for (const [spec, names] of closure.fromPackages) for (const n of names) if (!(spec === 'zod' && n === 'z')) imp(spec, n);
  for (const [name, home] of closure.fromRecords ?? []) imp(`./${basename(home).replace(/\.ts$/, '.js')}`, name);
  const decls = closure.moved.map((m) => `${m.inline ? m.text.replace(/\nconst /, '\nexport const ') : m.text}\n`).join('\n');
  if (fresh) {
    const head = [...imports].map(([spec, names]) => `import { ${[...names].join(', ')} } from '${spec}';`).join('\n');
    const why = opts.callersOnly
      ? `copied from the service's router while its Rust port is in flight (the router keeps its own until the port's switch)`
      : 'moved from the service so the records and every caller read one copy';
    return `${head}\n\n${MARK}\n/** The schemas ${opts.service}'s records share, ${why}. */\n\n${decls}`;
  }
  return `${mergeImports(pending ?? readFileSync(file, 'utf8'), imports)}\n${decls}`;
}

/**
 * `.prefault(v)`, which the record's export refuses, as the `.default` it means: zod hands a default back unparsed, so the
 * default is the schema's own parse of `v`, and an absent input gets the same value it gets today.
 */
function exactInput(p, node, lines, path) {
  const src = text(p, node);
  const outer =
    node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'prefault'
      ? node
      : undefined;
  if (outer) {
    const local = `${path.replace(/\.(\w)/g, (_, c) => c.toUpperCase())}Input`;
    lines.splice(lines.length - (lines.at(-1)?.startsWith('/**') ? 1 : 0), 0, `const ${local} = ${text(p, outer.callee.object)};`, '');
    return `${local}.default(${local}.parse(${text(p, outer.arguments[0])}))`;
  }
  let nested = false;
  walk(node, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'prefault') nested = true;
  });
  if (nested) throw new Error(`${path}: a .prefault() inside the input; move it by hand`);
  return src;
}

function mergeImports(old, imports) {
  let out = old;
  // A name the file already imports (from anywhere, as a value or a type) is not imported twice.
  const have = new Set(
    [...old.matchAll(/^import (?:type )?\{([^}]*)\} from/gm)].flatMap((m) =>
      m[1].split(',').map((x) =>
        x
          .trim()
          .replace(/^type /, '')
          .split(/ as /)
          .pop(),
      ),
    ),
  );
  for (const [spec, wanted] of imports) {
    const names = new Set(
      [...wanted].filter(
        (n) =>
          !have.has(
            n
              .replace(/^type /, '')
              .split(/ as /)
              .pop(),
          ),
      ),
    );
    if (names.size === 0) continue;
    const re = new RegExp(`import \\{([^}]*)\\} from '${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';`);
    const m = re.exec(out);
    if (m) {
      const have = new Set(
        m[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const n of names) have.add(n);
      out = out.replace(re, `import { ${[...have].join(', ')} } from '${spec}';`);
    } else {
      const lastImport = [...out.matchAll(/^import [^;]+;\n/gm)].at(-1);
      const at = lastImport ? lastImport.index + lastImport[0].length : 0;
      out = `${out.slice(0, at)}import { ${[...names].join(', ')} } from '${spec}';\n${out.slice(at)}`;
    }
  }
  return out;
}

/** Writes every change, adds the imports, drops the imports nothing reads any more, and formats what it touched. */
function write(result) {
  const touched = [];
  // What each changed file imports before its calls move: a namespace member it read (`s.schema`) goes with the call.
  const imported = new Map([...result.changes.files.keys()].filter((f) => !f.startsWith(CONTRACTS)).map((f) => [f, importedFrom(f)]));
  for (const [file, body] of result.created) {
    // What it appends starts each `assetId` from `assetIdSchema`; what the file already held stays as it was.
    writeFileSync(file, brandAssetIds(body, existsSync(file) ? unbranded(readFileSync(file, 'utf8')).length : 0));
    touched.push(file);
  }
  for (const [file, ch] of result.changes.files) {
    const p = load(file);
    let src = applyEdits(p.src, ch.edits);
    src = mergeImports(src, ch.imports);
    if (ch.exports.size) src = `${src.trimEnd()}\nexport { ${[...ch.exports].join(', ')} };\n`;
    writeFileSync(file, src);
    forget(file);
    touched.push(file);
  }
  for (const [file, ch] of result.changes.files) if (ch.schemas) retype(file, ch.schemas);
  // Each prune can leave the other something unread (a schema gone frees the list it enumerated), so both run until neither does.
  for (const file of touched) {
    if (file.startsWith(CONTRACTS)) continue;
    for (let was = ''; was !== readFileSync(file, 'utf8');) {
      was = readFileSync(file, 'utf8');
      pruneSchemas(file);
      pruneBuilders(file);
    }
  }
  // A schema a moved caller imported from another file of its app may now have no importer: that file is pruned too.
  const sources = new Set();
  for (const file of touched) {
    if (file.startsWith(CONTRACTS)) continue;
    const before = imported.get(file) ?? importedFrom(file);
    pruneImports(file);
    const after = importedFrom(file);
    // A touched file too: it was pruned before this caller stopped reading it.
    for (const [name, src] of before) if (!after.has(name) && src) sources.add(src);
  }
  for (const file of touched) if (file.startsWith(CONTRACTS)) pruneImports(file);
  // A re-export kept at plan time for an importer whose read then moved to contracts serves no one, once that import is gone.
  for (const [file, ch] of result.changes.files) if (ch.exports.size) pruneReExports(file, ch.exports, (name) => importersOf(file, name));
  for (const src of sources) {
    const was = readFileSync(src, 'utf8');
    pruneSchemas(src);
    if (readFileSync(src, 'utf8') !== was) {
      pruneImports(src);
      if (!touched.includes(src)) touched.push(src);
    }
  }
  if (touched.length)
    execFileSync(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...touched], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  return touched;
}

/**
 * The other files that import `name` from `file`, the files a re-export of it must keep serving. A relative or `@/`
 * import counts only when it resolves to `file` (two apps' `schemas.ts` are not one); a package import by its module name.
 */
function importersOf(file, name) {
  const stem = basename(file).replace(/\.tsx?$/, '');
  try {
    // Only code files are read (a README that names it is no importer), and a failure is thrown, never read as "no
    // importer": a swallowed parse error once deleted schemas still read.
    return execFileSync('git', ['grep', '-l', '-w', name, '--', 'apps', 'packages', 'services'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
      .split('\n')
      .filter(
        (f) => /\.(c|m)?[jt]sx?$/.test(f) && !f.endsWith('.d.ts') && join(REPO, f) !== file && importsFile(join(REPO, f), file, stem, name),
      );
  } catch (e) {
    // git grep exits 1 when nothing matches: that alone is "no importer".
    if (e.status === 1 && !e.stdout) return [];
    throw e;
  }
}

/**
 * True when `from` imports `name` from `file`: by name, as a member it reads through `import * as ns`, or by
 * `export { name } from`. A relative or `@/` module counts when it resolves to `file`; a package one by its last segment `stem`.
 */
export function importsFile(from, file, stem, name) {
  const app = from.match(/^(.*\/apps\/[^/]+)\//)?.[1];
  const isFile = (spec) =>
    spec.startsWith('.')
      ? resolveRelative(from, spec) === file
      : spec.startsWith('@/') && app
        ? resolveRelative(join(app, 'src', 'x.ts'), `./${spec.slice(2)}`) === file
        : new RegExp(`/${stem}(\\.js)?$`).test(spec);
  forget(from);
  const p = load(from);
  for (const stmt of p.program.body) {
    if (!stmt.source || !isFile(stmt.source.value)) continue;
    if (stmt.type === 'ExportAllDeclaration') return true;
    for (const sp of stmt.specifiers ?? []) {
      if (stmt.type === 'ExportNamedDeclaration' && (sp.local.name ?? sp.local.value) === name) return true;
      if (sp.type === 'ImportSpecifier' && (sp.imported.name ?? sp.imported.value) === name) return true;
      if (sp.type === 'ImportNamespaceSpecifier') {
        let read = false;
        walk(p.program, (n) => {
          if (read) return false;
          if (
            n.type === 'MemberExpression' &&
            !n.computed &&
            n.object.type === 'Identifier' &&
            n.object.name === sp.local.name &&
            n.property.name === name
          )
            read = true;
        });
        if (read) return true;
      }
      if (sp.type === 'ImportDefaultSpecifier' && name === 'default') return true;
    }
  }
  return false;
}

/**
 * A caller's hand schema, once no call parses with it: each type read from it (`z.infer<typeof s>`, `z.output<...>`)
 * becomes the record's (`ProcedureOutput<typeof RECORD>`), and a re-export of it no other file imports is dropped, so
 * the copy is left with no reader and the dead-code step deletes it. A schema two records parsed with stays.
 */
function retype(file, schemas) {
  forget(file);
  const p = load(file);
  const edits = [];
  let used = false;
  const importers = (name) => importersOf(file, name);
  // A schema the file still reads as a value (another call, a parse, a field of another schema) still says what its type
  // is: only one read by nothing but its moved call becomes that call's answer.
  const valueReads = (name) => {
    let n = 0;
    walk(p.program, (node, parent) => {
      if (node.type === 'TSTypeQuery') return false;
      if (node.type !== 'Identifier' || node.name !== name) return;
      if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
      if (parent?.type === 'ExportSpecifier' || parent?.type === 'ImportSpecifier') return;
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent?.type === 'Property' && parent.key === node && !parent.shorthand) return;
      n++;
    });
    return n;
  };
  const kept = new Set();
  for (const [schema, recs] of schemas) {
    if (recs.size !== 1) continue;
    if (valueReads(schema) > 0 || importers(schema).length > 0) {
      kept.add(schema);
      continue;
    }
    const rec = [...recs][0];
    walk(p.program, (n) => {
      if (n.type !== 'TSTypeReference' || n.typeName?.type !== 'TSQualifiedName') return;
      const q = n.typeName;
      if (q.left?.name !== 'z' || !['infer', 'output', 'TypeOf'].includes(q.right?.name)) return;
      const arg = (n.typeArguments ?? n.typeParameters)?.params?.[0];
      if (arg?.type !== 'TSTypeQuery' || arg.exprName?.name !== schema) return;
      edits.push({ start: n.start, end: n.end, text: `ProcedureOutput<typeof ${rec}>` });
      used = true;
      return false;
    });
  }
  // `export { schema }` / `export { schema as x }` that nothing else imports.
  const retyped = new Set([...schemas].filter(([schema, recs]) => recs.size === 1 && !kept.has(schema)).map(([schema]) => schema));
  for (const stmt of p.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.declaration || stmt.source) continue;
    const keep = stmt.specifiers.filter((sp) => !retyped.has(sp.local.name) || importers(sp.exported.name ?? sp.exported.value).length > 0);
    if (keep.length === stmt.specifiers.length) continue;
    edits.push(
      keep.length === 0
        ? { start: statementStart(p, stmt), end: statementEnd(p, stmt), text: '' }
        : { start: stmt.start, end: stmt.end, text: `export { ${keep.map((sp) => text(p, sp)).join(', ')} };` },
    );
  }
  if (!edits.length) return;
  let src = applyEdits(p.src, edits);
  if (used) src = mergeImports(src, new Map([['@intafaced/contracts/procedure', new Set(['type ProcedureOutput'])]]));
  writeFileSync(file, src);
  forget(file);
}

/**
 * A schema value with nothing to run but zod: a name, a member of one, a literal, an object, array or function of such,
 * and calls on `z` or on a top-level const that is itself such a schema (`z.object({...})`, `ref.nullable()`).
 * Removing one nobody reads changes nothing.
 */
function pureSchema(n, schemas = new Set(['z'])) {
  const pure = (x) => pureSchema(x, schemas);
  if (!n) return true;
  switch (n.type) {
    case 'Identifier':
    case 'Literal':
    case 'TemplateLiteral':
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return true;
    case 'MemberExpression':
      return !n.computed && pure(n.object);
    case 'ObjectExpression':
      return n.properties.every((x) => (x.type === 'SpreadElement' ? pure(x.argument) : !x.computed && pure(x.value)));
    case 'ArrayExpression':
      return n.elements.every((x) => pure(x?.type === 'SpreadElement' ? x.argument : x));
    case 'CallExpression': {
      let root = n.callee;
      while (root.type === 'MemberExpression' || root.type === 'CallExpression')
        root = root.type === 'MemberExpression' ? root.object : root.callee;
      return (
        root.type === 'Identifier' &&
        schemas.has(root.name) &&
        n.callee.type === 'MemberExpression' &&
        pure(n.callee.object) &&
        n.arguments.every((x) => pure(x))
      );
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return pure(n.expression);
    default:
      return false;
  }
}

/**
 * Removes the file's own top-level schema consts no one reads any more: a call that moved to its record no longer
 * passes the answer schema it was handed, and the const that held it is left behind. Only a single declaration whose
 * value is a pure schema goes, and again while removing one leaves another unread; an exported one no other file
 * imports loses its `export` while its own file still reads it.
 */
export function pruneSchemas(file) {
  for (;;) {
    forget(file);
    const p = load(file);
    const edits = [];
    const decl = (top) => {
      const stmt = top.type === 'ExportNamedDeclaration' && top.declaration ? top.declaration : top;
      return stmt.type === 'VariableDeclaration' && stmt.kind === 'const' && stmt.declarations.length === 1
        ? stmt.declarations[0]
        : undefined;
    };
    // The file's own schema consts, to a fixpoint: a const built on another (`ref.nullable()`) is one too, and so is one
    // built on a schema it imports by a schema's name (`decimalSchema.nullable()`): reading a binding runs nothing.
    const schemas = new Set(['z']);
    for (const top of p.program.body)
      if (top.type === 'ImportDeclaration')
        for (const sp of top.specifiers ?? []) if (/[sS]chema$/.test(sp.local.name)) schemas.add(sp.local.name);
    for (let grew = true; grew;) {
      grew = false;
      for (const top of p.program.body) {
        const d = decl(top);
        if (d?.id.type === 'Identifier' && !schemas.has(d.id.name) && d.init?.type === 'CallExpression' && pureSchema(d.init, schemas)) {
          schemas.add(d.id.name);
          grew = true;
        }
      }
    }
    for (const top of p.program.body) {
      // An exported one counts only once no other file imports it: its importers were the calls that moved.
      const exported = top.type === 'ExportNamedDeclaration' && top.declaration;
      const stmt = exported ? top.declaration : top;
      if (stmt.type !== 'VariableDeclaration' || stmt.kind !== 'const' || stmt.declarations.length !== 1) continue;
      const d = stmt.declarations[0];
      // A zod call or an alias of a name, never a function or a literal: those may be an entry a framework reads.
      const kind = d.init?.type;
      if (d.id.type !== 'Identifier' || !/^(CallExpression|Identifier|MemberExpression)$/.test(kind ?? '') || !pureSchema(d.init, schemas))
        continue;
      if (exported && importersOf(file, d.id.name).length) continue;
      const read = usedOutside(p, d.id.name, [{ start: top.start, end: top.end }]);
      if (read && exported) edits.push({ start: top.start, end: stmt.start, text: '' });
      else if (!read) edits.push({ start: statementStart(p, top), end: statementEnd(p, top), text: '' });
    }
    if (!edits.length) return;
    writeFileSync(file, applyEdits(p.src, edits));
  }
}

/** A literal, or one read `as const`. */
const plain = (n) => n?.type === 'Literal' || (n?.type === 'TSAsExpression' && n.expression.type === 'Literal');

/**
 * The consts only the moved calls read: a router's procedure builder (`scopedProcedure('admin:read', guards)`), the
 * literal guard object it took, or a caller's literal list a removed schema enumerated (`['a', 'b'] as const`). A name
 * read anywhere else in the file, or exported, stays.
 */
export function pruneBuilders(file) {
  for (;;) {
    forget(file);
    const p = load(file);
    const edits = [];
    walk(p.program, (n, parent) => {
      if (n.type !== 'VariableDeclaration' || n.kind !== 'const' || n.declarations.length !== 1) return;
      if (parent?.type === 'ExportNamedDeclaration' || /For(In|Of)?Statement$/.test(parent?.type ?? '')) return false;
      const d = n.declarations[0];
      const init = d.init?.type === 'TSAsExpression' ? d.init.expression : d.init;
      const builder = init?.type === 'CallExpression' && init.callee.type === 'Identifier' && /Procedure(For)?$/.test(init.callee.name);
      const guard =
        init?.type === 'ObjectExpression' &&
        init.properties.length > 0 &&
        init.properties.every((q) => q.type === 'Property' && !q.computed && plain(q.value));
      const list = init?.type === 'ArrayExpression' && init.elements.length > 0 && init.elements.every(plain);
      if (d.id.type !== 'Identifier' || !(builder || guard || list)) return false;
      if (!usedOutside(p, d.id.name, [{ start: n.start, end: n.end }]))
        edits.push({ start: statementStart(p, n), end: statementEnd(p, n), text: '' });
      return false;
    });
    if (!edits.length) return;
    writeFileSync(file, applyEdits(p.src, edits));
  }
}

/** Each name a file imports from a file of its own app (`./x`, `@/x`), with that file. */
export function importedFrom(file) {
  forget(file);
  const p = load(file);
  const app = file.match(/^(.*\/apps\/[^/]+)\//)?.[1];
  const out = new Map();
  for (const stmt of p.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const spec = stmt.source.value;
    const src =
      spec.startsWith('@/') && app ? resolveRelative(join(app, 'src', 'x.ts'), `./${spec.slice(2)}`) : resolveRelative(file, spec);
    for (const sp of stmt.specifiers ?? []) {
      out.set(sp.local.name, src);
      // `import * as s`: each member read (`s.disputeSchema`) is an import of its own, so a schema whose last reader moved is seen.
      if (sp.type === 'ImportNamespaceSpecifier')
        walk(p.program, (n) => {
          if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === sp.local.name)
            out.set(`${sp.local.name}.${n.property.name}`, src);
        });
    }
  }
  return out;
}

/**
 * Drops from a file's `export { ... }` each of `names` (as written: `x` or `type x`) that `importers(name)` says no
 * other file imports any more; the statement goes when it keeps none.
 */
export function pruneReExports(file, names, importers) {
  forget(file);
  const p = load(file);
  const bare = new Set([...names].map((n) => n.replace(/^type /, '')));
  const edits = [];
  for (const stmt of p.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.declaration || stmt.source) continue;
    const keep = stmt.specifiers.filter((sp) => !bare.has(sp.local.name) || importers(sp.exported.name ?? sp.exported.value).length > 0);
    if (keep.length === stmt.specifiers.length) continue;
    edits.push(
      keep.length === 0
        ? { start: statementStart(p, stmt), end: statementEnd(p, stmt), text: '' }
        : { start: stmt.start, end: stmt.end, text: `export { ${keep.map((sp) => text(p, sp)).join(', ')} };` },
    );
  }
  if (!edits.length) return;
  writeFileSync(file, applyEdits(p.src, edits));
  forget(file);
}

/** Removes named import specifiers a file no longer reads (only those: a side-effect import stays). */
export function pruneImports(file) {
  forget(file);
  const p = load(file);
  const edits = [];
  for (const stmt of p.program.body) {
    if (stmt.type !== 'ImportDeclaration' || !stmt.specifiers?.length) continue;
    const keep = stmt.specifiers.filter((s) => usedOutside(p, s.local.name, [{ start: stmt.start, end: stmt.end }]));
    if (keep.length === stmt.specifiers.length) continue;
    if (keep.length === 0) {
      edits.push({ start: stmt.start, end: statementEnd(p, stmt), text: '' });
      continue;
    }
    const def = keep.find((s) => s.type === 'ImportDefaultSpecifier');
    const ns = keep.find((s) => s.type === 'ImportNamespaceSpecifier');
    const named = keep.filter((s) => s.type === 'ImportSpecifier').map((s) => text(p, s));
    const head = stmt.importKind === 'type' ? 'import type ' : 'import ';
    const parts = [def ? def.local.name : null, ns ? text(p, ns) : null, named.length ? `{ ${named.join(', ')} }` : null].filter(Boolean);
    edits.push({ start: stmt.start, end: stmt.end, text: `${head}${parts.join(', ')} from '${stmt.source.value}';` });
  }
  if (edits.length) {
    writeFileSync(file, applyEdits(p.src, edits));
    forget(file);
  }
}

/**
 * A service the door now serves in Rust: its TypeScript router, read from the commit before it was deleted, gives each
 * record's schemas (the door's inputs were generated from them, and its answers are replayed against them), written back
 * for this run only and deleted after it.
 */
function withRouterFrom(opts, fn) {
  if (!opts.fromRev) return fn();
  const dir = join(REPO, 'services', opts.service);
  if (existsSync(dir)) throw new Error(`${dir} exists: --from-rev reads a router the checkout no longer has`);
  execFileSync('sh', ['-c', `git archive "$1" "services/$2" | tar -x`, 'sh', opts.fromRev, opts.service], { cwd: REPO });
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A service whose Rust port is in flight: its crate is on the tree beside its TypeScript service (the port's switch deletes
 * the TypeScript). Rewriting its TypeScript router now makes the port's next slice port a moving target, and one PR edit
 * both (J-agents-01 had to). Refused by name, before anything is read or written; null when the codemod may run. A
 * service the door already serves (`--from-rev`, its TypeScript gone) is not in flight.
 */
export function portInFlight(service, root = REPO) {
  if (!existsSync(join(root, 'crates', service)) || !existsSync(join(root, 'services', service))) return null;
  return `${service}'s Rust port is in flight (crates/${service} is beside services/${service}): the codemod does not rewrite its TypeScript router while it is. Move only its callers with --callers-only, or leave its calls by name; once its switch deletes services/${service}, run this with --door and --from-rev, as for svc-academy.`;
}

/**
 * Whether this run may go, as `{ code, why }` when it may not: a service mid-port runs only with --callers-only, and
 * --callers-only only for a service mid-port (anything else takes the whole run, router and all).
 */
export function portRefusal(opts, root = REPO) {
  const inFlight = portInFlight(opts.service, root);
  if (inFlight && !opts.callersOnly) return { code: 3, why: inFlight };
  if (!inFlight && opts.callersOnly)
    return { code: 2, why: `--callers-only is for a service whose Rust port is in flight, and ${opts.service}'s is not: run without it` };
  return null;
}

/** The files of `files` inside a service or its crate (`services/svc-*`, `crates/svc-*`), which a callers-only run never touches. */
export function serviceFiles(files, root = REPO) {
  return files.filter((f) => /^(services|crates)\/svc-[^/]+\//.test(relative(root, resolve(root, f))));
}

/** A callers-only run that would touch a service or its crate stops, naming the files. */
export function holdCallersOnly(files, root = REPO) {
  const bad = serviceFiles(files, root);
  if (bad.length)
    throw new Error(
      `--callers-only touched a service mid-port, which it never may:\n${bad.map((f) => relative(root, resolve(root, f))).join('\n')}`,
    );
}

function main() {
  const opts = args(process.argv.slice(2));
  const refused = portRefusal(opts);
  if (refused) {
    console.error(refused.why);
    process.exit(refused.code);
  }
  withRouterFrom(opts, () => report(opts));
}

function report(opts) {
  const planned = plan(opts);
  const result = build(opts, planned);
  // The router read from history is not written back: only contracts and the callers change.
  if (opts.fromRev) for (const f of result.changes.files.keys()) if (f.startsWith(planned.serviceDir)) result.changes.files.delete(f);
  const summary = {
    service: opts.service,
    // A call named by a `? :` or a closed set is one site per value, and one call.
    sites: new Set(planned.sites.map((s) => s.node)).size,
    records: result.done.map((r) => r.name),
    existing: planned.existing.map((e) => e.name),
    rewritten: new Set([...result.done, ...planned.existing].flatMap((r) => r.sites.map((s) => s.node))).size,
    hand: planned.hand.map((h) => ({
      at: `${relative(REPO, h.site.file)}:${h.site.line}`,
      call: `${h.site.module ?? '?'} ${h.site.path ?? '?'}`,
      why: h.why,
    })),
    problems: result.problems,
  };
  if (opts.callersOnly) holdCallersOnly([...result.changes.files.keys(), ...result.created.keys()]);
  if (opts.write) {
    const touched = write(result);
    if (opts.callersOnly) holdCallersOnly(touched);
    summary.touched = touched.map((f) => relative(REPO, f));
  }
  if (opts.json) writeFileSync(opts.json, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, hand: summary.hand.length, handSample: summary.hand.slice(0, 15) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

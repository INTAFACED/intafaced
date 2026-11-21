#!/usr/bin/env node
// The call-records codemod: moves an app's calls to a service from "by name" (`api.query('bank', 'deposits.list', input,
// schema)`) to the call's written record (`api.call(BANK_DEPOSITS_LIST, input)`), and writes the record from the
// service's own router: its guard, input and answer schemas, moved into @intafaced/contracts, and the router mounting it
// (`mountRecord`). What it can't move safely it leaves untouched and names. See README.md beside this file.
//
//   node tooling/codemod/call-records/index.mjs --module bank [--paths deposits.,global.] [--service svc-bank]
//        [--file bank-deposit-procedures] [--write]
//
// Safe to rerun: a call already made through its record is no site, and a record already written is reused.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyEdits,
  bindingOf,
  calleeName,
  forget,
  leadingDoc,
  literal,
  load,
  resolveRelative,
  statementEnd,
  statementStart,
  text,
  walk,
} from './ast.mjs';
import { chainOf, procedures } from './router.mjs';
import { closureOf, contractsExports, usedOutside } from './closure.mjs';
import { findSites } from './sites.mjs';

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
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.module) throw new Error('--module is required');
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
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
  for (const f of files) {
    const src = readFileSync(join(serviceDir, f), 'utf8');
    for (const m of src.matchAll(/^(export )?const (\w+): RefusalOf\b/gm))
      out.push({ name: m[2], file: join(serviceDir, f), exported: Boolean(m[1]) });
  }
  return out;
}
function readerFor(readers, file) {
  return (
    readers.find((r) => r.file === file) ??
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
class Changes {
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
    const checks = arg ? answerChecks(load(s.file), arg) : [];
    if (checks.length) {
      hand.push({
        site: s,
        why: `its own schema checks the answer, ${checks.join(', ')}: move the check to the call's \`accept\` by hand`,
      });
      continue;
    }
    if (!byPath.has(s.path)) byPath.set(s.path, []);
    byPath.get(s.path).push(s);
  }
  const readers = refusalReaders(serviceDir);
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
      for (const s of list)
        hand.push({
          site: s,
          why: `${opts.service} has no procedure ${path} the codemod can read${unread.length ? ` (${unread.length} router parts unread)` : ''}`,
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
    const kindMismatch = list.filter((s) => s.kind && s.kind !== chain.kind);
    const reader = readerFor(readers, proc.p.file);
    if (chain.problems.length || !reader) {
      const why = chain.problems.join('; ') || `${opts.service} has no refusal reader this file can import (no exported \`: RefusalOf\`)`;
      for (const s of list) hand.push({ site: s, why });
      continue;
    }
    const name = recordName(opts.module, path);
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

/** The input argument of a site, and whether it is no input at all (`undefined`, `{}`, or absent). */
const inputArg = (s) => s.node.arguments[s.shape === 'founderCall' ? 4 : 2];
function noInput(s) {
  const a = inputArg(s);
  return !a || (a.type === 'Identifier' && a.name === 'undefined') || (a.type === 'ObjectExpression' && a.properties.length === 0);
}

/** The record file a path's first segment lands in. */
function recordFile(opts, path) {
  if (opts.file) return join(CONTRACTS, `${opts.file.replace(/\.ts$/, '')}.ts`);
  const seg = kebab(path.split('.')[0]);
  const primary = join(CONTRACTS, `${opts.module}-${seg}-procedures.ts`);
  if (!existsSync(primary) || readFileSync(primary, 'utf8').includes(MARK)) return primary;
  return join(CONTRACTS, `${opts.module}-${seg}-records.ts`);
}

function build(opts, planned) {
  const changes = new Changes();
  const created = new Map();
  const groups = new Map();
  for (const r of planned.records) {
    const file = recordFile(opts, r.path);
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
      { p: r.proc.p, node: r.chain.output, where: `${r.path} output` },
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
        return build(opts, { ...planned, records: planned.records.filter((r) => good.includes(r) || recordFile(opts, r.path) !== file) });
      }
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
    const keyOf = (m) => (m.q ? `${m.q.file}#${m.name}` : `inline#${m.name}`);
    const fresh = closure.moved.filter((m) => !movedTo.has(keyOf(m)));
    const clash = fresh.some((m) => taken.has(m.name) && taken.get(m.name) !== keyOf(m));
    const target = clash ? file : shared;
    for (const m of fresh) {
      movedTo.set(keyOf(m), target);
      if (target === shared) taken.set(m.name, keyOf(m));
    }
    const placed = closure.moved.map((m) => ({ name: m.name, file: movedTo.get(keyOf(m)) }));
    created.set(file, writeRecords(opts, file, recs, { ...closure, moved: target === file ? fresh : [] }, placed, created.get(file)));
    if (target === shared && fresh.length)
      created.set(shared, writeSchemas(opts, shared, { ...closure, moved: fresh }, created.get(shared)));
    // Moved declarations: their old home imports them from contracts.
    for (const m of fresh) {
      if (m.inline || !m.q) continue;
      const b = m.binding;
      const stmt = b.statement;
      if (b.kind === 'var' && b.declaration.declarations.length > 1) {
        problems.push(`${relative(REPO, m.q.file)}#${m.name}: shares its statement with other declarations; split it by hand first`);
        continue;
      }
      changes.edit(m.q.file, statementStart(m.q, stmt), statementEnd(m.q, stmt), '');
      changes.imp(m.q.file, contractsSpec(target), b.kind === 'type' ? `type ${m.name}` : m.name);
      // Re-exported only for a file that imports it from here; anyone else reads it from contracts.
      if (b.exported && importersOf(m.q.file, m.name).length > 0)
        changes.of(m.q.file).exports.add(b.kind === 'type' ? `type ${m.name}` : m.name);
    }
    // The router: each procedure is mounted from its record.
    for (const r of recs) {
      const { p, node } = r.proc;
      const { reader } = r;
      changes.edit(p.file, node.start, node.end, `mountRecord(${r.name}, ${text(p, r.chain.handler)}, ${reader.name})`);
      changes.imp(p.file, contractsSpec(file), r.name);
      changes.imp(p.file, '@intafaced/contracts/procedure-mount', 'mountRecord');
      if (reader.file !== p.file) changes.imp(p.file, relImport(p.file, reader.file), reader.name);
      for (const s of r.sites) rewriteSite(changes, s, r.name, contractsSpec(file), !r.chain.input);
      done.push(r);
    }
  }
  for (const e of planned.existing) for (const s of e.sites) rewriteSite(changes, s, e.name, contractsSpec(e.file));
  return { changes, created, problems, done };
}

/** The schema a caller parses the answer with, or undefined. */
function schemaArgOf(s) {
  const a = s.node.arguments;
  return s.shape === 'founderCall' ? (s.reader ? undefined : a[5]?.arguments?.[0]) : a[3];
}

// zod methods that check or change an answer beyond its shape: a record's `output` copies the router's shape, so a caller's
// own check would be lost with its schema. Such a call stays as it is, for its check to move to `accept` by hand.
const ANSWER_CHECKS = new Set(['refine', 'superRefine', 'transform', 'pipe', 'check', 'preprocess', 'catch', 'overwrite']);

/** The checks a caller's schema makes on the answer: `name (file:line)`, following the app's own consts and imports. */
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
  visit(p, node);
  return [...new Set(found)];
}

/** One caller, rewritten to its record. */
function rewriteSite(changes, s, name, spec, takesNone) {
  const p = load(s.file);
  const n = s.node;
  const a = n.arguments;
  // The hand schema the caller parsed with: its types now come from the record (`retype`).
  const schemaArg = schemaArgOf(s);
  if (schemaArg?.type === 'Identifier') {
    const f = changes.of(s.file);
    f.schemas ??= new Map();
    if (!f.schemas.has(schemaArg.name)) f.schemas.set(schemaArg.name, new Set());
    f.schemas.get(schemaArg.name).add(name);
  }
  const input = takesNone ? 'undefined' : text(p, inputArg(s));
  if (s.shape === 'query' || s.shape === 'mutate') {
    const recv = text(p, n.callee.object);
    const rest = [input, ...(a[4] ? [text(p, a[4])] : [])];
    changes.edit(s.file, n.start, n.end, `${recv}.call(${name}, ${rest.join(', ')})`);
  } else if (s.shape === 'founderCall') {
    // A page's own reader stays, reading the record's parsed answer into its view (`founderRecordRead`).
    const fn = s.reader ? 'founderRecordRead' : 'founderRecordCall';
    const rest = [text(p, a[0]), name, input, ...(s.reader ? [text(p, a[5])] : []), ...(a[6] ? [text(p, a[6])] : [])];
    changes.edit(s.file, n.start, n.end, `${fn}(${rest.join(', ')})`);
    changes.imp(s.file, s.founderCallFrom, fn);
  }
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
  const area = recs[0].path.split('.')[0];
  if (fresh) {
    lines.push(
      importText,
      '',
      MARK,
      `/** ${svc} \`${area}.*\`, one record per call: ${svc} mounts each (\`mountRecord\`) and every app caller calls it by its record. */`,
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
      '  refusals: {},',
      `  input: ${r.chain.input ? exactInput(p, r.chain.input, lines, r.path) : 'NO_INPUT'},`,
      `  output: ${text(p, r.chain.output)},`,
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
function writeSchemas(opts, file, closure, pending) {
  const fresh = pending === undefined && !existsSync(file);
  const imports = new Map([['zod', new Set(['z'])]]);
  const imp = (spec, name) => {
    if (!imports.has(spec)) imports.set(spec, new Set());
    imports.get(spec).add(name);
  };
  for (const [local, c] of closure.fromContracts)
    imp(
      `./${basename(c.file).replace(/\.ts$/, '.js')}`,
      `${c.typeOnly ? 'type ' : ''}${c.imported === local ? local : `${c.imported} as ${local}`}`,
    );
  for (const [spec, names] of closure.fromPackages) for (const n of names) if (!(spec === 'zod' && n === 'z')) imp(spec, n);
  const decls = closure.moved.map((m) => `${m.inline ? m.text.replace(/\nconst /, '\nexport const ') : m.text}\n`).join('\n');
  if (fresh) {
    const head = [...imports].map(([spec, names]) => `import { ${[...names].join(', ')} } from '${spec}';`).join('\n');
    return `${head}\n\n${MARK}\n/** The schemas ${opts.service}'s records share, moved from the service so the records and every caller read one copy. */\n\n${decls}`;
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
  for (const [file, body] of result.created) {
    writeFileSync(file, body);
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
  for (const file of touched) pruneImports(file);
  if (touched.length)
    execFileSync(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...touched], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  return touched;
}

/** The other files that import `name` from `file` (by its module name), the files a re-export of it must keep serving. */
function importersOf(file, name) {
  const stem = basename(file).replace(/\.tsx?$/, '');
  try {
    return execFileSync('git', ['grep', '-l', '-w', name, '--', 'apps', 'packages', 'services'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && join(REPO, f) !== file && new RegExp(`from '[^']*${stem}(\\.js)?'`).test(readFileSync(join(REPO, f), 'utf8')));
  } catch {
    return [];
  }
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
  for (const [schema, recs] of schemas) {
    if (recs.size !== 1) continue;
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
  const retyped = new Set([...schemas].filter(([, recs]) => recs.size === 1).map(([schema]) => schema));
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

function main() {
  const opts = args(process.argv.slice(2));
  const planned = plan(opts);
  const result = build(opts, planned);
  const summary = {
    service: opts.service,
    sites: planned.sites.length,
    records: result.done.map((r) => r.name),
    existing: planned.existing.map((e) => e.name),
    rewritten: result.done.reduce((n, r) => n + r.sites.length, 0) + planned.existing.reduce((n, e) => n + e.sites.length, 0),
    hand: planned.hand.map((h) => ({
      at: `${relative(REPO, h.site.file)}:${h.site.line}`,
      call: `${h.site.module ?? '?'} ${h.site.path ?? '?'}`,
      why: h.why,
    })),
    problems: result.problems,
  };
  if (opts.write) summary.touched = write(result).map((f) => relative(REPO, f));
  if (opts.json) writeFileSync(opts.json, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, hand: summary.hand.length, handSample: summary.hand.slice(0, 15) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

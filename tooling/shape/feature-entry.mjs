#!/usr/bin/env node
/**
 * FEATURE ENTRY. Rewrites each import that reaches inside another feature (`garden/no-cross-feature-import`) to that
 * feature's entry, its folder's `index.ts`, and adds to the entry each name it does not export yet.
 *
 *   node tooling/shape/feature-entry.mjs          rewrite every site the rule finds, then print what is left by hand
 *   node tooling/shape/feature-entry.mjs --dry    print what it would do and change nothing
 *
 * It finds the sites with the rule itself (oxlint over apps/admin/src and apps/customer/src), so it judges exactly what the
 * ratchet judges, and a second run finds nothing to do. A site is rewritten only when that is safe; every other site is
 * printed, with why, to be fixed by hand, and the run exits 1:
 *   - a default or namespace import, or a dynamic `import()`: the entry would need a shape it has no rule for;
 *   - a value from an entry that imports `server-only`, into a file that is neither server-only nor a test: the browser
 *     would load the server's entry (a type-only import is erased, so it is safe);
 *   - a name the entry already exports from another file: the import would change what it reads.
 * `typeof import('<inside>')` beside `vi.mock('<inside>', …)` moves both to the entry, so the test mocks the module its
 * subject imports. A missing entry is written with the header the others carry, server-only when what it exports is.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RULE = 'garden/no-cross-feature-import';
const PATHS = ['apps/admin/src', 'apps/customer/src'];
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-util\.[jt]sx?$/u;
const SERVER_ONLY = /^\s*import\s+['"]server-only['"];?\s*$/mu;
const EXT = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/** The rule's findings under `root` (the checkout, or a scratch copy holding its own config): [{ file, start, end, spec, key }],
 * file absolute, start and end the specifier's quoted string in UTF-8 bytes, key the feature it reaches into. */
export function findings(root = ROOT, paths = PATHS) {
  const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'oxlint'), ['-c', '.oxlintrc.json', '--format', 'json', ...paths], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  let diagnostics;
  try {
    diagnostics = JSON.parse(run.stdout).diagnostics ?? [];
  } catch {
    throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout || '').slice(0, 800)}`);
  }
  return diagnostics
    .filter((d) => String(d.code).includes('no-cross-feature-import'))
    .map((d) => {
      const [, spec, , key] = d.message.split('`');
      const { offset, length } = d.labels[0].span;
      return { file: join(root, d.filename), start: offset, end: offset + length, spec, key };
    });
}

/** The file a specifier names from `file`, with its extension, or undefined. */
function resolveSpec(file, spec, src) {
  const base = spec.startsWith('@/') ? join(src, spec.slice(2)) : join(dirname(file), spec);
  for (const p of [base, ...EXT.map((e) => base + e), ...EXT.map((e) => join(base, `index${e}`))]) {
    if (existsSync(p) && !p.endsWith('/') && EXT.some((e) => p.endsWith(e))) return p;
  }
  return undefined;
}

/** The specifier of a feature's entry, written the way the site wrote its own (the `@/` alias or a relative path). */
function entrySpec(file, spec, src, key) {
  if (spec.startsWith('@/')) return `@/${key}`;
  const rel = posix.relative(dirname(file), join(src, key)).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** The names an entry exports, each with the module it exports it from (resolved), or null for its own declarations. */
function entryExports(entryFile, text) {
  const out = new Map();
  const code = withoutComments(text);
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?/gu)) {
    const from = m[3] ? resolveSpec(entryFile, m[3], dirname(entryFile)) : null;
    for (const el of namesIn(m[1])) out.set(el.exported, from);
  }
  for (const m of code.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    out.set(m[1], null);
  }
  return out;
}

/** The text with its comments blanked out, the same length, so positions still hold. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, (c) => c.replace(/[^\n]/gu, ' '));
}

/** The elements of `{ … }`: [{ name (the imported one), exported (the local or exported one), type }]. */
function namesIn(inner) {
  return inner
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(x);
      return m ? { name: m[2], exported: m[3] ?? m[2], type: Boolean(m[1]) } : { bad: x };
    });
}

const NEW_ENTRY = (name, serverOnly) =>
  [
    ...(serverOnly ? ["import 'server-only';", ''] : []),
    '/**',
    ` * The ${name.replace(/-/gu, ' ')} feature's entry: another feature imports it only from here`,
    ' * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.',
    ...(serverOnly ? [' * This entry is for server code: what it exports imports `server-only`.'] : []),
    ' */',
    '',
  ].join('\n');

/** The import site whose specifier is text[start, end): { names: [{ name, type }], mock? } or { hand: why }. */
export function siteOf(text, start, end) {
  const code = withoutComments(text);
  const before = code.slice(0, start);
  const quoted = text.slice(start, end);
  if (/typeof\s+import\(\s*$/u.test(before)) {
    // typeof import('<inside>') in a vi.mock factory: the mock moves with it.
    const esc = quoted.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const calls = [...before.matchAll(new RegExp(`vi\\.(?:mock|doMock)\\(\\s*(['"])${esc}\\1`, 'gu'))];
    const call = calls.at(-1);
    if (!call) return { hand: '`typeof import()` outside a vi.mock of the same module' };
    const at = call.index + call[0].length - quoted.length;
    return { names: [], mock: { start: at, end: at + quoted.length } };
  }
  if (/import\(\s*$/u.test(before)) return { hand: 'a dynamic `import()`' };
  const heads = [...before.matchAll(/(?:^|[;\n])\s*(import|export)\b/gu)];
  const head = heads.at(-1);
  if (!head) return { hand: 'no import or export statement around it' };
  const stmt = before.slice(head.index + head[0].length - head[1].length);
  const m = /^(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*$/u.exec(stmt);
  if (!m) return { hand: 'a side-effect import or another form' };
  const clause = m[3].trim();
  if (!clause.startsWith('{') || !clause.endsWith('}')) return { hand: 'a default or namespace import, or `export *`' };
  const els = namesIn(clause.slice(1, -1));
  if (els.some((e) => e.bad)) return { hand: 'an import element the script cannot read' };
  return { names: els.map((e) => ({ name: e.name, type: Boolean(m[2]) || e.type })) };
}

/** Plans the rewrite: { edits: Map<file, [{start, end, text}]>, entries: Map<entryFile, {text, add: Map<from, Set<'type '|''+name>>}>, hand: [] }. */
export function plan(list, root = ROOT) {
  const edits = new Map();
  const entries = new Map();
  const hand = [];
  const sources = new Map();
  const textOf = (f) => (sources.has(f) ? sources.get(f) : (sources.set(f, readFileSync(f, 'utf8')), sources.get(f)));
  for (const f of list) {
    const where = `${relative(root, f.file)}: \`${f.spec}\``;
    const src = /^(.*\/apps\/(?:customer|admin)\/src)\//u.exec(f.file)?.[1];
    const target = src && resolveSpec(f.file, f.spec, src);
    if (!target) {
      hand.push(`${where}: cannot resolve the import`);
      continue;
    }
    const text = textOf(f.file);
    // oxlint's span counts UTF-8 bytes; the source text counts UTF-16 units.
    const bytes = Buffer.from(text);
    const start = bytes.subarray(0, f.start).toString('utf8').length;
    const end = bytes.subarray(0, f.end).toString('utf8').length;
    const site = siteOf(text, start, end);
    if (site.hand) {
      hand.push(`${where}: ${site.hand}`);
      continue;
    }
    const dir = join(src, f.key);
    const entryFile = EXT.map((e) => join(dir, `index${e}`)).find((p) => existsSync(p)) ?? join(dir, 'index.ts');
    if (!entries.has(entryFile)) {
      const exists = existsSync(entryFile);
      entries.set(entryFile, { exists, text: exists ? readFileSync(entryFile, 'utf8') : '', add: new Map(), serverOnly: false });
    }
    const entry = entries.get(entryFile);
    const targetServerOnly = SERVER_ONLY.test(readFileSync(target, 'utf8'));
    const entryServerOnly = SERVER_ONLY.test(entry.text) || entry.serverOnly || (!entry.exists && targetServerOnly);
    const importerSafe = TEST.test(f.file) || SERVER_ONLY.test(text);
    if (entryServerOnly && !importerSafe && site.names.some((n) => !n.type)) {
      hand.push(`${where}: a value from the server-only entry of \`${f.key}\` into a file the browser may load`);
      continue;
    }
    const exported = entryExports(entryFile, entry.text);
    const clash = site.names.find((n) => exported.has(n.name) && exported.get(n.name) !== null && exported.get(n.name) !== target);
    if (clash) {
      hand.push(`${where}: \`${clash.name}\` is exported by the entry from another file`);
      continue;
    }
    const plannedElsewhere = site.names.find((n) =>
      [...entry.add].some(([from, set]) => from !== target && (set.has(n.name) || set.has(`type ${n.name}`))),
    );
    if (plannedElsewhere) {
      hand.push(`${where}: \`${plannedElsewhere.name}\` is already being added to the entry from another file`);
      continue;
    }
    for (const n of site.names) {
      if (exported.has(n.name)) continue;
      const set = entry.add.get(target) ?? new Set();
      // A name wanted as a value anywhere is exported as a value.
      if (n.type && !set.has(n.name)) set.add(`type ${n.name}`);
      else {
        set.delete(`type ${n.name}`);
        set.add(n.name);
      }
      entry.add.set(target, set);
    }
    if (!entry.exists && targetServerOnly) entry.serverOnly = true;
    const spec = entrySpec(f.file, f.spec, src, f.key);
    const quote = text[start];
    const fileEdits = edits.get(f.file) ?? [];
    fileEdits.push({ start, end, text: `${quote}${spec}${quote}` });
    if (site.mock && !fileEdits.some((e) => e.start === site.mock.start)) fileEdits.push({ ...site.mock, text: `${quote}${spec}${quote}` });
    edits.set(f.file, fileEdits);
  }
  return { edits, entries, hand };
}

/** The entry's text with each new name added after the names of its `export { … } from` line for that file, or on a new line. */
function entryText(entryFile, entry) {
  let text = entry.exists ? entry.text : NEW_ENTRY(dirname(entryFile).split('/').pop(), entry.serverOnly);
  const bare = (n) => n.replace(/^type /u, '');
  const sorted = (names) => [...names].sort((a, b) => bare(a).localeCompare(bare(b)));
  const lines = [];
  for (const [from, set] of entry.add) {
    let rel = posix.relative(dirname(entryFile), from).replace(/\.[cm]?[jt]sx?$/u, '');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    const esc = rel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const line = new RegExp(`export\\s+\\{([^}]*)\\}\\s*from\\s*(['"])${esc}(?:\\.[cm]?[jt]sx?)?\\2`, 'u');
    const found = line.exec(text);
    if (found) {
      const names = [
        ...found[1]
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        ...sorted(set),
      ];
      text = text.replace(found[0], `export { ${names.join(', ')} } from ${found[2]}${found[0].split(found[2])[1]}${found[2]}`);
      continue;
    }
    const names = sorted(set);
    lines.push(
      names.every((n) => n.startsWith('type '))
        ? `export type { ${names.map(bare).join(', ')} } from '${rel}';`
        : `export { ${names.join(', ')} } from '${rel}';`,
    );
  }
  if (!lines.length) return text;
  return `${text.replace(/\n*$/u, '\n')}${lines.sort().join('\n')}\n`;
}

async function pretty(file, text) {
  const options = await resolveConfig(file);
  return format(text, { ...options, filepath: file });
}

/** Writes the plan; returns the files it changed. */
export async function apply({ edits, entries }) {
  const changed = [];
  for (const [file, list] of edits) {
    let text = readFileSync(file, 'utf8');
    for (const e of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    writeFileSync(file, await pretty(file, text));
    changed.push(file);
  }
  for (const [file, entry] of entries) {
    if (!entry.add.size && entry.exists) continue;
    writeFileSync(file, await pretty(file, entryText(file, entry)));
    changed.push(file);
  }
  return changed;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const list = findings();
  if (!list.length) {
    console.log(`${RULE}: no import reaches inside another feature; nothing to rewrite.`);
    return 0;
  }
  const p = plan(list);
  const sites = [...p.edits.values()].reduce((a, l) => a + l.length, 0);
  console.log(`${RULE}: ${list.length} site(s); ${list.length - p.hand.length} rewritten to the entry${dry ? ' (dry run)' : ''}.`);
  for (const [file, entry] of p.entries) {
    for (const [from, set] of entry.add)
      console.log(`  ${relative(ROOT, file)} exports ${[...set].join(', ')} from ${relative(ROOT, from)}`);
  }
  if (!dry) {
    const changed = await apply(p);
    console.log(`  ${changed.length} file(s) written, ${sites} specifier(s) changed.`);
  }
  for (const h of p.hand) console.log(`  by hand: ${h}`);
  return p.hand.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();

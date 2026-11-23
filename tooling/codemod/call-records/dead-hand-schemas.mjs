#!/usr/bin/env node
// Deletes the bank's hand schemas no caller names: each entry of an area's `<area>Reads` or `<area>Writes` in
// apps/customer/src/features/money/contracts-<area>.ts (composed into `bankReads` and `bankWrites`) whose call name no
// string in the customer app spells, the entry's own key aside. A name built by a template that starts with a call's
// segment (`autoInvest.${action}`) names every entry it can spell; a template that starts with a value, or is a copy key
// (`t(`eligibility.${state}`)`), names none; nor does a file of words (`*-copy.ts`) or a comparison (`case 'x':`,
// `p === 'x'`), which asks which call a name is and sends nothing. A test or mock names an entry only by reading it from its map
// (`bankReads['x']`, `(typeof bankWrites)['x']`, or `bankWriteForReview('x', input)`, which reads it): its other strings are a stubbed answer or an expected request, not a
// caller. It deletes only entries nothing names, so it is safe at any time; run.mjs runs it after every service's run, so
// once a caller moves to its record (the call-records codemod), its entry goes in the same change.
// With --write it first sends each map read of an entry whose call has a bank record to that record's own schema
// (`bankReads['x']` → `BANK_X.output`, `(typeof bankWrites)['x']` → `(typeof BANK_X)['output']`, and
// `bankWriteForReview('x', input)`, which reads `bankWrites['x']` itself, is handed `BANK_X.output`): a test or a write's
// check that read the hand copy reads what every caller now parses with, and the copy, named by nothing else, goes.
//
//   node tooling/codemod/call-records/dead-hand-schemas.mjs [--write]
// Prints the entries it deletes (or would, without --write), one `<file>:<line> <name>` a line.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { applyEdits, forget, keyOf, literal, load, walk } from './ast.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const MONEY = 'apps/customer/src/features/money';
const AREA_FILE = /\/contracts-[a-z-]+\.ts$/u;
const AREA_MAP = /^[a-z]+(Reads|Writes)$/u;
const CALL_NAME = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
/** A template's opening text that is a call name's first segments: `autoInvest.`, `cards.disputes.`. */
const CALL_HEAD = /^[a-z][A-Za-z0-9]*\.(?:[A-Za-z][A-Za-z0-9]*\.)*$/u;

/** A test, a browser test or a mock: what it spells is stubbed, not called (sites.mjs's tests, and `.mock.` files). */
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.(pw|mock)\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
/** A file of words (`money-refusal-copy.ts`): a call name there keys the sentences its refusals read, never a caller. */
const COPY_FILE = /-copy\.[cm]?[jt]sx?$/u;
/**
 * A `case 'x':` or a side of `=== 'x'` / `!== 'x'`: it asks which call a value names (a write's checks picked by its
 * name), and sends nothing.
 */
function comparison(p, n) {
  const up = p.parents.get(n);
  if (up?.type === 'SwitchCase' && up.test === n) return true;
  return up?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(up.operator);
}
/** A copy lookup: its key names words, never a call. */
const COPY_CALL = new Set(['t', 'copyText']);
/** `bankReads['x']`, `earnWrites['x']` or `(typeof bankWrites)['x']`: the key read from a map of hand schemas. */
function mapRead(p, n) {
  const up = p.parents.get(n);
  if (up?.type === 'MemberExpression' && up.computed && up.property === n)
    return up.object.type === 'Identifier' && /(Reads|Writes)$/u.test(up.object.name);
  const lit = up?.type === 'TSLiteralType' ? up : undefined;
  const at = lit && p.parents.get(lit);
  if (at?.type !== 'TSIndexedAccessType' || at.indexType !== lit) return false;
  const q = at.objectType.type === 'TSParenthesizedType' ? at.objectType.typeAnnotation : at.objectType;
  return q.type === 'TSTypeQuery' && /(Reads|Writes)$/u.test(q.exprName?.name ?? '');
}
/** `bankWriteForReview('x', input)` with no answer schema: it reads `bankWrites['x']` itself, a map read by name. */
function reviewRead(p, n) {
  const up = p.parents.get(n);
  return (
    up?.type === 'CallExpression' &&
    up.callee.type === 'Identifier' &&
    up.callee.name === 'bankWriteForReview' &&
    up.arguments[0] === n &&
    up.arguments.length === 2
  );
}
const copyKey = (p, n) => {
  const up = p.parents.get(n);
  return up?.type === 'CallExpression' && up.arguments[0] === n && up.callee.type === 'Identifier' && COPY_CALL.has(up.callee.name);
};

const appFiles = (repo) =>
  execFileSync('git', ['ls-files', 'apps/customer/src'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.[cm]?[jt]sx?$/u.test(f))
    .map((f) => join(repo, f));

/** Each hand schema: `{ file, line, name, prop }`, the property of an area's Reads or Writes keyed by a call name. */
export function handSchemas(repo = REPO) {
  const out = [];
  for (const file of appFiles(repo).filter((f) => f.includes(`/${MONEY}/`) && AREA_FILE.test(f))) {
    const p = load(file);
    for (const st of p.program.body) {
      const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
      for (const d of decl?.type === 'VariableDeclaration' ? decl.declarations : []) {
        if (d.id?.type !== 'Identifier' || !AREA_MAP.test(d.id.name)) continue;
        let obj = d.init;
        while (obj && (obj.type === 'TSAsExpression' || obj.type === 'TSSatisfiesExpression')) obj = obj.expression;
        for (const prop of obj?.type === 'ObjectExpression' ? obj.properties : []) {
          const name = prop.type === 'Property' ? keyOf(prop) : undefined;
          if (name && CALL_NAME.test(name))
            out.push({ file, line: p.src.slice(0, prop.start).split('\n').length, name, map: d.id.name, prop, p });
        }
      }
    }
  }
  return out;
}

/** Every call name the app spells, the hand schemas' own keys aside: exact strings, and templates as patterns. */
function namesSpelled(repo, keys) {
  const exact = new Set();
  const patterns = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const file of appFiles(repo)) {
    const p = load(file);
    const test = TEST_FILE.test(file);
    if (COPY_FILE.test(file)) continue;
    walk(p.program, (n) => {
      if (keys.has(n)) return;
      const s = literal(n);
      if (s !== undefined) {
        if ((!test && !comparison(p, n)) || mapRead(p, n) || reviewRead(p, n)) exact.add(s);
      } else if (!test && n.type === 'TemplateLiteral' && !copyKey(p, n) && CALL_HEAD.test(n.quasis[0].value.cooked ?? ''))
        patterns.push(new RegExp(`^${n.quasis.map((q) => esc(q.value.cooked ?? '')).join('[A-Za-z0-9.]+')}$`, 'u'));
    });
  }
  return (name) => exact.has(name) || patterns.some((re) => re.test(name));
}

/** The hand schemas no caller names. */
export function deadHandSchemas(repo = REPO) {
  const all = handSchemas(repo);
  const named = namesSpelled(repo, new Set(all.map((h) => h.prop.key)));
  return all.filter((h) => !named(h.name));
}

/** Each bank record by its path: `path -> { name, spec }`, read from contracts' record files. */
export function bankRecords(repo = REPO) {
  const dir = join(repo, 'packages/contracts/src');
  const out = new Map();
  for (const f of readdirSync(dir).filter((x) => /^bank-.*-procedures\.ts$/u.test(x))) {
    const src = readFileSync(join(dir, f), 'utf8');
    if (!/const base = \{[^}]*module: 'bank'/u.test(src)) continue;
    for (const m of src.matchAll(/^export const (\w+) = defineProcedure\(\{\n[\s\S]*?\n {2}path: '([^']+)',/gmu))
      if (!out.has(m[2])) out.set(m[2], { name: m[1], spec: `@intafaced/contracts/${f.replace(/\.ts$/u, '')}` });
  }
  return out;
}

/** Sends each map read of a hand schema whose call has a record to the record's own schema; returns each file changed, `{ file, src }` as written. */
export function readRecords(repo = REPO) {
  const records = bankRecords(repo);
  const hand = new Set(
    handSchemas(repo)
      .map((h) => h.name)
      .filter((n) => records.has(n)),
  );
  const changed = [];
  for (const file of appFiles(repo)) {
    if (AREA_FILE.test(file)) continue;
    const p = load(file);
    const edits = [];
    const names = new Set();
    const maps = new Set();
    walk(p.program, (n) => {
      const key = literal(n);
      if (!hand.has(key) || !(mapRead(p, n) || reviewRead(p, n))) return;
      const rec = records.get(key);
      const up = p.parents.get(n);
      if (up.type === 'CallExpression') {
        const last = up.arguments[1];
        edits.push({ start: last.end, end: last.end, text: `, ${rec.name}.output` });
      } else if (up.type === 'MemberExpression') {
        maps.add(up.object.name);
        edits.push({ start: up.start, end: up.end, text: `${rec.name}.output` });
      } else {
        const at = p.parents.get(up);
        const q = at.objectType.type === 'TSParenthesizedType' ? at.objectType.typeAnnotation : at.objectType;
        maps.add(q.exprName.name);
        edits.push({ start: at.start, end: at.end, text: `(typeof ${rec.name})['output']` });
      }
      names.add(key);
    });
    if (!edits.length) continue;
    let src = applyEdits(p.src, edits);
    const bySpec = Map.groupBy(
      [...names].map((key) => records.get(key)),
      (r) => r.spec,
    );
    for (const [spec, recs] of bySpec) {
      const add = [...new Set(recs.map((r) => r.name))].filter((name) => !new RegExp(`\\b${name}\\b`, 'u').test(p.src));
      if (!add.length) continue;
      const imports = [...src.matchAll(/^import [\s\S]*?from '[^']+';$/gmu)];
      const at = imports.length ? imports.at(-1).index + imports.at(-1)[0].length : 0;
      src = `${src.slice(0, at)}${at ? '\n' : ''}import { ${add.join(', ')} } from '${spec}';${at ? '' : '\n'}${src.slice(at)}`;
    }
    // A map the file no longer reads leaves its import.
    for (const map of maps) {
      const uses = src.match(new RegExp(`\\b${map}\\b`, 'gu'))?.length ?? 0;
      if (uses !== 1) continue;
      src = src.replace(new RegExp(`^(import [^;]*?)\\{([^}]*)\\}([^;]*;)$`, 'gmu'), (line, a, list, b) => {
        const kept = list
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x && x.replace(/^type /u, '') !== map);
        if (
          kept.length ===
          list
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean).length
        )
          return line;
        return kept.length ? `${a}{ ${kept.join(', ')} }${b}` : '';
      });
    }
    writeFileSync(file, src);
    forget(file);
    changed.push({ file, src });
  }
  return changed;
}

/** `src` without each named import its deleted entries were the last to read (a type import too). */
export function unusedImportsDropped(src) {
  return src.replace(/^import (type )?\{([^}]*)\} from ('[^']+');\n/gmu, (line, type, list, spec) => {
    const names = list
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const body = src.replace(line, '');
    const kept = names.filter((n) =>
      new RegExp(
        `\\b${n
          .replace(/^type /u, '')
          .split(/ as /u)
          .pop()}\\b`,
        'u',
      ).test(body),
    );
    if (kept.length === names.length) return line;
    return kept.length ? `import ${type ?? ''}{ ${kept.join(', ')} } from ${spec};\n` : '';
  });
}

/** Deletes each dead entry with its own comments and its comma; returns what it deleted. */
export function deleteDead(repo = REPO) {
  const dead = deadHandSchemas(repo);
  const byFile = Map.groupBy(dead, (h) => h.file);
  for (const [file, list] of byFile) {
    const { src } = list[0].p;
    let next = src;
    for (const h of [...list].sort((a, b) => b.prop.start - a.prop.start)) {
      // From the end of the line before the entry's own comments to its comma.
      let start = h.prop.start;
      const before = src.slice(0, start);
      const own = before.match(/(?:\n[ \t]*(?:\/\/[^\n]*|\/\*(?:(?!\*\/)[\s\S])*\*\/))+\n[ \t]*$/u);
      start = own ? own.index : before.lastIndexOf('\n');
      let end = h.prop.end;
      const comma = src.slice(end).match(/^[ \t]*,/u);
      if (comma) end += comma[0].length;
      next = next.slice(0, start) + next.slice(end);
    }
    writeFileSync(file, unusedImportsDropped(next));
  }
  return dead;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const moved = write ? readRecords().map((c) => c.file) : [];
  for (const f of moved) console.log(`${relative(REPO, f)}: reads its record's schema`);
  const dead = write ? deleteDead() : deadHandSchemas();
  const touched = [...new Set([...moved, ...dead.map((h) => h.file)])];
  if (touched.length) execFileSync(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...touched]);
  for (const h of dead) console.log(`${relative(REPO, h.file)}:${h.line} ${h.name}`);
  console.log(`${dead.length} hand schema${dead.length === 1 ? '' : 's'} no caller names${write ? ', deleted' : ''}`);
}

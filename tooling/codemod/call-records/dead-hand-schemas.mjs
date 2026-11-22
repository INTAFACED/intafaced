#!/usr/bin/env node
// Deletes the bank's hand schemas no caller names: each entry of an area's `<area>Reads` or `<area>Writes` in
// apps/customer/src/features/money/contracts-<area>.ts (composed into `bankReads` and `bankWrites`) whose call name no
// string in the customer app spells, the entry's own key aside. A name built by a template that starts with a call's
// segment (`autoInvest.${action}`) names every entry it can spell; a template that starts with a value, or is a copy key
// (`t(`eligibility.${state}`)`), names none. A test or mock names an entry only by reading it from its map
// (`bankReads['x']`, `(typeof bankWrites)['x']`): its other strings are a stubbed answer or an expected request, not a
// caller. It deletes only entries nothing names, so it is safe at any time; run.mjs runs it after every service's run, so
// once a caller moves to its record (the call-records codemod), its entry goes in the same change.
//
//   node tooling/codemod/call-records/dead-hand-schemas.mjs [--write]
// Prints the entries it deletes (or would, without --write), one `<file>:<line> <name>` a line.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { keyOf, literal, load, walk } from './ast.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const MONEY = 'apps/customer/src/features/money';
const AREA_FILE = /\/contracts-[a-z-]+\.ts$/u;
const AREA_MAP = /^[a-z]+(Reads|Writes)$/u;
const CALL_NAME = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
/** A template's opening text that is a call name's first segments: `autoInvest.`, `cards.disputes.`. */
const CALL_HEAD = /^[a-z][A-Za-z0-9]*\.(?:[A-Za-z][A-Za-z0-9]*\.)*$/u;

/** A test, a browser test or a mock: what it spells is stubbed, not called (sites.mjs's tests, and `.mock.` files). */
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.(pw|mock)\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
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
    walk(p.program, (n) => {
      if (keys.has(n)) return;
      const s = literal(n);
      if (s !== undefined) {
        if (!test || mapRead(p, n)) exact.add(s);
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
    writeFileSync(file, next);
  }
  return dead;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const dead = write ? deleteDead() : deadHandSchemas();
  for (const h of dead) console.log(`${relative(REPO, h.file)}:${h.line} ${h.name}`);
  console.log(`${dead.length} hand schema${dead.length === 1 ? '' : 's'} no caller names${write ? ', deleted' : ''}`);
}

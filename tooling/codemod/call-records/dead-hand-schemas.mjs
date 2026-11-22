#!/usr/bin/env node
// Deletes the bank's hand schemas no caller names: each entry of an area's `<area>Reads` or `<area>Writes` in
// apps/customer/src/features/money/contracts-<area>.ts (composed into `bankReads` and `bankWrites`) whose call name no
// string in the customer app spells, the entry's own key aside. A name built by a template that starts with a call's
// segment (`autoInvest.${action}`) names every entry it can spell; a template that starts with a value names none. It deletes only entries nothing names, so it is safe at any time; once a caller moves
// to its record (the call-records codemod), its entry has no caller left and the next run deletes it.
//
//   node tooling/codemod/call-records/dead-hand-schemas.mjs [--write]
// Prints the entries it deletes (or would, without --write), one `<file>:<line> <name>` a line.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { keyOf, literal, load, walk } from './ast.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const MONEY = 'apps/customer/src/features/money';
const AREA_FILE = /\/contracts-[a-z-]+\.ts$/u;
const AREA_MAP = /^[a-z]+(Reads|Writes)$/u;
const CALL_NAME = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
/** A template's opening text that is a call name's first segments: `autoInvest.`, `cards.disputes.`. */
const CALL_HEAD = /^[a-z][A-Za-z0-9]*\.(?:[A-Za-z][A-Za-z0-9]*\.)*$/u;

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
    walk(p.program, (n) => {
      if (keys.has(n)) return;
      const s = literal(n);
      if (s !== undefined) exact.add(s);
      else if (n.type === 'TemplateLiteral' && CALL_HEAD.test(n.quasis[0].value.cooked ?? ''))
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
      const own = before.match(/(?:\n[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))+\n[ \t]*$/u);
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

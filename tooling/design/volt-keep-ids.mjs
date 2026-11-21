#!/usr/bin/env node
// Every element id a customer journey test finds by is still in the source (#9433): a Volt batch redraws rooms, and one
// that drops a `data-testid`, `data-cell` or `data-col` breaks a journey it may not even run. The ids are read from
// apps/customer/tests/real-app/*.pw.mjs as written literally (getByTestId('x'), [data-testid="x"], data-cell=x,
// data-col=x); an id is kept while some app or package source (apps/*/src, packages/*/src, tests left out) holds it as a
// quoted string, or starts with a template literal's leading text (`outline-item-${i}` keeps `outline-item-0-2`).
// volt-keep-ids.json lists today's ids no source holds that way; it only shrinks.
//   node tooling/design/volt-keep-ids.mjs           prints each id a journey finds by that no source holds
//   node tooling/design/volt-keep-ids.mjs --write   drops from volt-keep-ids.json each id now held, or no longer used
// Known limit: an id another app also holds is kept by that app, so its drop from a customer room is not seen here.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
export const ALLOWED = new URL('./volt-keep-ids.json', import.meta.url).pathname;

const walk = (dir, ok) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')
        ? []
        : walk(join(dir, e.name), ok)
      : ok(e.name)
        ? [join(dir, e.name)]
        : [],
  );
};

/** The ids journey test texts find by: `<kind> <value>` (kind testid, cell or col), each with the first file using it. */
export function journeyIds(tests) {
  const out = new Map();
  const add = (key, file) => out.has(key) || out.set(key, file);
  for (const [file, t] of tests) {
    for (const m of t.matchAll(/getByTestId\(\s*(['"])([^'"`$]+)\1/g)) add(`testid ${m[2]}`, file);
    for (const m of t.matchAll(/data-testid=\\?['"]?([A-Za-z0-9_:.-]+)/g)) add(`testid ${m[1]}`, file);
    for (const m of t.matchAll(/data-(cell|col)=\\?['"]?([A-Za-z0-9_:.-]+)/g)) add(`${m[1]} ${m[2]}`, file);
  }
  return out;
}

/** A reader of source texts: held(key) is true when some text can render it. A test id: held quoted anywhere, or begun
 *  by a template literal's leading text (three characters or more, before its first `${`). A cell or column: only on its
 *  own attribute (`data-cell="x"`, `data-col={'x'}`, `` data-col={`x-${k}`} ``), since its words ("amount", "state") are
 *  quoted all over the source. */
export function holder(texts) {
  const quoted = new Set();
  const prefixes = new Set();
  const attr = { cell: new Set(), col: new Set() };
  const attrPrefix = { cell: new Set(), col: new Set() };
  for (const t of texts) {
    for (const m of t.matchAll(/(['"`])([A-Za-z0-9_:.-]+)\1/g)) quoted.add(m[2]);
    for (const m of t.matchAll(/`([A-Za-z0-9_:.-]{3,})\$\{/g)) prefixes.add(m[1]);
    for (const m of t.matchAll(/['"]?data-(cell|col)['"]?\s*[=:]\s*\{?\s*(['"`])([A-Za-z0-9_:.-]*)(\$\{)?/g))
      if (!m[4]) attr[m[1]].add(m[3]);
      else if (m[3].length >= 3) attrPrefix[m[1]].add(m[3]);
  }
  const starts = (set, v) => [...set].some((p) => v.startsWith(p));
  return (key) => {
    const [kind, value] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    if (kind === 'testid') return quoted.has(value) || starts(prefixes, value);
    return attr[kind].has(value) || starts(attrPrefix[kind], value);
  };
}

/** The repo's journey tests and source texts, read from disk. */
export function readRepo(root = ROOT) {
  const tests = walk(join(root, 'apps/customer/tests/real-app'), (n) => n.endsWith('.mjs')).map((f) => [
    f.slice(root.length),
    readFileSync(f, 'utf8'),
  ]);
  const src = ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(root, top), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => walk(join(root, top, d.name, 'src'), (n) => /\.(tsx?|jsx?|mjs)$/.test(n) && !/\.(test|spec)\./.test(n))),
  );
  return { tests, texts: src.map((f) => readFileSync(f, 'utf8')) };
}

/** What the check reads: `missing` (used, not held, not allowed: the failure), `stale` (allowed, but held or unused). */
export function keepIds({ tests, texts }, allowed) {
  const ids = journeyIds(tests);
  const held = holder(texts);
  const unheld = [...ids].filter(([key]) => !held(key));
  const allow = new Set(allowed);
  return {
    used: ids.size,
    unheld: unheld.map(([key]) => key).sort(),
    missing: unheld.filter(([key]) => !allow.has(key)).map(([key, file]) => `${key} (${file})`),
    stale: allowed.filter((key) => !unheld.some(([k]) => k === key)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowed = JSON.parse(readFileSync(ALLOWED, 'utf8'));
  const r = keepIds(readRepo(), allowed);
  if (process.argv.includes('--write')) {
    const kept = allowed.filter((k) => r.unheld.includes(k));
    writeFileSync(ALLOWED, `${JSON.stringify(kept, null, 2)}\n`);
    process.stdout.write(`volt-keep-ids.json: ${allowed.length} -> ${kept.length}\n`);
  } else {
    process.stdout.write(
      `${r.used} ids used; ${r.unheld.length} no source holds (${r.missing.length} not allowed)\n${r.missing.join('\n')}\n`,
    );
    if (r.missing.length) process.exitCode = 1;
  }
}

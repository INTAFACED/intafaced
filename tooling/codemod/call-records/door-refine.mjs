// A Rust door's own names for its refines, and a `.refine` written with no message.
//
// A door runs each `.refine` of its TypeScript schemas as a Rust function it names (`crates/<service>/src/refines.rs`);
// its recorder holds the names, by each function's source (`crates/<service>/scripts/record-door.mjs`, `REFINES`). A
// refine written with a message is named in the record in that message's words (portable.mjs). One written with none
// (`.refine((args) => Object.keys(args).length <= 8)`) has no words of its own, and its router, read from the commit
// before its deletion, can no longer be given any: on a door run it takes the door's name for it, which is the rule in
// words already (`at_most_eight_keys`: "at most eight keys"). A refine the door does not name is left, as before.
//
// Such a refine raises zod's own words for a custom issue, not the record's, so samples.mjs is told where one sits
// (`quietRefineAt`) and which issue is its (`quietIssue`), and tries a few maps of growing size where a check sits
// (`KEY_MAPS`): a map one key too many is the input a key-count rule alone refuses.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keyOf, literal, load, walk } from './ast.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);

/**
 * A function's source in one printing, the one way every step compares refines (door-check.mjs, portable.mjs): tsc,
 * tsx, esbuild and prettier each print one differently, so it drops the spacing, a lone parameter's parentheses
 * (`(value) => …` as written, `value=>…` as tsx prints it), the semicolon a block body's last statement ends with (tsc
 * `=== day;\n}`, esbuild `===day}`), and reads esbuild's `void 0` as the `undefined` it was written as.
 */
export const squash = (s) =>
  s
    .replace(/\s+/g, '')
    .replace(/^(async)?\(([A-Za-z_$][\w$]*)\)=>/, '$1$2=>')
    .replace(/;}/g, '}')
    .replace(/\bvoid0\b/g, 'undefined');

/**
 * The door's names for its refines, by each function's squashed source: the `REFINES` table of the crate's recorder.
 * A crate with no recorder, or a recorder with no such table, names none.
 */
export function doorRefines(crateDir, root = REPO) {
  const out = new Map();
  const file = join(root, crateDir, 'scripts/record-door.mjs');
  if (!existsSync(file)) return out;
  walk(load(file).program, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || n.id.name !== 'REFINES') return;
    if (n.init?.type !== 'ObjectExpression') return;
    for (const pr of n.init.properties) {
      if (pr.type !== 'Property') continue;
      const src = keyOf(pr);
      const name = literal(pr.value);
      if (typeof src === 'string' && typeof name === 'string') out.set(squash(src), name);
    }
  });
  return out;
}

/** The door's name for a refine, as the rule in words: `at_most_eight_keys` says "at most eight keys". */
export const wordsOf = (name) => name.replace(/_/g, ' ');

/**
 * A zod part and each part it wraps (optional, nullable, default, readonly, lazy), and each option of a union it is: one
 * place in the input, to a check.
 */
function wrapped(s, depth = 0) {
  const out = [];
  for (let i = 0; s && i < 20; i++) {
    out.push(s);
    const d = s._zod.def;
    if (d.type === 'union' && depth < 5) for (const o of d.options) out.push(...wrapped(o, depth + 1));
    s = ['optional', 'nullable', 'default', 'readonly'].includes(d.type) ? d.innerType : d.type === 'lazy' ? d.getter() : undefined;
  }
  return out;
}

/**
 * True when a `.refine` written with no message sits at `steps` (`['items', '[]', 'reason']`) under `schema`, in any
 * option of a union on the way. A path the walk can't follow reads false: the check is then found by its own words only.
 */
export function quietRefineAt(schema, steps) {
  let here = wrapped(schema);
  for (const step of steps) {
    const next = [];
    for (const s of here) {
      const d = s._zod.def;
      if (step === '[]' && d.type === 'array') next.push(...wrapped(d.element));
      else if (step !== '[]' && d.type === 'object' && d.shape[step]) next.push(...wrapped(d.shape[step]));
    }
    here = next;
  }
  return here.some((s) => (s._zod.def.checks ?? []).some((c) => c._zod.def.check === 'custom' && c._zod.def.error === undefined));
}

/**
 * True when `issue` is the one a refine with no message raises where `steps` puts a tried value: zod's own words for a
 * custom issue (`quiet`, read from the records' own zod), at that very place (`[]` is the first element, where a value
 * is tried).
 */
export const quietIssue = (issue, steps, quiet) =>
  issue.message === quiet && JSON.stringify(issue.path) === JSON.stringify(steps.map((s) => (s === '[]' ? 0 : s)));

/** Maps of 2, 3, 5, 9, 17, 33 and 65 keys: one key more than each small limit a key-count rule is likely to set. */
export const KEY_MAPS = [2, 3, 5, 9, 17, 33, 65].map((n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i + 1}`, 'x'])));

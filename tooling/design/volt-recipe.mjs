#!/usr/bin/env node
// The Volt recipe's mechanical part (#9433): moves a room that is already on its template onto the kit, for the
// findings that need no judgement, and names every one it leaves. The rest of the recipe is tooling/design/RECIPE.md.
//   node tooling/design/volt-recipe.mjs <file under apps/customer/src> ...          prints what it would change and leave
//   node tooling/design/volt-recipe.mjs --write <file> ...                            writes the changes
// What it changes, and nothing else:
//   - `import { Button } from '@intafaced/ui'` becomes the kit's Button (`@intafaced/ui/lit`);
//   - on each <Button>: variant primary | secondary | ghost becomes tone primary | secondary | quiet; no variant
//     becomes tone="primary" (the old Button's default); `loading={x}` becomes `aria-busy={x || undefined}` (the
//     old Button's own disabled-while-loading stays the caller's `disabled`, which this refuses to guess: a
//     `loading` without a `disabled` naming it is left);
//   - className "field" | "text-link" | "sr-only" becomes the kit's "lt-field" | "lt-link" | "lt-sr".
// It leaves, with file:line: any other import from '@intafaced/ui', a Button prop the kit's has no twin for
// (size, shape, fullWidth, render, nativeButton, a variant other than the three), and any other own class.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../apps/customer/src/', import.meta.url).pathname;
const CLASSES = { field: 'lt-field', 'text-link': 'lt-link', 'sr-only': 'lt-sr' };
const TONES = { primary: 'primary', secondary: 'secondary', ghost: 'quiet' };
const NO_TWIN = /\s(size|shape|fullWidth|render|nativeButton)=/;

/** Rewrites the attributes of every `<Button ...>` opening tag; braces and quotes are skipped, so `=>` and `>` inside
 * an expression never end the tag. */
function eachButton(text, rewrite) {
  let out = '';
  let from = 0;
  for (const open of text.matchAll(/<Button\b/g)) {
    const start = open.index + open[0].length;
    let depth = 0;
    let quote = null;
    let end = start;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (quote) {
        if (ch === quote && text[end - 1] !== '\\') quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const selfClose = text[end - 1] === '/';
    const attrs = text.slice(start, selfClose ? end - 1 : end);
    out += text.slice(from, start) + rewrite(attrs, open.index) + (selfClose ? '/' : '');
    from = end;
  }
  return out + text.slice(from);
}

/** The recipe applied to one file's text: `{ text, changed, left }`, `left` as `line: why`. */
export function recipe(source) {
  const left = [];
  // Offsets are read against the text as it stands when each pass runs; no pass adds or drops a line.
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  let text = source;
  let changed = 0;

  const oldKit = /^import\s+\{([^}]*)\}\s+from\s+'@intafaced\/ui';\n/m;
  const m = oldKit.exec(text);
  const names = m
    ? m[1]
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    : [];
  if (m && !(names.length === 1 && names[0] === 'Button'))
    left.push(`${lineOf(m.index)}: imports ${names.join(', ')} from @intafaced/ui (only Button has a recipe)`);
  for (const other of text.matchAll(/from\s+'@intafaced\/ui\/(?!lit)[^']*'/g))
    left.push(`${lineOf(other.index)}: imports ${other[0].slice(5)}`);

  // The import moves only when every Button in the file moves with it: one old Button left keeps the old import whole.
  if (m && names.length === 1 && names[0] === 'Button') {
    const stuck = [];
    let moved = 0;
    const next = eachButton(text, (attrs, offset) => {
      const line = lineOf(offset);
      if (NO_TWIN.test(attrs)) {
        stuck.push(`${line}: <Button> with ${attrs.match(NO_TWIN)[1]}, which the kit's Button has no twin for`);
        return attrs;
      }
      let out = attrs;
      const variant = /\svariant="([a-z]+)"/.exec(out);
      if (variant && !TONES[variant[1]]) {
        stuck.push(`${line}: <Button variant="${variant[1]}">, which the kit has no tone for`);
        return attrs;
      }
      if (/\svariant=\{/.test(out)) {
        stuck.push(`${line}: <Button variant={…}>, computed, needs judgement`);
        return attrs;
      }
      const loading = /\sloading=\{([^}]*)\}/.exec(out);
      if (loading && !new RegExp(`disabled=\\{[^}]*${loading[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(out)) {
        stuck.push(`${line}: <Button loading={${loading[1]}}> without a disabled that names it`);
        return attrs;
      }
      out = variant ? out.replace(variant[0], ` tone="${TONES[variant[1]]}"`) : ` tone="primary"${out}`;
      if (loading) out = out.replace(loading[0], ` aria-busy={${loading[1]} || undefined}`);
      moved++;
      return out;
    });
    if (stuck.length > 0) left.push(...stuck);
    else {
      text = next.replace(oldKit, "import { Button } from '@intafaced/ui/lit';\n");
      changed += moved + 1;
    }
  }

  text = text.replace(/className="([^"]*)"/g, (whole, value, offset) => {
    const classes = value.split(/\s+/).filter(Boolean);
    const own = classes.filter((c) => !c.startsWith('lt-') && !CLASSES[c]);
    if (own.length > 0) {
      left.push(`${lineOf(offset)}: className "${value}" (${own.join(' ')} has no recipe)`);
      return whole;
    }
    const kit = classes.map((c) => CLASSES[c] ?? c).join(' ');
    if (kit === value) return whole;
    changed++;
    return `className="${kit}"`;
  });
  for (const dyn of text.matchAll(/className=\{/g)) left.push(`${lineOf(dyn.index)}: className={…}, computed, needs judgement`);
  return { text, changed, left };
}

const write = process.argv.includes('--write');
const files = process.argv.slice(2).filter((a) => a !== '--write');
if (import.meta.url === `file://${process.argv[1]}`) {
  if (files.length === 0) {
    process.stderr.write('usage: node tooling/design/volt-recipe.mjs [--write] <file under apps/customer/src> ...\n');
    process.exit(2);
  }
  for (const file of files) {
    const path = join(SRC, file);
    const { text, changed, left } = recipe(readFileSync(path, 'utf8'));
    if (write && changed > 0) writeFileSync(path, text);
    process.stdout.write(
      `${file}: ${changed} ${write ? 'changed' : 'to change'}, ${left.length} left${left.map((l) => `\n  ${l}`).join('')}\n`,
    );
  }
}

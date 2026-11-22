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
// It reads the file with a real parser (oxc-parser, as tooling/codemod/call-records does), so a quote or a backtick in
// a comment or in JSX text never moves a tag's end; it refuses a file that does not parse, and refuses to hand back
// text that does not parse or has a different line count, so a fault is an error, never a written file.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

const SRC = new URL('../../apps/customer/src/', import.meta.url).pathname;
const CLASSES = { field: 'lt-field', 'text-link': 'lt-link', 'sr-only': 'lt-sr' };
const TONES = { primary: 'primary', secondary: 'secondary', ghost: 'quiet' };
const NO_TWIN = new Set(['size', 'shape', 'fullWidth', 'render', 'nativeButton']);

/** The program of a room's text, or an Error naming the first place it does not parse. */
function parse(text, what) {
  const { program, errors } = parseSync('room.tsx', text);
  if (errors.length === 0) return program;
  const at = errors[0].labels?.[0]?.start;
  const line = at === undefined ? '' : ` at line ${text.slice(0, at).split('\n').length}`;
  throw new Error(`${what} does not parse${line}: ${errors[0].message}`);
}

/** Every node under `node`, in source order. */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

const attrName = (a) => (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' ? a.name.name : undefined);
const stringValue = (a) => (a.value?.type === 'Literal' && typeof a.value.value === 'string' ? a.value.value : undefined);

/** The recipe applied to one file's text: `{ text, changed, left }`, `left` as `line: why`. Throws when the file does
 * not parse, or when its own output would not. */
export function recipe(source) {
  const program = parse(source, 'the room');
  const left = [];
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  const edits = [];
  const code = (node) => source.slice(node.start, node.end);
  let changed = 0;

  const imports = [];
  const buttons = [];
  const classes = [];
  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') imports.push(node);
    else if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXIdentifier' && node.name.name === 'Button') buttons.push(node);
    else if (attrName(node) === 'className') classes.push(node);
  });

  const oldKit = imports.filter((i) => i.source.value === '@intafaced/ui');
  const onlyButton = (i) =>
    i.importKind !== 'type' &&
    i.specifiers.length === 1 &&
    i.specifiers[0].type === 'ImportSpecifier' &&
    i.specifiers[0].importKind !== 'type' &&
    i.specifiers[0].imported.name === 'Button' &&
    i.specifiers[0].local.name === 'Button';
  for (const i of oldKit.filter((i) => !onlyButton(i)))
    left.push(`${lineOf(i.start)}: imports ${i.specifiers.map(code).join(', ')} from @intafaced/ui (only Button has a recipe)`);
  for (const i of imports.filter((i) => /^@intafaced\/ui\/(?!lit)/.test(i.source.value)))
    left.push(`${lineOf(i.start)}: imports ${code(i.source)}`);

  // The import moves only when every Button in the file moves with it: one old Button left keeps the old import whole.
  if (oldKit.length === 1 && onlyButton(oldKit[0])) {
    const stuck = [];
    const moves = [];
    for (const button of buttons) {
      const line = lineOf(button.start);
      const attrs = new Map(button.attributes.map((a) => [attrName(a), a]));
      const noTwin = button.attributes.map(attrName).find((n) => NO_TWIN.has(n));
      if (noTwin) {
        stuck.push(`${line}: <Button> with ${noTwin}, which the kit's Button has no twin for`);
        continue;
      }
      const variant = attrs.get('variant');
      const tone = variant && TONES[stringValue(variant)];
      if (variant && stringValue(variant) === undefined) {
        stuck.push(`${line}: <Button variant={…}>, computed, needs judgement`);
        continue;
      }
      if (variant && !tone) {
        stuck.push(`${line}: <Button variant="${stringValue(variant)}">, which the kit has no tone for`);
        continue;
      }
      const loading = attrs.get('loading');
      const busy = loading?.value?.type === 'JSXExpressionContainer' ? code(loading.value.expression) : undefined;
      if (loading && busy === undefined) {
        stuck.push(`${line}: <Button ${code(loading)}>, not an expression, needs judgement`);
        continue;
      }
      const disabled = attrs.get('disabled');
      if (loading && !(disabled?.value?.type === 'JSXExpressionContainer' && code(disabled.value).includes(busy))) {
        stuck.push(`${line}: <Button loading={${busy}}> without a disabled that names it`);
        continue;
      }
      moves.push(
        variant
          ? { start: variant.start, end: variant.end, text: `tone="${tone}"` }
          : { start: button.name.end, end: button.name.end, text: ' tone="primary"' },
      );
      if (loading) moves.push({ start: loading.start, end: loading.end, text: `aria-busy={${busy} || undefined}` });
    }
    if (stuck.length > 0) left.push(...stuck);
    else {
      edits.push(...moves, { start: oldKit[0].start, end: oldKit[0].end, text: "import { Button } from '@intafaced/ui/lit';" });
      changed += buttons.length + 1;
    }
  }

  const computed = [];
  for (const attr of classes) {
    const value = stringValue(attr);
    if (value === undefined) {
      if (attr.value?.type === 'JSXExpressionContainer') computed.push(`${lineOf(attr.start)}: className={…}, computed, needs judgement`);
      continue;
    }
    const names = value.split(/\s+/).filter(Boolean);
    const own = names.filter((c) => !c.startsWith('lt-') && !CLASSES[c]);
    if (own.length > 0) {
      left.push(`${lineOf(attr.start)}: className "${value}" (${own.join(' ')} has no recipe)`);
      continue;
    }
    const kit = names.map((c) => CLASSES[c] ?? c).join(' ');
    if (kit === value) continue;
    edits.push({ start: attr.value.start, end: attr.value.end, text: `"${kit}"` });
    changed++;
  }
  left.push(...computed);

  // Each edit replaces one node of the source as parsed, never text it already replaced.
  edits.sort((a, b) => a.start - b.start);
  let text = '';
  let from = 0;
  for (const edit of edits) {
    if (edit.start < from) throw new Error(`two edits overlap at line ${lineOf(edit.start)}`);
    text += source.slice(from, edit.start) + edit.text;
    from = edit.end;
  }
  text += source.slice(from);
  parse(text, "the recipe's output");
  if (text.split('\n').length !== source.split('\n').length)
    throw new Error("the recipe's output has a different line count from the room's");
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
    let result;
    try {
      result = recipe(readFileSync(path, 'utf8'));
    } catch (error) {
      process.stderr.write(`${file}: refused, nothing written: ${error.message}\n`);
      process.exitCode = 1;
      continue;
    }
    const { text, changed, left } = result;
    if (write && changed > 0) writeFileSync(path, text);
    process.stdout.write(
      `${file}: ${changed} ${write ? 'changed' : 'to change'}, ${left.length} left${left.map((l) => `\n  ${l}`).join('')}\n`,
    );
  }
}

#!/usr/bin/env node
// The Volt recipe's mechanical part (#9433, #9793): moves a room onto the kit for the findings that need no judgement,
// and names every one it leaves. The rest of the recipe is tooling/design/RECIPE.md.
//   node tooling/design/volt-recipe.mjs <file under apps/customer/src> ...          prints what it would change and leave
//   node tooling/design/volt-recipe.mjs --write <file> ...                            writes the changes
//   node tooling/design/volt-recipe.mjs --plan                                        counts, over every customer .tsx
//                                                                                       but its tests, what it would change and leave
// What it changes, and nothing else:
//   - an `import { … } from '@intafaced/ui'` whose every part is in PARTS with a twin, when every use of each part
//     moves: the import becomes the kit's (`@intafaced/ui/lit`) and each tag is renamed to its twin;
//   - on each <Button>: variant primary | secondary | ghost becomes tone primary | secondary | quiet; no variant
//     becomes tone="primary" (the old Button's default); `loading={x}` becomes `aria-busy={x || undefined}` (the
//     old Button's own disabled-while-loading stays the caller's `disabled`, which this refuses to guess: a
//     `loading` without a `disabled` naming it is left);
//   - <Badge> becomes the kit's <Tag>, tone neutral | lime | up | down as neutral | accent | up | down (no tone: the
//     old default, neutral); <StatusTag status="pending|failed|filled" label={…}> becomes <StatusChip>, filled as done;
//   - a className written as a string whose every class is in CLASSES becomes the kit's classes.
// It leaves, with file:line: any other import from '@intafaced/ui' (PARTS says why, for the parts it has no twin for),
// a prop the kit's part has no twin for, a part used other than as a tag, and any other own class.
// It reads the file with a real parser (oxc-parser, as tooling/codemod/call-records does), so a quote or a backtick in
// a comment or in JSX text never moves a tag's end; it refuses a file that does not parse, and refuses to hand back
// text that does not parse or has a different line count, so a fault is an error, never a written file.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

const SRC = new URL('../../apps/customer/src/', import.meta.url).pathname;

/** The old classes with a one-to-one class in the kit (packages/ui/src/lit/templates/templates.css): each does the kit
 * class's job, the same role drawn in Volt's values. A class not here stays a finding for the redraw. */
export const CLASSES = {
  field: 'lt-field',
  'text-link': 'lt-link',
  'sr-only': 'lt-sr',
  // Secondary text: the colour only.
  muted: 'lt-muted',
  'money-caption': 'lt-muted',
  'text-fg-2': 'lt-muted',
  // Figures that line up: tabular digits, breaking anywhere rather than spilling.
  numeric: 'lt-num',
  // A column of parts with the kit's gap.
  stack: 'lt-stack',
  'form-stack': 'lt-stack',
  'bd-stack': 'lt-stack',
  'academy-lms-stack': 'lt-stack',
  // A wrapping row of controls.
  actions: 'lt-actions',
  'pp-actions': 'lt-actions',
  'cb-action-row': 'lt-actions',
  // Something that did not happen, with its reason and a way on: the kit's refusal box.
  failure: 'lt-refusal',
  // A small secondary line under a control or a figure.
  'pay-hint': 'lt-hint',
  'dk-note': 'lt-hint',
  'money-detail__note': 'lt-hint',
  'pay-cell-note': 'lt-hint',
  // A link or a button drawn as a button.
  button: 'lt-button',
  'button--primary': 'lt-button-primary',
  'button--secondary': 'lt-button-secondary',
};

const TONES = { primary: 'primary', secondary: 'secondary', ghost: 'quiet' };
const BADGE_TONES = { neutral: 'neutral', lime: 'accent', up: 'up', down: 'down' };
const STATUSES = { pending: 'pending', failed: 'failed', filled: 'done' };
const NO_TWIN = new Set(['size', 'shape', 'fullWidth', 'render', 'nativeButton']);
// Volt's faces carry no arrow glyphs: the kit draws a link's arrow (`lt-arrow`), so a typed one needs the redraw.
const ARROW = /[←-⇿]/u;

const attrName = (a) => (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' ? a.name.name : undefined);
const stringValue = (a) => (a.value?.type === 'Literal' && typeof a.value.value === 'string' ? a.value.value : undefined);

/** The old kit's parts (`@intafaced/ui`) and the kit's twin for each: `to` names it and `move` turns one tag's
 * attributes into edits, or says why that tag needs judgement; `why` says why a part has no twin. A part not here
 * is left whole. */
const PARTS = {
  Button: {
    to: 'Button',
    move(attrs, ctx) {
      const noTwin = attrs.list.map(attrName).find((n) => NO_TWIN.has(n));
      if (noTwin) return `with ${noTwin}, which the kit's Button has no twin for`;
      const variant = attrs.get('variant');
      if (variant && stringValue(variant) === undefined) return 'variant={…}, computed, needs judgement';
      const tone = variant && TONES[stringValue(variant)];
      if (variant && !tone) return `variant="${stringValue(variant)}", which the kit has no tone for`;
      const loading = attrs.get('loading');
      const busy = loading?.value?.type === 'JSXExpressionContainer' ? ctx.code(loading.value.expression) : undefined;
      if (loading && busy === undefined) return `${ctx.code(loading)}, not an expression, needs judgement`;
      const disabled = attrs.get('disabled');
      if (loading && !(disabled?.value?.type === 'JSXExpressionContainer' && ctx.code(disabled.value).includes(busy)))
        return `loading={${busy}} without a disabled that names it`;
      const edits = [variant ? { start: variant.start, end: variant.end, text: `tone="${tone}"` } : ctx.add(' tone="primary"')];
      if (loading) edits.push({ start: loading.start, end: loading.end, text: `aria-busy={${busy} || undefined}` });
      return edits;
    },
  },
  Badge: {
    to: 'Tag',
    move(attrs, ctx) {
      const noTwin = ['variant', 'density', 'icon'].find((n) => attrs.has(n));
      if (noTwin) return `with ${noTwin}, which the kit's Tag has no twin for`;
      const tone = attrs.get('tone');
      if (!tone) return [ctx.add(' tone="neutral"')];
      if (stringValue(tone) === undefined) return 'tone={…}, computed, needs judgement';
      const twin = BADGE_TONES[stringValue(tone)];
      if (!twin) return `tone="${stringValue(tone)}", which the kit's Tag has no tone for`;
      return [{ start: tone.start, end: tone.end, text: `tone="${twin}"` }];
    },
  },
  StatusTag: {
    to: 'StatusChip',
    move(attrs) {
      const other = attrs.list.map(attrName).find((n) => n !== 'status' && n !== 'label');
      if (other) return `with ${other}, which the kit's StatusChip has no twin for`;
      // The chip's own words differ from the tag's, so only a tag that names its words moves.
      if (!attrs.has('label')) return "without a label: the kit's StatusChip says other words";
      const status = attrs.get('status');
      const twin = status && STATUSES[stringValue(status)];
      if (!twin) return `status ${status ? (stringValue(status) ?? '{…}') : 'missing'}, which the kit's StatusChip has no twin for`;
      return twin === stringValue(status) ? [] : [{ start: status.start, end: status.end, text: `status="${twin}"` }];
    },
  },
  StateBlock: {
    why: "the kit's EmptyState draws its title as text, not the heading StateBlock draws, and loading, error and refused take other props (Skeleton, RefusalBox)",
  },
  DataTable: { why: "it takes its rows as children; the kit's Table takes rows and columns as data" },
  SubNav: { why: "it marks the current item by its id; the kit's Tabs marks it by its href" },
};

/** Whether a string written anywhere in `node` (a literal, either side of a choice) holds a typed arrow. */
function typedIn(node) {
  let typed = false;
  walk(node, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string' && ARROW.test(n.value)) typed = true;
    if (n.type === 'TemplateElement' && ARROW.test(n.value.raw)) typed = true;
  });
  return typed;
}

/** The program of a room's text, or an Error naming the first place it does not parse. */
function parse(text, what) {
  const { program, errors } = parseSync('room.tsx', text);
  if (errors.length === 0) return program;
  const at = errors[0].labels?.[0]?.start;
  const line = at === undefined ? '' : ` at line ${text.slice(0, at).split('\n').length}`;
  throw new Error(`${what} does not parse${line}: ${errors[0].message}`);
}

/** Every node under `node`, in source order, with its parent. */
function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}

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
  const elements = [];
  const classes = [];
  const names = [];
  const elementOf = new Map();
  walk(program, (node, parent) => {
    if (node.type === 'ImportDeclaration') imports.push(node);
    else if (node.type === 'JSXElement') {
      elementOf.set(node.openingElement, node);
      if (node.openingElement.name.type === 'JSXIdentifier') elements.push(node);
    } else if (attrName(node) === 'className') classes.push({ attr: node, opening: parent });
    else if (node.type === 'Identifier' || node.type === 'JSXIdentifier') names.push({ node, parent });
  });

  const oldKit = imports.filter((i) => i.source.value === '@intafaced/ui');
  const twinOf = (s) =>
    s.type === 'ImportSpecifier' && s.importKind !== 'type' && s.imported.name === s.local.name ? PARTS[s.imported.name] : undefined;
  for (const i of oldKit) {
    const parts = i.specifiers.map(twinOf);
    if (i.importKind !== 'type' && parts.length > 0 && parts.every((p) => p?.to)) continue;
    const why = i.specifiers
      .filter((s, n) => !parts[n]?.to)
      .map((s) => (twinOf(s)?.why ? `${s.local.name}: ${twinOf(s).why}` : `${code(s)}: no recipe`))
      .join('; ');
    left.push(`${lineOf(i.start)}: imports ${i.specifiers.map(code).join(', ')} from @intafaced/ui (${why})`);
  }
  for (const i of imports.filter((i) => /^@intafaced\/ui\/(?!lit)/.test(i.source.value)))
    left.push(`${lineOf(i.start)}: imports ${code(i.source)}`);

  // An import moves only when every tag of every part it brings moves with it: one old part left keeps the old import
  // whole, so no tag is left typed against the wrong kit.
  for (const i of oldKit.filter((i) => i.importKind !== 'type' && i.specifiers.length > 0 && i.specifiers.every((s) => twinOf(s)?.to))) {
    const stuck = [];
    const moves = [];
    let tags = 0;
    for (const s of i.specifiers) {
      const name = s.local.name;
      const part = PARTS[name];
      const line = (node) => lineOf(node.start);
      if (part.to !== name && names.some(({ node }) => node.name === part.to)) {
        stuck.push(`${line(i)}: <${name}>: ${part.to} is already a name in this file`);
        continue;
      }
      const other = names.find(
        ({ node, parent }) =>
          node.name === name && node.type === 'Identifier' && !(parent?.type === 'ImportSpecifier' && i.specifiers.includes(parent)),
      );
      if (other) {
        stuck.push(`${line(other.node)}: ${name} is used other than as a tag, needs judgement`);
        continue;
      }
      for (const el of elements.filter((e) => e.openingElement.name.name === name)) {
        const open = el.openingElement;
        if (open.attributes.some((a) => a.type !== 'JSXAttribute')) {
          stuck.push(`${line(open)}: <${name} {...}>, a spread, needs judgement`);
          continue;
        }
        const attrs = new Map(open.attributes.map((a) => [attrName(a), a]));
        attrs.list = open.attributes;
        const add = (text) => ({ start: open.name.end, end: open.name.end, text });
        const result = part.move(attrs, { code, add });
        if (typeof result === 'string') {
          stuck.push(`${line(open)}: <${name}> ${result}`);
          continue;
        }
        moves.push(...result);
        if (part.to !== name) {
          moves.push({ start: open.name.start, end: open.name.end, text: part.to });
          if (el.closingElement) moves.push({ start: el.closingElement.name.start, end: el.closingElement.name.end, text: part.to });
        }
        tags++;
      }
    }
    if (stuck.length > 0) left.push(...stuck);
    else {
      const to = i.specifiers.map((s) => PARTS[s.local.name].to).join(', ');
      edits.push(...moves, { start: i.start, end: i.end, text: `import { ${to} } from '@intafaced/ui/lit';` });
      changed += tags + 1;
    }
  }

  const computed = [];
  for (const { attr, opening } of classes) {
    const value = stringValue(attr);
    if (value === undefined) {
      if (attr.value?.type === 'JSXExpressionContainer') computed.push(`${lineOf(attr.start)}: className={…}, computed, needs judgement`);
      continue;
    }
    const names = value.split(/\s+/).filter(Boolean);
    const own = names.filter((c) => !c.startsWith('lt-') && !Object.hasOwn(CLASSES, c));
    if (own.length > 0) {
      left.push(`${lineOf(attr.start)}: className "${value}" (${own.join(' ')} has no recipe)`);
      continue;
    }
    const kit = [...new Set(names.map((c) => CLASSES[c] ?? c))].join(' ');
    if (kit === value) continue;
    const typed = (elementOf.get(opening)?.children ?? []).some(
      (c) => (c.type === 'JSXText' && ARROW.test(c.value)) || (c.type === 'JSXExpressionContainer' && typedIn(c.expression)),
    );
    if (typed) {
      left.push(`${lineOf(attr.start)}: className "${value}" on words with a typed arrow, which the kit draws (lt-arrow)`);
      continue;
    }
    edits.push({ start: attr.value.start, end: attr.value.end, text: `"${kit}"` });
    changed++;
  }
  left.push(...computed);

  // Each edit replaces one node of the source as parsed, never text it already replaced.
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
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
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--plan')) {
  const all = readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
  let changed = 0;
  let left = 0;
  for (const f of all) {
    const result = recipe(readFileSync(join(SRC, f), 'utf8'));
    changed += result.changed;
    left += result.left.length;
  }
  process.stdout.write(`${all.length} files: ${changed} to change, ${left} left\n`);
} else if (import.meta.url === `file://${process.argv[1]}`) {
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

#!/usr/bin/env node
// The Volt recipe's mechanical part (#9433, #9793): moves a room onto the kit for the findings that need no judgement,
// and names every one it leaves. The rest of the recipe is tooling/design/RECIPE.md.
//   node tooling/design/volt-recipe.mjs <file under apps/customer/src> ...          prints what it would change and leave
//   node tooling/design/volt-recipe.mjs --write <file> ...                            writes the changes
//   node tooling/design/volt-recipe.mjs --plan                                        counts, over every customer .tsx
//                                                                                       but its tests, what it would change and leave
//   node tooling/design/volt-recipe.mjs --plan --rank                                 and ranks the classes and parts left by count
// What it changes, and nothing else:
//   - an `import { … } from '@intafaced/ui'` whose every part is in PARTS with a twin, when every use of each part
//     moves: the import becomes the kit's (`@intafaced/ui/lit`) and each tag is renamed to its twin;
//   - on each <Button>: variant primary | secondary | ghost becomes tone primary | secondary | quiet; no variant
//     becomes tone="primary" (the old Button's default); `loading={x}` becomes `aria-busy={x || undefined}` (the
//     old Button's own disabled-while-loading stays the caller's `disabled`, which this refuses to guess: a
//     `loading` without a `disabled` naming it is left);
//   - <Badge> becomes the kit's <Tag>, tone neutral | lime | up | down as neutral | accent | up | down (no tone: the
//     old default, neutral); <StatusTag status="pending|failed|filled" label={…}> becomes <StatusChip>, filled as done;
//   - a className written as a string whose every class is in CLASSES becomes the kit's classes; a class in GONE, which
//     no stylesheet names, is dropped from it.
// It leaves, with file:line: any other import from '@intafaced/ui' (PARTS says why, for the parts it has no twin for),
// a prop the kit's part has no twin for, a part used other than as a tag, any other own class, and a class a test or a
// journey finds an element by (`.name` in a string of a test file), which would stop finding it.
// It reads the file with a real parser (oxc-parser, as tooling/codemod/call-records does), so a quote or a backtick in
// a comment or in JSX text never moves a tag's end; it refuses a file that does not parse, and refuses to hand back
// text that does not parse or has a different line count, so a fault is an error, never a written file.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

const SRC = new URL('../../apps/customer/src/', import.meta.url).pathname;

/** The second map (#10049). Each class here is drawn by rules on its own element only, which say what the kit class
 * says (read from the stylesheets on 23 Nov 2026; the test holds that no rule reaches another element through the
 * name), so nothing else is lost with it. */
export const ONE_RULE = {
  // Parts one under another with a gap: a flex column, or a one-column grid.
  'pay-body': 'lt-stack',
  'more-grid': 'lt-stack',
  'orders-room': 'lt-stack',
  'of-section': 'lt-stack',
  'of-col': 'lt-stack',
  'of-queue': 'lt-stack',
  'bd-recipient': 'lt-stack',
  'money-detail__head': 'lt-stack',
  'money-detail__skeleton': 'lt-stack',
  'money-act__parts': 'lt-stack',
  'pay-recent__section': 'lt-stack',
  'pay-waiting__item': 'lt-stack',
  'p2p-chat': 'lt-stack',
  'p2p-chat-item': 'lt-stack',
  'cvt-limit': 'lt-stack',
  'depth-step-main': 'lt-stack',
  'market-purchases-value': 'lt-stack',
  'mining-room-status': 'lt-stack',
  'trade-tools': 'lt-stack',
  'st-settings': 'lt-stack',
  'dk-ledger': 'lt-stack',
  // Secondary text: the colour only.
  'mkt-muted': 'lt-muted',
  'pay-muted': 'lt-muted',
  'pp-none': 'lt-muted',
  'dw-badge': 'lt-muted',
  'dk-saved-facts': 'lt-muted',
  'depth-reason': 'lt-muted',
  'cw-replay-note': 'lt-muted',
  // Words only assistive tech reads.
  'pp-sr': 'lt-sr',
  'pfo-sr': 'lt-sr',
  'wl-sr': 'lt-sr',
  'money-visually-hidden': 'lt-sr',
  'money-execution-label': 'lt-sr',
  // A long unbroken value that breaks anywhere; one that also keeps its own line breaks.
  'pp-wrap': 'lt-wrap',
  'money-act__ref': 'lt-wrap',
  'money-standing-row-reference': 'lt-wrap',
  'verification__selfie-link': 'lt-wrap',
  'p2p-order-terms': 'lt-pre-wrap',
  // A wrapping row of controls or links.
  'support-chat__actions': 'lt-actions',
  'money-activity-related': 'lt-actions',
  'st-chips': 'lt-actions',
  'dk-note-actions': 'lt-actions',
  // Figures that line up: tabular digits only.
  'tb-option-price': 'lt-num',
  'mkt-volume': 'lt-num',
  // A small secondary line with no margin of its own.
  'wl-note': 'lt-hint',
};

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
  'cb-form': 'lt-stack',
  // A wrapping row of controls.
  actions: 'lt-actions',
  'pp-actions': 'lt-actions',
  'cb-action-row': 'lt-actions',
  'pay-row-actions': 'lt-actions',
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
  ...ONE_RULE,
};

/** Classes still written in rooms that no stylesheet names (the test reads the stylesheets and holds it so) and nothing
 * else names either: they draw nothing, so the recipe drops them. A className left with none loses the attribute. */
export const GONE = new Set([
  'pp-form',
  'pp-count',
  'pp-line',
  'pp-table',
  'p2p-order-result',
  'bd-addresses',
  'money-form-facts',
  'money-list',
]);

const TESTS = new URL('../../apps/customer/', import.meta.url).pathname;

/** The class names a test file's text selects by: a `.name` that starts a selector or follows a combinator (after a
 * quote, a space, `>`, `+`, `~`, `,` or `(`), and any `.name` with a hyphen, which no property access has. It takes too
 * many (a method called at the start of a line) rather than too few. */
export function classesIn(text) {
  // A selector that already takes either name, `:is(.form-stack, .lt-stack)`, finds the element after the move too.
  const either = /:is\(([^()]*)\)/g;
  const rest = text.replace(either, (group, inner) => {
    const names = inner.split(',').map((s) => s.trim());
    const old = names.filter((n) => !n.startsWith('.lt-'));
    return old.length > 0 && old.every((n) => /^\.[\w-]+$/.test(n) && names.includes(`.${CLASSES[n.slice(1)]}`)) ? '' : group;
  });
  const names = [...rest.matchAll(/(?<=['"`\s>+~,(])\.(-?[_a-zA-Z][\w-]*)/g), ...rest.matchAll(/\.(-?[_a-zA-Z]\w*-[\w-]*)/g)];
  return names.map((m) => m[1]);
}

/**
 * Every class a test or a journey finds an element by: classesIn over the customer app's test files (`*.test.ts(x)`,
 * `*.pw.mjs`, everything under `tests/`). A selector it cannot read (built from parts, or `div.name` with no hyphen) is
 * not seen, so the customer unit tests and the journeys stay the judge; this stops the ones it can see.
 */
export function classesTestsFind(root = TESTS) {
  const found = new Set();
  const read = (dir, all) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'look-baselines', 'render-record'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) read(path, all || entry.name === 'tests');
      else if (/\.(tsx?|mjs|js)$/.test(entry.name) && (all || /\.(test|spec|pw)\.(tsx?|mjs|js)$/.test(entry.name)))
        for (const name of classesIn(readFileSync(path, 'utf8'))) found.add(name);
    }
  };
  read(root, false);
  return found;
}

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
  EmptyState: {
    why: "it takes its action as data ({ label, onClick or href }) and a variant, reason, code and size; the kit's EmptyState takes a title, a body and an action drawn by the room",
  },
  Table: {
    why: "its columns are { id, header, value, cell } and it sorts itself; the kit's Table takes a caption and its own column shape, and is handed its sort",
  },
  KeyValue: { why: "it takes items ({ label, value, hint, mono, asOf }); the kit's KeyValue takes rows ({ label, value, note, ltr })" },
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

/** The recipe applied to one file's text: `{ text, changed, left }`, `left` as `line: why`. `found` is the classes a
 * test finds an element by (classesTestsFind), which stay as written. Throws when the file does not parse, or when its
 * own output would not. */
export function recipe(source, { found = new Set() } = {}) {
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
    const own = names.filter((c) => !c.startsWith('lt-') && !Object.hasOwn(CLASSES, c) && !GONE.has(c));
    if (own.length > 0) {
      left.push(`${lineOf(attr.start)}: className "${value}" (${own.join(' ')} has no recipe)`);
      continue;
    }
    const kit = [...new Set(names.filter((c) => !GONE.has(c)).map((c) => CLASSES[c] ?? c))].join(' ');
    if (kit === value) continue;
    const typed = (elementOf.get(opening)?.children ?? []).some(
      (c) => (c.type === 'JSXText' && ARROW.test(c.value)) || (c.type === 'JSXExpressionContainer' && typedIn(c.expression)),
    );
    if (typed) {
      left.push(`${lineOf(attr.start)}: className "${value}" on words with a typed arrow, which the kit draws (lt-arrow)`);
      continue;
    }
    const held = names.filter((c) => !c.startsWith('lt-') && found.has(c));
    if (held.length > 0) {
      left.push(`${lineOf(attr.start)}: className "${value}" (a test finds an element by ${held.join(' ')}, needs judgement)`);
      continue;
    }
    if (kit === '') {
      // Nothing left to say: the attribute goes with the one space before it. Alone on its line, it is left.
      if (source[attr.start - 1] !== ' ' || /\s/.test(source[attr.start - 2] ?? ' ')) {
        left.push(`${lineOf(attr.start)}: className "${value}" (no stylesheet names it: delete the attribute and its line)`);
        continue;
      }
      edits.push({ start: attr.start - 1, end: attr.end, text: '' });
      changed++;
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

/** The classes and old-kit parts the left lines name, commonest first, as `count name`: what the next map is chosen from. */
export function rank(lefts) {
  const classes = new Map();
  const parts = new Map();
  const count = (map, name) => map.set(name, (map.get(name) ?? 0) + 1);
  for (const line of lefts) {
    const own = line.match(/className "[^"]*" \((.*) has no recipe\)$/);
    if (own) for (const c of own[1].split(' ')) count(classes, c);
    const old = line.match(/imports (.*) from @intafaced\/ui \(/);
    if (old) for (const p of old[1].split(', ')) count(parts, p);
  }
  const top = (map) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${n} ${name}`);
  return { classes: top(classes), parts: top(parts) };
}

const write = process.argv.includes('--write');
const files = process.argv.slice(2).filter((a) => a !== '--write' && a !== '--rank');
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--plan')) {
  const all = readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
  const found = classesTestsFind();
  let changed = 0;
  const left = [];
  for (const f of all) {
    const result = recipe(readFileSync(join(SRC, f), 'utf8'), { found });
    changed += result.changed;
    left.push(...result.left);
  }
  process.stdout.write(`${all.length} files: ${changed} to change, ${left.length} left\n`);
  if (process.argv.includes('--rank')) {
    const { classes, parts } = rank(left);
    process.stdout.write(
      `old-kit parts left:\n  ${parts.join('\n  ')}\nown classes left (the 60 commonest of ${classes.length}):\n  ${classes.slice(0, 60).join('\n  ')}\n`,
    );
  }
} else if (import.meta.url === `file://${process.argv[1]}`) {
  if (files.length === 0) {
    process.stderr.write('usage: node tooling/design/volt-recipe.mjs [--write] <file under apps/customer/src> ...\n');
    process.exit(2);
  }
  const found = classesTestsFind();
  for (const file of files) {
    const path = join(SRC, file);
    let result;
    try {
      result = recipe(readFileSync(path, 'utf8'), { found });
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

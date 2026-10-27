#!/usr/bin/env node
/**
 * LOOK DRIFT — new customer-app and UI-kit code takes its look from the kit's role tokens, never from raw values.
 *
 * Reads the diff against origin/main and, in `apps/customer/**` and `packages/ui/src/lit/templates/**` (the rooms and
 * the templates rooms are built from), fails on any ADDED line (and
 * every line of a NEW file) that carries:
 *   1. a raw colour: `#hex`, `rgb()`/`hsl()`/`oklch()`… with literal numbers, a named colour as a CSS value, or a
 *      Tailwind palette or arbitrary colour (`bg-red-500`, `text-white`, `bg-[#123]`);
 *   2. a pixel size: `12px` in CSS (outside `@media`/`@container` queries, where custom properties cannot go), in a
 *      style string, or as a Tailwind arbitrary value (`w-[12px]`). `0px` and `1px` pass, and so do line weights of
 *      2px or less on borders, outlines and focus rings (the kit has no token for them). Spacing has `--if-space-*`;
 *      a size with no token is written in rem;
 *   3. a physical side instead of a logical one: `margin-left`, `padding-right`, `border-left`, `left:`/`right:`,
 *      `text-align: left`, `float: right`, physical corner radii, their camelCase style keys (`marginLeft`), and the
 *      Tailwind classes (`ml-2`, `pr-4`, `left-0`, `border-l`, `rounded-tl`, `text-right`). Use `*-inline-start`,
 *      `inset-inline-*`, `text-align: start`, `ms-2`, `pe-4`, `start-0`, `border-s`, `rounded-ss`, `text-end`;
 *   4. in the new look only (the kit under `packages/ui/src/lit/` and a migrated room: a folder under
 *      `apps/customer/src/{screens,features}/` whose files import the lit kit, as the look gate counts them), a top or
 *      bottom side instead of a block one: `margin-top`, `padding-bottom`, `border-top`, `top:`/`bottom:`, `marginTop`,
 *      and the Tailwind classes (`mt-2`, `pb-4`, `top-0`, `border-b`). Use `*-block-start`/`*-block-end`,
 *      `inset-block-*`, `mbs-2`, `pbe-4`, `inset-bs-0`, `border-be` (B4's rule: the look turns with the writing mode).
 * Colours and sizes come from `var(--lit-*)` (packages/ui/src/lit/contracts.ts) or today's `var(--if-*)`.
 *
 * It ratchets: lines already on main are not judged, so code other threads add comes in on the system while the
 * rest moves room by room. `--all` reports the whole tree's count (how far the migration has to go) and never fails.
 *
 * Not judged: the files that define the token values (`packages/ui/src/theme/**`, `packages/ui/src/tokens.*`,
 * `packages/ui/src/lit/tokens.ts`, `packages/ui/src/lit/lit.css`), generated files, tests and fixtures, the kit's TEST
 * galleries (`__gallery__/`, outside the app bundle, as for the money-as-float scan), comments (including every line of
 * a block comment that spans lines), images. `.js`, `.jsx` and `.scss` are not judged: nothing in these folders is written in
 * them (in `apps/customer` only vendored bundles and the tiny classic scripts under `public/` are `.js`), so a minified
 * vendor file would only drown the report. A room written in one of them would need adding here first.
 * A line that must carry a raw value (a third party's brand colour drawn as is) ends with a comment
 * `look-drift-allow: <reason>`; the run prints every such line so the reviewer sees them.
 *
 * Rules come from MAIN, as for test-diff-guard: CI runs the copy on origin/main.
 *
 *   node tooling/ci/look-drift.mjs              changed lines against origin/main (GUARD_BASE to change it)
 *   node tooling/ci/look-drift.mjs --all        whole-tree report, never fails
 *   node tooling/ci/look-drift.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The rooms, and the new look's kit and templates. The kit's own components (packages/ui/src/lit/ outside templates/)
// may hold structural pixel sizes (hairlines, icon boxes); colours and sides are judged there too.
const SCOPE = /^(?:apps\/customer\/|packages\/ui\/src\/lit\/).+\.(?:css|tsx?|mjs)$/;
const PX_ALLOWED = /^packages\/ui\/src\/lit\/(?!templates\/)/;
const NOT_JUDGED =
  /^packages\/ui\/src\/(?:theme\/|tokens\.|lit\/tokens\.ts$|lit\/lit\.css$)|\.generated\.|(?:\.|\/)(?:test|spec|fixtures?|pw|stories)\.|\/__tests__\/|\/__gallery__\/|\/tests\/|(?:^|[./])playwright\.config\.|(?:^|[./])vitest[\w.]*\.config\.|(?:^|[./])vite\.config\.|\.d\.ts$/;
const ALLOW = /look-drift-allow:\s*\S.{3,}/;

const NAMED =
  'white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|gold|navy|teal|cyan|magenta|lime|maroon|olive|aqua|fuchsia|brown|indigo|violet';
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const TW_COLOUR_PREFIX =
  'bg|text|border(?:-[xytrblse])?|ring|ring-offset|fill|stroke|from|via|to|shadow|outline|decoration|accent|caret|divide|placeholder';

/** Rule checks for one line of CSS. */
const CSS_RULES = [
  ['raw colour', /(?<![\w&-])#[0-9a-fA-F]{3,8}\b/],
  ['raw colour', /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*[\d.]/],
  ['raw colour', new RegExp(`(?:^|[:\\s,(])(?:${NAMED})\\s*(?:;|!|$|\\)|})`, 'i')],
  ['pixel size', /(?<![\w.])-?(?!0px\b|1px\b)\d*\.?\d+px\b/],
  [
    'physical side',
    /(?:^|[\s;{])(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)\b|(?:^|[\s;{])(?:left|right)\s*:|border-(?:top|bottom)-(?:left|right)-radius|(?:text-align|float|clear)\s*:\s*(?:left|right)\b/,
  ],
];

/** Rule 4, block sides, judged only in the new look (see `blockSides`). A physical corner is rule 3's, never also 4's. */
const CSS_BLOCK =
  /(?:^|[\s;{])(?:margin|padding|border|scroll-margin|scroll-padding)-(?:top|bottom)(?!\w|-(?:left|right)-)|(?:^|[\s;{])(?:top|bottom)\s*:/;
const TS_BLOCK = [
  // A style key or a style write, not a measurement read (`const { marginTop } = getComputedStyle(el)`).
  /\b(?:margin|padding|border|scrollMargin|scrollPadding)(?:Top|Bottom)(?:Width|Color|Style)?\s*:|\.style\.(?:margin|padding|border)(?:Top|Bottom)\w*\s*=/,
  /['"`][^'"`]*\b(?:margin|padding|border)-(?:top|bottom)(?!\w|-(?:left|right)-)[^'"`]*['"`]/,
];
const TW_BLOCK =
  /(?<![\w-])-?(?:(?:mt|mb|pt|pb|top|bottom|scroll-mt|scroll-mb|scroll-pt|scroll-pb)-(?:\d[\w./]*|px|auto|full|\[[^\]]+\]|\([^)]+\))|(?:border-t|border-b|rounded-t|rounded-b)(?:-[\w./[\]()%-]+)?)(?![\w-])/;

const TW_PHYSICAL =
  /(?<![\w-])-?(?:(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-(?:\d[\w./]*|px|auto|full|\[[^\]]+\])|(?:border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)(?:-[\w./[\]%-]+)?)(?![\w-])|(?<![\w-])(?:text|float|clear)-(?:left|right)(?![\w-])/;
/** Rule checks for one line of TS/TSX/MJS: style strings, style keys and class names, not ordinary code. */
const TS_RULES = [
  // A hex inside a string counts only when the string is CSS (`'drop-shadow(0 0 4px #3f7dff)'`), not copy (`'Order #123'`).
  ['raw colour', /['"`](?=[^'"`]*(?:\(|\b[a-z-]+\s*:|\b(?:solid|dashed|dotted)\b))[^'"`]*[\s(:,]#[0-9a-fA-F]{3,8}\b[^'"`]*['"`]/],
  ['raw colour', /['"`][^'"`]*\b(?:rgba?|hsla?|oklch|oklab)\(\s*[\d.][^'"`]*['"`]/],
  ['raw colour', new RegExp(`(?<![\\w-])(?:${TW_COLOUR_PREFIX})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?![\\w-])`)],
  ['raw colour', /-\[(?:#|rgba?\(|hsla?\()/],
  ['pixel size', /['"`][^'"`]*(?<![\w.])-?(?!0px\b|1px\b)\d*\.?\d+px\b[^'"`]*['"`]/],
  ['pixel size', /-\[\d*\.?\d+px\]/],
  [
    'physical side',
    /\b(?:margin|padding|border|scrollMargin|scrollPadding)(?:Left|Right)\b|\bborder(?:Top|Bottom)(?:Left|Right)Radius\b|\b(?:textAlign|float)\s*:\s*['"](?:left|right)['"]/,
  ],
  // CSS written inside a string: `'margin-left: 4px'`.
  ['physical side', /['"`][^'"`]*\b(?:(?:margin|padding|border)-(?:left|right)\b|(?:text-align|float)\s*:\s*(?:left|right)\b)[^'"`]*['"`]/],
];
/** A string that is only a hex colour, unless it is the value of a link or anchor attribute (`href="#add"`). */
const TS_BARE_HEX = /['"`]#[0-9a-fA-F]{3,8}['"`]/g;
const LINK_BEFORE = /\b(?:href|to|hash|anchor|id|htmlFor)\s*[=:]\s*\{?\s*$/;
/** A class-name context on a TS line: only there are Tailwind side classes judged. */
const CLASS_CONTEXT = /\bclassName\b|\bclass=|\b(?:cn|cx|clsx|cva|twMerge|tv)\(|\btw`/;

/** The string literals on a line, leaving out the values of label-like attributes (`aria-label="Move left"`). */
function classStrings(code) {
  const out = [];
  for (const m of code.matchAll(/(?:\b(aria-[\w-]+|title|alt|placeholder|label|children)\s*[=:]\s*\{?\s*)?(["'`])((?:(?!\2).)*)\2/g))
    if (!m[1]) out.push(m[3]);
  return out;
}

/**
 * The declaration part of a CSS line: the text after the last `{`, without attribute selectors. A line that is only a
 * selector (`#add,` or `.a:hover {`) has none, so ids such as `#add` or `#face` are never read as colours; a value
 * carried over from the line before (`#0a0a0a 3%,` in a gradient) still is.
 */
function cssDeclarations(code) {
  const after = code.includes('{') ? code.slice(code.lastIndexOf('{') + 1) : code;
  const text = after.replace(/\[[^\]]*\]/g, '');
  const selectorOnly = !code.includes('{') && /,\s*$/.test(text) && !text.includes(';') && !/%|\(|\d(?:px|rem|em|deg)\b/.test(text);
  return selectorOnly ? '' : text;
}

/** Findings for one line. `kind` is 'css' or 'ts'; `state` carries whether we are inside an @media/@container block. */
export function judgeLine(line, kind, state = { query: 0 }, { newLook = false } = {}) {
  if (ALLOW.test(line)) return [];
  const code =
    kind === 'css'
      ? line.replace(/\/\*.*?\*\//g, '')
      : /^\s*(?:\*|\/\*)/.test(line)
        ? ''
        : line
            .replace(/\/\*.*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/, '$1')
            // Tailwind breakpoint variants are queries: `min-[1000px]:hidden`.
            .replace(/(?<![\w-])(?:min|max)-\[\d*\.?\d+px\]:/g, '')
            // Media query strings (`matchMedia('(min-width: 768px)')`) cannot take custom properties.
            .replace(/\((?:min-|max-)?(?:width|height)\s*:\s*\d*\.?\d+px\)/g, '()');
  const found = new Set();
  if (kind === 'css') {
    const query = /@(?:media|container)\b/.test(code) || state.query > 0;
    const decl = cssDeclarations(code);
    // Borders, outlines and focus rings of 2px or less are line weights the kit has no token for; they pass.
    const weights = /^\s*(?:border|outline|text-decoration|text-underline|stroke|column-rule)[\w-]*\s*:/.test(decl)
      ? decl.replace(/(?<![\w.])-?(?:2|1\.5|0\.5)px\b/g, '')
      : decl;
    for (const [rule, re] of CSS_RULES) {
      if (rule === 'pixel size' && query) continue;
      if (re.test(rule === 'pixel size' ? weights : decl)) found.add(rule);
    }
    if (newLook && CSS_BLOCK.test(decl)) found.add('top or bottom side');
    return [...found];
  }
  for (const [rule, re] of TS_RULES) if (re.test(code)) found.add(rule);
  for (const m of code.matchAll(TS_BARE_HEX)) if (!LINK_BEFORE.test(code.slice(0, m.index))) found.add('raw colour');
  if (CLASS_CONTEXT.test(code) && classStrings(code).some((c) => TW_PHYSICAL.test(c))) found.add('physical side');
  if (newLook && (TS_BLOCK.some((re) => re.test(code)) || (CLASS_CONTEXT.test(code) && classStrings(code).some((c) => TW_BLOCK.test(c)))))
    found.add('top or bottom side');
  return [...found];
}

/**
 * The line without its comments, carrying an open block comment across lines in `state.comment`. Quotes are respected, and
 * in TS a `//` ends the line (judgeLine strips it), so a comment opener inside a string or after `//` opens nothing.
 */
function withoutComments(line, kind, state) {
  let out = '';
  let quote = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (state.comment) {
      if (c === '*' && line[k + 1] === '/') ((state.comment = false), k++);
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') out += line[++k] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '/' && line[k + 1] === '*') ((state.comment = true), k++);
    else if (kind === 'ts' && c === '/' && line[k + 1] === '/') return out + line.slice(k);
    else {
      if (c === '"' || c === "'" || (kind === 'ts' && c === '`')) quote = c;
      out += c;
    }
  }
  return out;
}

/**
 * A room folder under apps/customer/src/{screens,features}/, as the look gate's `migratedRoomOf` (look-gate/policy.mjs)
 * reads it. Copied, not imported: CI runs this file alone from main.
 */
const ROOM = /^(apps\/customer\/src\/(?:screens|features)\/[^/]+)\//;

/** Whether rule 4 (block sides) applies: the lit kit, or a migrated room (a folder in `rooms`). */
export function blockSides(path, rooms) {
  return path.startsWith('packages/ui/src/lit/') || rooms.has(ROOM.exec(path)?.[1]);
}

/** The migrated room folders: those with a file whose import statement takes the lit kit (the PR's head tree). */
function litRooms() {
  let out = '';
  try {
    out = git([
      'grep',
      '-l',
      '-E',
      '^\\s*(import\\b.*|\\}\\s*)from\\s+[\'"]@intafaced/ui/(src/)?lit\\b',
      '--',
      'apps/customer/src/screens',
      'apps/customer/src/features',
    ]);
  } catch (error) {
    // git grep exits 1 when nothing matches: no room is migrated yet. Anything else is a broken check, never a pass.
    if (error.status !== 1) throw error;
  }
  return new Set(
    out
      .split('\n')
      .map((p) => ROOM.exec(p)?.[1])
      .filter(Boolean),
  );
}

/** Judge a file's lines; `only` limits findings to these 1-based line numbers (null = all). `rooms`: the migrated rooms. */
export function judgeFile(path, text, only = null, rooms = new Set()) {
  if (!SCOPE.test(path) || NOT_JUDGED.test(path)) return { findings: [], allowed: [] };
  const kind = path.endsWith('.css') ? 'css' : 'ts';
  const look = { newLook: blockSides(path, rooms) };
  const findings = [];
  const allowed = [];
  const state = { query: 0 };
  const comments = { comment: false };
  // CSS only: which brace depths opened an @media or @container block, read past strings and comments.
  let depth = 0;
  let pendingQuery = false;
  let inComment = false;
  const queryDepths = [];
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (kind === 'css') {
      if (/@(?:media|container)\b/.test(line)) pendingQuery = true;
      state.query = queryDepths.length + (pendingQuery ? 1 : 0);
      let quote = null;
      for (let k = 0; k < line.length; k++) {
        const c = line[k];
        if (inComment) {
          if (c === '*' && line[k + 1] === '/') ((inComment = false), k++);
        } else if (quote) {
          if (c === '\\') k++;
          else if (c === quote) quote = null;
        } else if (c === '/' && line[k + 1] === '*') ((inComment = true), k++);
        else if (c === '"' || c === "'") quote = c;
        else if (c === '{') {
          if (pendingQuery) (queryDepths.push(depth), (pendingQuery = false));
          depth++;
        } else if (c === '}') {
          depth--;
          if (queryDepths.length && queryDepths[queryDepths.length - 1] === depth) queryDepths.pop();
        }
      }
    }
    const code = withoutComments(line, kind, comments);
    if (only && !only.has(n)) return;
    if (ALLOW.test(line)) {
      allowed.push({ path, line: n, text: line.trim().slice(0, 140) });
      return;
    }
    for (const rule of judgeLine(code, kind, state, look))
      if (!(rule === 'pixel size' && PX_ALLOWED.test(path))) findings.push({ path, line: n, rule, text: line.trim().slice(0, 140) });
  });
  return { findings, allowed };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Changed files in scope with the added line numbers (null = a new file, judge it all). Renames are followed, so a
 * moved file is judged only on the lines the move changed.
 */
function changed(base) {
  const out = [];
  let file = null;
  for (const l of git(['diff', '-M', '-U0', '--diff-filter=AMR', `${base}...HEAD`, '--', 'apps/customer', 'packages/ui/src/lit']).split(
    '\n',
  )) {
    if (l.startsWith('diff --git ')) {
      file = { path: null, only: new Set() };
      out.push(file);
    } else if (!file) continue;
    else if (l.startsWith('new file mode')) file.only = null;
    else if (l.startsWith('+++ ')) file.path = l.slice(4).replace(/^b\//, '');
    else if (l.startsWith('rename to ')) file.path = l.slice('rename to '.length);
    else {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m && file.only) for (let k = 0; k < (m[2] === undefined ? 1 : Number(m[2])); k++) file.only.add(Number(m[1]) + k);
    }
  }
  return out.filter((f) => f.path && SCOPE.test(f.path) && !NOT_JUDGED.test(f.path));
}

function selfTest() {
  let fixtures = 0;
  const eq = (got, want, m) => {
    fixtures++;
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const css = (l) => judgeLine(l, 'css');
  const ts = (l) => judgeLine(l, 'ts');
  // CSS
  eq(css('  color: #3f7dff;'), ['raw colour'], 'hex');
  eq(css('  background: rgba(0, 0, 0, 0.4);'), ['raw colour'], 'rgba');
  eq(css('  color: white;'), ['raw colour'], 'named');
  eq(css('  border: 1px solid black;'), ['raw colour'], 'named in shorthand, 1px hairline passes');
  eq(css('  color: var(--lit-text-1);'), [], 'role token');
  eq(css('  background: rgb(var(--if-bg-rgb) / 0.5);'), [], 'rgb of a token');
  eq(css('  color: transparent;'), [], 'transparent');
  eq(css('  padding: 12px;'), ['pixel size'], 'px');
  eq(css('  padding: 0px;'), [], '0px');
  eq(css('  inline-size: calc(100% - var(--lit-gap));'), [], 'calc of a token');
  eq(css('@media (min-width: 768px) {'), [], 'px in a media query');
  eq(css('  outline: 2px solid var(--if-focus);'), [], 'a 2px focus ring is a line weight');
  eq(css('  border-block-end: 2px solid var(--lit-line);'), [], 'a 2px border');
  eq(css('  border-radius: 8px;'), ['pixel size'], 'a radius is a size');
  eq(css('  border: 3px solid var(--lit-line);'), ['pixel size'], 'a heavy border needs a token');
  eq(css('  margin-left: auto;'), ['physical side'], 'margin-left');
  eq(css('  left: 0;'), ['physical side'], 'left:');
  eq(css('  text-align: right;'), ['physical side'], 'text-align right');
  eq(css('  border-top-left-radius: var(--lit-r);'), ['physical side'], 'physical corner');
  eq(css('  margin-inline-start: auto;'), [], 'logical');
  eq(css('  inset-inline-start: 0;'), [], 'logical inset');
  eq(css('  text-align: start;'), [], 'text-align start');
  eq(css('  grid-template-areas: "left right";'), [], 'words in a string are not properties');
  eq(css('  color: #fff; /* look-drift-allow: the payment network asks for its exact mark colour */'), [], 'allowed');
  eq(css('  /* was #fff */ color: var(--lit-text-1);'), [], 'comment ignored');
  eq(css('  transition: transform 120ms var(--lit-ease);'), [], 'ms is not px');
  eq(css('  margin-top: -12px;'), ['pixel size'], 'negative px');
  eq(css('  transform: translateX(-4px);'), ['pixel size'], 'negative px in a function');
  eq(css('  margin-block-start: -1px;'), [], 'negative hairline');
  eq(css('a { color: white }'), ['raw colour'], 'named colour before a closing brace');
  eq(css('#add-button { display: none; }'), [], 'an id selector is not a colour');
  eq(css('a[href="#face"] { text-decoration: underline; }'), [], 'an attribute selector is not a colour');
  eq(css('#add,'), [], 'a selector list line');
  eq(css('    #0a0a0a 3%, #ececec 20%,'), ['raw colour'], 'a gradient carried over a line');
  // TS / TSX
  eq(ts(`  <div style={{ color: '#3f7dff' }} />`), ['raw colour'], 'inline hex');
  eq(ts(`  <a href="#add">Add</a>`), [], 'a fragment link is not a colour');
  eq(ts(`  const accent = '#3f7dff';`), ['raw colour'], 'a bare hex string');
  eq(ts(`  const glow = 'drop-shadow(0 0 4px #3f7dff)';`), ['raw colour', 'pixel size'], 'hex inside a style string');
  eq(ts(`  const id = '#deadbeef-row';`), [], 'a hex-like id with a suffix');
  eq(ts(`  <div className="bg-red-500 text-white" />`), ['raw colour'], 'tailwind palette');
  eq(ts(`  <div className="bg-[#123456]" />`), ['raw colour'], 'tailwind arbitrary colour');
  eq(ts(`  <div className="bg-[var(--lit-solid-bg)] text-[color:var(--lit-text-1)]" />`), [], 'tailwind with tokens');
  eq(ts(`  <div className="w-[12px]" />`), ['pixel size'], 'tailwind arbitrary px');
  eq(ts(`  <div style={{ width: '12px' }} />`), ['pixel size'], 'style px');
  eq(ts(`  <div className="ml-2 pr-4" />`), ['physical side'], 'tailwind ml/pr');
  eq(ts(`  <div className={cn('text-right', x)} />`), ['physical side'], 'tailwind text-right in cn');
  eq(ts(`  <div className="ms-2 pe-4 text-end start-0 border-s rounded-ss" />`), [], 'tailwind logical');
  eq(ts(`  <div style={{ marginLeft: 4 }} />`), ['physical side'], 'style marginLeft');
  eq(ts(`  const rect = { left: 0, right: 10 };`), [], 'geometry objects are not judged');
  eq(ts(`  const mode = 'left';`), [], 'a word is not a class');
  eq(ts(`  <Icon className="size-4" aria-label="Move left" />`), [], 'words in labels');
  eq(ts(`  // was ml-2 and #fff`), [], 'comment ignored');
  eq(ts(`   * A handle like "#A1B2C3D4" a person can quote.`), [], 'doc comment ignored');
  eq(ts(`  <li className="tb-mode min-[1000px]:hidden">`), [], 'a breakpoint variant is a query');
  eq(ts(`  const url = 'https://x.test/#abc';`), [], 'url fragment');
  eq(ts(`  const title = 'Order #123 is on its way';`), [], 'a number sign in copy');
  eq(ts(`  <aside className="left-rail" />`), [], 'a class named left-rail');
  eq(ts(`  <aside className="left-0 right-1/2 ml-auto pl-[var(--lit-gap)]" />`), ['physical side'], 'tailwind side values');
  eq(ts(`  <Link to="/x" style={{ color: '#ff0000' }}>`), ['raw colour'], 'a link on the line does not hide a colour');
  eq(ts(`  const g = { from: '#fff', to: '#000' };`), ['raw colour'], 'a gradient object');
  eq(ts(`  <div style={{ marginTop: '-8px' }} />`), ['pixel size'], 'negative px string');
  eq(ts(`  const wide = window.matchMedia('(min-width: 768px)');`), [], 'a media query string');
  eq(ts(`  const s = 'margin-left: 4px';`), ['pixel size', 'physical side'], 'CSS inside a string');
  // Block sides, the new look only
  const litCss = (l) => judgeLine(l, 'css', { query: 0 }, { newLook: true });
  const litTs = (l) => judgeLine(l, 'ts', { query: 0 }, { newLook: true });
  eq(css('  margin-top: var(--lit-gap);'), [], 'a top side passes in an old room');
  eq(litCss('  margin-top: var(--lit-gap);'), ['top or bottom side'], 'margin-top in the new look');
  eq(litCss('  padding-bottom: 0;'), ['top or bottom side'], 'padding-bottom');
  eq(litCss('  border-top: 1px solid var(--lit-line);'), ['top or bottom side'], 'border-top');
  eq(litCss('  position: sticky; top: 0;'), ['top or bottom side'], 'top:');
  eq(litCss('  border-top-left-radius: var(--lit-r);'), ['physical side'], 'a corner is one finding, not two');
  eq(litCss('  margin-block-start: var(--lit-gap); inset-block-end: 0;'), [], 'block sides pass');
  eq(litCss('  vertical-align: top; background-position: bottom;'), [], 'top as a value is not a side');
  eq(litCss('  --lit-gap-top: 1rem;'), [], 'a custom property name is not a side');
  eq(litTs(`  <div className="mt-2 pb-4 border-b" />`), ['top or bottom side'], 'tailwind mt/pb/border-b');
  eq(litTs(`  <div className="mbs-2 pbe-4 inset-bs-0 border-be rounded-ss" />`), [], 'tailwind block logical');
  eq(litTs(`  <div style={{ marginTop: 4 }} />`), ['top or bottom side'], 'style marginTop');
  eq(litTs(`  const rect = { top: 0, bottom: 10 };`), [], 'geometry objects are not judged');
  eq(litTs(`  <p className="top-note" />`), [], 'a class named top-note');
  eq(litCss('  border-bottom-color: var(--lit-line); border-top-width: 1px;'), ['top or bottom side'], 'border longhands');
  eq(litTs(`  const s = 'border-top-left-radius: 1rem';`), [], 'a corner in a string is not a block side');
  eq(litTs(`  <div className="mt-(--lit-gap) top-(--lit-gap)" />`), ['top or bottom side'], 'tailwind variable values');
  eq(litTs(`  const { marginTop } = getComputedStyle(el);`), [], 'a measurement read is not a style');
  eq(litTs(`  el.style.marginTop = '0';`), ['top or bottom side'], 'a style write');
  eq(ts(`  <div className="mt-2" />`), [], 'tailwind mt passes in an old room');
  const f = (path, text, only) => judgeFile(path, text, only).findings.length;
  eq(f('apps/customer/src/x.css', 'a { color: #fff; }'), 1, 'new file judged');
  eq(f('packages/ui/src/lit/templates/balance.css', '.b { padding: 12px; }'), 1, 'a template is judged');
  eq(f('packages/ui/src/components/table.css', '.t { padding: 12px; }'), 0, 'kit components are the system');
  eq(f('apps/customer/src/x.css', 'a { color: #fff; }\nb { color: var(--if-fg); }', new Set([2])), 0, 'only changed lines');
  eq(f('packages/ui/src/theme/tokens.css', ':root { --if-bg: #000; }'), 0, 'token definitions not judged');
  eq(f('packages/ui/src/lit/lit.css', ':root { --lit-page: #05070d; }'), 0, 'lit token values not judged');
  eq(f('packages/ui/src/lit/components/key.css', '.k { inline-size: 18px; }'), 0, 'a lit component may hold structural px');
  eq(f('packages/ui/src/lit/components/key.css', '.k { margin-left: var(--lit-gap); }'), 1, 'a lit component may not use physical sides');
  eq(f('packages/ui/src/lit/components/key.css', '.k { color: #fff; }'), 1, 'a lit component may not use raw colours');
  eq(f('packages/ui/src/lit/components/key.tsx', `<i className="border-l" />`), 1, 'a lit component may not use a Tailwind physical side');
  const rooms = new Set(['apps/customer/src/screens/home']);
  const b = (path, text) => judgeFile(path, text, null, rooms).findings.map((x) => x.rule);
  eq(b('apps/customer/src/screens/home/home.css', '.h { margin-top: 0; }'), ['top or bottom side'], 'a migrated room');
  eq(b('apps/customer/src/screens/money/money.css', '.m { margin-top: 0; }'), [], 'a room not migrated');
  eq(b('packages/ui/src/lit/components/key.css', '.k { padding-bottom: 0; }'), ['top or bottom side'], 'the lit kit');
  eq(
    b('apps/customer/src/app/App.tsx', "import { X } from '@intafaced/ui/lit';\nconst s = { marginTop: 4 };"),
    [],
    'the app shell is old look',
  );
  eq(blockSides('apps/customer/src/app/App.tsx', rooms), false, 'the app shell is not a room');
  eq(f('apps/customer/src/screens/home/home.test.tsx', `expect(x).toBe('#fff')`), 0, 'tests not judged');
  eq(f('apps/customer/src/screens/home/home.fixtures.mjs', `const c = '#fff';`), 0, 'fixtures not judged');
  eq(f('services/svc-bank/src/x.ts', `const c = '#fff';`), 0, 'out of scope');
  eq(
    f('apps/customer/src/x.css', '@media (max-width: 600px) {\n  a { padding: 4px; }\n}\nb { padding: 4px; }'),
    1,
    'px inside a query block passes, after it fails',
  );
  eq(
    f('apps/customer/src/x.css', '@media (min-width: 768px)\n{\n  a { padding: 4px; }\n}\nb { padding: 4px; }'),
    1,
    'query brace on the next line',
  );
  eq(f('apps/customer/src/x.css', '@supports (display: grid) {\n  a { padding: 40px; }\n}'), 1, '@supports is not a query');
  eq(
    f('apps/customer/src/x.css', 'a::before { content: "{"; }\n@media (min-width: 9px) {\n a { padding: 4px; }\n}\nb { padding: 4px; }'),
    1,
    'braces in strings are not counted',
  );
  eq(
    f(
      'packages/ui/src/lit/templates/templates.css',
      '/*\n * Rooms are 720px wide on a phone,\n * and the band was #fff once.\n */\n.a { color: var(--lit-text-1); }',
    ),
    0,
    'every line of a CSS block comment that spans lines is skipped',
  );
  eq(f('apps/customer/src/x.css', '/* open\n  still 12px\n*/ a { padding: 12px; }'), 1, 'code after a block comment closes is judged');
  eq(
    f('apps/customer/src/x.tsx', 'const a = 1; /* was\n  #fff and ml-2\n*/\nconst s = { marginLeft: 4 };'),
    1,
    'a TS block comment that spans lines is skipped, the code after it is not',
  );
  eq(
    f('apps/customer/src/x.tsx', "const g = '/*'; const c = 'drop-shadow(0 0 4px #3f7dff)';"),
    2,
    'a comment opener in a string opens nothing (px and colour found)',
  );
  eq(
    f('apps/customer/src/x.tsx', "// see /* here\nconst c = 'drop-shadow(0 0 4px #3f7dff)';"),
    2,
    'a comment opener after // opens nothing (px and colour found)',
  );
  eq(f('packages/ui/src/lit/templates/__gallery__/gallery.css', '.g { padding: 24px; color: #fff; }'), 0, 'the TEST gallery is not judged');
  eq(f('packages/ui/src/components/__gallery__/KitSections.tsx', `<i style={{ color: '#fff' }} />`), 0, 'the kit gallery is not judged');
  eq(f('packages/ui/src/lit/fx/glow.css', '.g { box-shadow: 0 0 2rem rgba(63, 125, 255, 0.4); }'), 1, 'lit/fx colours come from roles');
  eq(f('packages/ui/src/lit/fx/glow.css', '.g { box-shadow: 0 0 2rem var(--lit-glow); }'), 0, 'lit/fx role colour passes');
  eq(f('apps/customer/public/assets/vendor.js', "a.style.color='#fff'"), 0, '.js is not judged (see the header)');
  eq(f('apps/customer/src/features/more/playwright.config.ts', `viewport: '1280px'`), 0, 'a playwright config is not judged');
  eq(
    judgeFile('apps/customer/src/x.css', 'a { color: #fff; } /* look-drift-allow: exact partner mark colour */').allowed.length,
    1,
    'allowed lines listed',
  );
  console.log(`✓ look-drift --self-test OK (${fixtures} fixtures)`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--all')) {
    const files = git(['ls-files', 'apps/customer', 'packages/ui/src/lit']).split('\n').filter(Boolean);
    const byRule = new Map();
    const byArea = new Map();
    const rooms = litRooms();
    for (const path of files) {
      const { findings } = judgeFile(path, readFileSync(path, 'utf8'), null, rooms);
      for (const x of findings) {
        byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + 1);
        const area = path.split('/').slice(0, 4).join('/');
        byArea.set(area, (byArea.get(area) ?? 0) + 1);
      }
    }
    console.log('look-drift --all (report only): lines with raw values across apps/customer and packages/ui/src/lit');
    for (const [rule, n] of byRule) console.log(`  ${rule}: ${n}`);
    for (const [area, n] of [...byArea].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${String(n).padStart(6)}  ${area}`);
    process.exit(0);
  }
  const base = process.env.GUARD_BASE || 'origin/main';
  const findings = [];
  const allowed = [];
  const rooms = litRooms();
  for (const { path, only } of changed(base)) {
    const r = judgeFile(path, readFileSync(path, 'utf8'), only, rooms);
    findings.push(...r.findings);
    allowed.push(...r.allowed);
  }
  for (const a of allowed) console.log(`⚠ allowed raw value ${a.path}:${a.line}  ${a.text}`);
  if (findings.length === 0) {
    console.log('✓ look-drift clean — changed lines take their look from role tokens');
    process.exit(0);
  }
  console.error(`\n✖ look-drift FAILED — ${findings.length} finding(s) on changed lines\n`);
  for (const x of findings) console.error(`  ${x.path}:${x.line}  ${x.rule}\n    ${x.text}`);
  if (process.env.GITHUB_ACTIONS) {
    const esc = (t) => String(t).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const x of findings.slice(0, 10))
      console.log(`::error file=${esc(x.path)},line=${x.line},title=Look drift::${esc(`${x.rule}: ${x.text}`)}`);
  }
  console.error(
    "\n  Use the kit's role tokens (var(--lit-*) from packages/ui/src/lit/contracts.ts, or var(--if-*)) and logical sides" +
      ' (margin-inline-start, ms-*, text-end; in the new look also margin-block-start, mbs-*, inset-bs-*). A raw value that' +
      ' must stay ends its line with "look-drift-allow: <reason>".',
  );
  process.exit(1);
}

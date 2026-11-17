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
      if (c === '*' && line[k + 1] === '/') {
        state.comment = false;
        k++;
      }
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') out += line[++k] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '/' && line[k + 1] === '*') {
      state.comment = true;
      k++;
    } else if (kind === 'ts' && c === '/' && line[k + 1] === '/') return out + line.slice(k);
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
          if (c === '*' && line[k + 1] === '/') {
            inComment = false;
            k++;
          }
        } else if (quote) {
          if (c === '\\') k++;
          else if (c === quote) quote = null;
        } else if (c === '/' && line[k + 1] === '*') {
          inComment = true;
          k++;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') {
          if (pendingQuery) {
            queryDepths.push(depth);
            pendingQuery = false;
          }
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

/**
 * Customer rooms in Volt, n of N, counted from where rooms are declared: `rooms` in navigation.ts (every row
 * that is not an alias), less the routes `room-templates.ts` marks as not a room, plus the merchant portal's
 * PORTAL_ROOMS. That is N. Print it with `node tooling/design/volt-count.mjs`; `volt-count.test.ts` is the ratchet.
 *
 * A room's move onto its template is recorded in the screen file that draws it, by one line of its own per room:
 *     // volt-room: /bank/business/bill
 * (`// volt-room: portal:<page>` for a merchant portal page). Only that room's batch writes it, so two batches that move
 * different rooms change no common file. `room-templates.ts` keeps each room's template, which no batch edits.
 *
 * The rule, which a reviewer can check by reading one room's files: a room is **in Volt** when
 *  1. a screen file carries its `volt-room` line, and that file imports the kit
 *     (`@intafaced/ui/lit` or `@intafaced/ui/lit/templates`); and
 *  2. that file, and every file it reaches by a relative import inside its own folder (tests aside), has none of:
 *     - `stylesheet`: an imported `.css` file (styles of the room's own);
 *     - `inline-style`: a `style=` attribute (a `data-style=` attribute is data, not a style);
 *     - `old-kit`: an import from `@intafaced/ui` other than `@intafaced/ui/lit…`, or from the app's `shared/ui`;
 *     - `outside-component`: a component (a capitalised name) imported from a `.tsx` file outside the room's folder
 *       that itself draws off the kit: that file is judged by this same rule, in its own folder, so a part several rooms
 *       share is drawn from the kit once, where it lives (hooks, copy and helpers from there are not judged). A name
 *       imported through a `.ts` barrel (a folder's `index.ts`, or any `.ts` that re-exports) is followed through its
 *       `export { … } from` and `export * from` lines to the `.tsx` that holds it, which is judged the same way; a name
 *       a barrel re-exports from the old kit is off the kit there;
 *     - `own-class`: a class name written in `className` that is not the kit's (`lt-…`).
 * A room that fails 1 is `not-migrated` (or `no-template` when the registry has no row for it); one that fails 2 is
 * `off-kit`, with each finding named by file and line.
 *
 * A room that passes both still doesn't count when it shows only a placeholder (`placeholder`): its screen file and the
 * files it reaches inside its folder read nothing (call no hook but React's own, `useCopy` and `usePreferences`), list
 * nothing (no `.map(`) and draw an empty state (`kind: 'empty'` or the kit's `EmptyState`), so every visit shows the same
 * "nothing here" panel (/mining/workers/:workerId, /token/governance/:proposalId and /chain/validators/:validatorId
 * counted on 22 Nov 2026 that way). It is on the kit, so the ratchet doesn't hold it as off
 * the kit; it stays in a batch until it shows the room's own records.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PORTAL_ROOMS } from '../features/pay/portal/routes';
import { rooms } from './navigation';
import { PORTAL_TEMPLATES, ROUTE_TEMPLATES, type RoomTemplate } from './room-templates';

export type VoltState = 'volt' | 'placeholder' | 'off-kit' | 'not-migrated' | 'no-template';
export type FindingKind = 'stylesheet' | 'inline-style' | 'old-kit' | 'outside-component' | 'own-class';
export interface Finding {
  kind: FindingKind;
  /** `<file under apps/customer/src>:<line>`. */
  at: string;
  text: string;
}
export interface VoltRoom {
  /** The route, or `portal:<room>` for a merchant portal page. */
  key: string;
  name: string;
  route: string;
  area: string;
  template: string | null;
  file: string | null;
  state: VoltState;
  reason: string;
  findings: Finding[];
}
export interface VoltBatch {
  batch: string;
  size: number;
  rooms: string[];
}
export interface VoltCount {
  n: number;
  N: number;
  rule: string;
  rooms: VoltRoom[];
  batches: VoltBatch[];
  /** A `volt-room` line naming no room, or a room two files claim: each fails the ratchet. */
  markErrors: string[];
}

const VOLT_RULE =
  "In Volt: a screen file carries the room's `// volt-room: <route>` line, it imports @intafaced/ui/lit, and it and the files it reaches by relative import inside its own folder import no stylesheet, set no style=, import nothing from @intafaced/ui outside /lit nor from shared/ui, import no component (a capitalised name) from a .tsx outside the folder, directly or through a .ts barrel's re-exports, unless that file passes this same rule, and write no className that is not the kit's lt- class. A room that reads nothing, lists nothing and draws an empty state shows only a placeholder and doesn't count.";

const APP_SRC = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** The marker line a screen file carries for each room it draws in its template. */
const VOLT_ROOM_MARK = /^[ \t]*\/\/ volt-room: (\S+)[ \t]*$/gm;

/** Every source file under `dir` but tests, as paths relative to `root`. */
function sources(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__fixtures__') out.push(...sources(root, path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
      out.push(relative(root, path));
  }
  return out;
}

/** Each room key a `volt-room` line names, with the files (under `src`) that name it. */
export function voltMarks(src = APP_SRC): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  for (const file of sources(src)) {
    const text = readFileSync(join(src, file), 'utf8');
    if (!text.includes('volt-room:')) continue;
    for (const m of text.matchAll(VOLT_ROOM_MARK)) marks.set(m[1]!, [...(marks.get(m[1]!) ?? []), file]);
  }
  return marks;
}

function resolveImport(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')])
    if (existsSync(candidate) && /\.(tsx?|css)$/.test(candidate)) return candidate;
  return undefined;
}

/** Each value import in `source` (type-only imports draw nothing), with its line. */
function imports(source: string): { spec: string; line: number; names: string[] }[] {
  const found: { spec: string; line: number; names: string[] }[] = [];
  const pattern = /^[ \t]*(import|export)\b(?!\s+type\s)(?:[^'";]*?\bfrom)?\s*['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(pattern)) {
    if (m[1] === 'export' && !/\bfrom\s*['"]/.test(m[0])) continue;
    const clause = m[0].replace(/^[ \t]*(import|export)\b/, '').replace(/\bfrom\s*['"][^'"]+['"]$/, '');
    const names = clause
      .replace(/[{}*]/g, ',')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith('type '))
      .map((n) => n.split(/\s+as\s+/)[0]!.trim());
    found.push({ spec: m[2]!, line: source.slice(0, m.index).split('\n').length, names });
  }
  return found;
}

/** Each `export … from` line in `source`: the names it re-exports (exported name to the name in `spec`), or `*`. */
function reexports(source: string): { spec: string; line: number; star: boolean; names: Map<string, string> }[] {
  const found: { spec: string; line: number; star: boolean; names: Map<string, string> }[] = [];
  for (const m of source.matchAll(/^[ \t]*export\s+(?!type\s)(\*(?:\s+as\s+(\w+))?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm)) {
    const names = new Map<string, string>();
    if (m[2]) names.set(m[2], '*');
    else if (m[1]!.startsWith('{'))
      for (const part of m[1]!.slice(1, -1).split(',')) {
        const n = part.trim();
        if (!n || n.startsWith('type ')) continue;
        const [inner, outer] = n.split(/\s+as\s+/).map((x) => x.trim());
        names.set(outer ?? inner!, inner!);
      }
    found.push({ spec: m[3]!, line: source.slice(0, m.index).split('\n').length, star: m[1] === '*', names });
  }
  return found;
}

/** Whether the `.tsx` at `file` exports `name` itself or by a named re-export (an `export *` reaches it only so). */
const holds = (file: string, name: string) =>
  new RegExp(
    `^[ \\t]*export\\s+(?:(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class)\\s+${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\})`,
    'm',
  ).test(readFileSync(file, 'utf8'));

/**
 * Where `name`, imported from the `.ts` barrel `file`, is drawn: the `.tsx` that holds it (reached through the barrel's named
 * and star re-exports, and any `.ts` barrels behind them), an old-kit re-export (`old`), or nothing when a `.ts` holds it
 * itself or it is not found. `seen` ends a cycle of barrels.
 */
function throughBarrel(
  file: string,
  name: string,
  seen: Set<string> = new Set(),
): { tsx?: string; old?: { file: string; line: number; spec: string } } | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const lines = reexports(readFileSync(file, 'utf8'));
  const follow = (spec: string, line: number, inner: string, star = false) => {
    if (spec === '@intafaced/ui' || (spec.startsWith('@intafaced/ui/') && !spec.startsWith('@intafaced/ui/lit')))
      return { old: { file, line, spec } };
    if (!spec.startsWith('.')) return undefined;
    const target = resolveImport(file, spec);
    if (!target) return undefined;
    if (/(^|\/)shared\/ui(\.tsx?|\/.*)$/.test(target)) return { old: { file, line, spec } };
    if (target.endsWith('.tsx')) return star && !holds(target, inner) ? undefined : { tsx: target };
    if (target.endsWith('.ts') && inner !== '*') return throughBarrel(target, inner, seen);
    return undefined;
  };
  const named = lines.find((l) => l.names.has(name));
  if (named) return follow(named.spec, named.line, named.names.get(name)!);
  for (const l of lines.filter((l) => l.star)) {
    const found = follow(l.spec, l.line, name, true);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every finding that keeps the room whose screen file is `entry` (absolute) off the kit. `judged` carries the verdict
 * on each outside part already judged (a part under judgement counts as clean, so an import cycle ends).
 */
export function offKitFindings(entry: string, judged: Map<string, Finding[]> = new Map(), root = APP_SRC): Finding[] {
  const at = (file: string, line: number) => `${relative(root, file)}:${line}`;
  judged.set(entry, judged.get(entry) ?? []);
  const folder = dirname(entry);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const { spec, line, names } of imports(source)) {
      const where = at(file, line);
      if (spec.endsWith('.css')) findings.push({ kind: 'stylesheet', at: where, text: spec });
      else if (spec === '@intafaced/ui' || (spec.startsWith('@intafaced/ui/') && !spec.startsWith('@intafaced/ui/lit')))
        findings.push({ kind: 'old-kit', at: where, text: spec });
      else if (spec.startsWith('.')) {
        const target = resolveImport(file, spec);
        if (!target) continue;
        if (/(^|\/)shared\/ui(\.tsx?|\/.*)$/.test(target)) findings.push({ kind: 'old-kit', at: where, text: spec });
        else if (target.startsWith(folder + '/')) {
          if (!/\.test\.tsx?$/.test(target)) queue.push(target);
        } else if (target.endsWith('.tsx') && names.some((n) => /^[A-Z]/.test(n))) {
          if (!judged.has(target)) judged.set(target, offKitFindings(target, judged, root));
          const off = judged.get(target)!;
          if (off.length > 0)
            findings.push({
              kind: 'outside-component',
              at: where,
              text: `${names.filter((n) => /^[A-Z]/.test(n)).join(', ')} from ${spec}, which draws off the kit: ${off[0]!.kind} at ${off[0]!.at}${off.length > 1 ? ` (+${off.length - 1} more)` : ''}`,
            });
        } else if (target.endsWith('.ts')) {
          for (const name of names.filter((n) => /^[A-Z]/.test(n))) {
            const drawn = throughBarrel(target, name);
            if (drawn?.old) {
              findings.push({
                kind: 'outside-component',
                at: where,
                text: `${name} from ${spec}, which draws off the kit: old-kit at ${at(drawn.old.file, drawn.old.line)} (${drawn.old.spec})`,
              });
              continue;
            }
            if (!drawn?.tsx) continue;
            if (!judged.has(drawn.tsx)) judged.set(drawn.tsx, offKitFindings(drawn.tsx, judged, root));
            const off = judged.get(drawn.tsx)!;
            if (off.length > 0)
              findings.push({
                kind: 'outside-component',
                at: where,
                text: `${name} from ${spec} (${relative(root, drawn.tsx)}), which draws off the kit: ${off[0]!.kind} at ${off[0]!.at}${off.length > 1 ? ` (+${off.length - 1} more)` : ''}`,
              });
          }
        }
      }
    }
    source.split('\n').forEach((text, i) => {
      if (/(?<![\w-])style=\{/.test(text)) findings.push({ kind: 'inline-style', at: at(file, i + 1), text: text.trim() });
      for (const m of text.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
        const literal = m[1] ?? [...(m[2] ?? '').matchAll(/['"`]([^'"`$]*)(?=['"`]|\$\{)/g)].map((s) => s[1]).join(' ');
        const own = literal.split(/\s+/).filter((c) => c && !c.startsWith('lt-'));
        if (own.length > 0) findings.push({ kind: 'own-class', at: at(file, i + 1), text: own.join(' ') });
      }
    });
  }
  return findings;
}

/** Hooks that read no room data: React's own, the copy and the preferences. Any other hook call is a read. */
const DATA_FREE_HOOK = /^use(State|Effect|LayoutEffect|Memo|Ref|Callback|Id|Context|Reducer|Copy|Preferences)$/;

/** The screen file `entry` (absolute) and every file it reaches by a relative import inside its own folder, tests aside. */
function roomFiles(entry: string): string[] {
  const folder = dirname(entry);
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec } of imports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = resolveImport(file, spec);
      if (target && target.startsWith(folder + '/') && /\.tsx?$/.test(target) && !/\.test\.tsx?$/.test(target)) queue.push(target);
    }
  }
  return [...seen];
}

/**
 * Why the room whose screen file is `entry` (absolute) shows only a placeholder, or null when it shows something of its
 * own: it reads nothing (no hook call but DATA_FREE_HOOK), lists nothing (no `.map(`) and draws an empty state.
 */
export function placeholderOnly(entry: string): string | null {
  const text = roomFiles(entry)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const reads = [...text.matchAll(/\b(use[A-Z]\w*)\s*\(/g)].some((m) => !DATA_FREE_HOOK.test(m[1]!));
  const empty = /\bkind:\s*['"]empty['"]|<EmptyState\b/.test(text);
  if (reads || !empty || /\.map\(/.test(text)) return null;
  return 'on its template and the kit, but it shows only a placeholder: it reads nothing, lists nothing and draws an empty state';
}

function judge(
  src: string,
  entry: RoomTemplate | undefined,
  file: string | undefined,
): Pick<VoltRoom, 'template' | 'file' | 'state' | 'reason' | 'findings'> {
  if (!entry)
    return { template: null, file: null, state: 'no-template', reason: 'room-templates.ts names no template for it', findings: [] };
  const template = entry.template;
  if (!file)
    return {
      template,
      file: null,
      state: 'not-migrated',
      reason: `not on its ${template} template yet: it draws its old view`,
      findings: [],
    };
  const path = join(src, file);
  if (!existsSync(path)) return { template, file, state: 'not-migrated', reason: `its screen file ${file} does not exist`, findings: [] };
  if (!/from\s+['"]@intafaced\/ui\/lit(\/templates)?['"]/.test(readFileSync(path, 'utf8')))
    return { template, file, state: 'not-migrated', reason: `${file} does not import the kit`, findings: [] };
  const findings = offKitFindings(path, new Map(), src);
  if (findings.length === 0) {
    const placeholder = placeholderOnly(path);
    if (placeholder) return { template, file, state: 'placeholder', reason: placeholder, findings };
    return { template, file, state: 'volt', reason: 'drawn only from the kit', findings };
  }
  const kinds = [...new Set(findings.map((f) => f.kind))];
  return { template, file, state: 'off-kit', reason: `on its template, but draws off the kit: ${kinds.join(', ')}`, findings };
}

/** Where the count reads from: the app's own tables and source, or a planted copy in a test. */
export interface VoltSource {
  src: string;
  rooms: readonly { path: string; title: string; area: string; alias?: unknown }[];
  routeTemplates: Readonly<Record<string, RoomTemplate | string>>;
  portalRooms: readonly string[];
  portalTemplates: Readonly<Record<string, RoomTemplate>>;
}

const APP_SOURCE: VoltSource = {
  src: APP_SRC,
  rooms,
  routeTemplates: ROUTE_TEMPLATES,
  portalRooms: PORTAL_ROOMS,
  portalTemplates: PORTAL_TEMPLATES,
};

/** The whole count. Batches group the rooms not yet in Volt by area and template, one batch per next item. */
export function voltCount(source: VoltSource = APP_SOURCE): VoltCount {
  const marks = voltMarks(source.src);
  const fileOf = (key: string) => marks.get(key)?.[0];
  const list: VoltRoom[] = [];
  for (const room of source.rooms) {
    if (room.alias) continue;
    const entry = source.routeTemplates[room.path];
    if (typeof entry === 'string') continue;
    list.push({ key: room.path, name: room.title, route: room.path, area: room.area, ...judge(source.src, entry, fileOf(room.path)) });
  }
  for (const page of source.portalRooms)
    list.push({
      key: `portal:${page}`,
      name: page,
      route: `/pay (merchant portal: ${page})`,
      area: 'pay-portal',
      ...judge(source.src, source.portalTemplates[page], fileOf(`portal:${page}`)),
    });
  const known = new Set(list.map((r) => r.key));
  const markErrors: string[] = [];
  for (const [key, files] of marks) {
    if (!known.has(key)) markErrors.push(`${files.join(', ')}: \`// volt-room: ${key}\` names no customer room`);
    else if (files.length > 1) markErrors.push(`${key}: claimed by ${files.length} files (${files.join(', ')}); one screen file draws it`);
  }
  const groups = new Map<string, string[]>();
  for (const room of list) {
    if (room.state === 'volt') continue;
    const batch = `${room.area} · ${room.template ?? 'no template'}`;
    groups.set(batch, [...(groups.get(batch) ?? []), room.key]);
  }
  const batches = [...groups]
    .map(([batch, keys]) => ({ batch, size: keys.length, rooms: keys }))
    .sort((a, b) => b.size - a.size || a.batch.localeCompare(b.batch));
  return { n: list.filter((r) => r.state === 'volt').length, N: list.length, rule: VOLT_RULE, rooms: list, batches, markErrors };
}

/** Whether a room is drawn on its template from the kit: in Volt, or a placeholder there. */
const onKit = (room: VoltRoom) => room.state === 'volt' || room.state === 'placeholder';

/**
 * What breaks the ratchet against `allowed` (the rooms volt-off-kit.json allows off the kit): a room off the kit that the
 * list does not allow (`off`) and a bad `volt-room` line (`mark`). A placeholder is on the kit: the list never names it, and
 * the count leaves it out. A listed room now on the kit, or gone, is stale and passes on every PR, so a batch into main
 * never edits the shared list; `pruned` drops it, run alone by `node tooling/design/volt-prune.mjs`.
 */
export function ratchet(count: VoltCount, allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  return [
    ...count.markErrors.map((e) => `mark: ${e}`),
    ...count.rooms
      .filter((r) => !onKit(r) && !allow.has(r.key))
      .map((r) => `off: ${r.key}: ${r.reason}${r.findings.map((f) => `\n    ${f.kind} at ${f.at}: ${f.text}`).join('')}`),
  ];
}

/** `allowed` less each room now on the kit or no longer a room: the list volt-prune.mjs writes. It never adds a room. */
export function pruned(count: VoltCount, allowed: readonly string[]): string[] {
  const off = new Set(count.rooms.filter((r) => !onKit(r)).map((r) => r.key));
  return allowed.filter((key) => off.has(key));
}

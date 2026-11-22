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
 *       share is drawn from the kit once, where it lives (hooks, copy and helpers from there are not judged);
 *     - `own-class`: a class name written in `className` that is not the kit's (`lt-…`).
 * A room that fails 1 is `not-migrated` (or `no-template` when the registry has no row for it); one that fails 2 is
 * `off-kit`, with each finding named by file and line.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PORTAL_ROOMS } from '../features/pay/portal/routes';
import { rooms } from './navigation';
import { PORTAL_TEMPLATES, ROUTE_TEMPLATES, type RoomTemplate } from './room-templates';

export type VoltState = 'volt' | 'off-kit' | 'not-migrated' | 'no-template';
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
  "In Volt: a screen file carries the room's `// volt-room: <route>` line, it imports @intafaced/ui/lit, and it and the files it reaches by relative import inside its own folder import no stylesheet, set no style=, import nothing from @intafaced/ui outside /lit nor from shared/ui, import no component (a capitalised name) from a .tsx outside the folder unless that file passes this same rule, and write no className that is not the kit's lt- class.";

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
  if (findings.length === 0) return { template, file, state: 'volt', reason: 'drawn only from the kit', findings };
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

/**
 * Whether a run judges a batch PR into a Volt layer branch (`volt/<template>`): there a stale list entry (a room now in
 * Volt still allowed off the kit) does not fail, so no batch has to edit the shared list. Everywhere else, the layer's PR into
 * main included, the list is held exact: one `node tooling/design/volt-count.mjs --write` on the layer tightens it.
 */
export const intoVoltLayer = (env: Record<string, string | undefined> = process.env) => (env.GITHUB_BASE_REF ?? '').startsWith('volt/');

/**
 * What breaks the ratchet against `allowed` (the rooms volt-off-kit.json allows off the kit): a room not in Volt that the
 * list does not allow (`off`), a bad `volt-room` line (`mark`), and, unless `staleAllowed`, a listed room now in Volt or gone
 * (`stale`).
 */
export function ratchet(count: VoltCount, allowed: readonly string[], staleAllowed = false): string[] {
  const allow = new Set(allowed);
  const offRooms = new Set(count.rooms.filter((r) => r.state !== 'volt').map((r) => r.key));
  return [
    ...count.markErrors.map((e) => `mark: ${e}`),
    ...count.rooms
      .filter((r) => r.state !== 'volt' && !allow.has(r.key))
      .map((r) => `off: ${r.key}: ${r.reason}${r.findings.map((f) => `\n    ${f.kind} at ${f.at}: ${f.text}`).join('')}`),
    ...(staleAllowed
      ? []
      : allowed
          .filter((key) => !offRooms.has(key))
          .map((key) => `stale: ${key} is in Volt now, or no longer a room: run \`node tooling/design/volt-count.mjs --write\``)),
  ];
}

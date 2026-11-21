/**
 * Customer rooms in Volt, n of N, counted from where rooms are declared: `rooms` in navigation.ts (every row
 * that is not an alias), less the routes `room-templates.ts` marks as not a room, plus the merchant portal's
 * PORTAL_ROOMS. That is N. Print it with `node tooling/design/volt-count.mjs`; `volt-count.test.ts` is the ratchet.
 *
 * The rule, which a reviewer can check by reading one room's files: a room is **in Volt** when
 *  1. `room-templates.ts` names the screen file that draws it (`migrated.file`), and that file imports the kit
 *     (`@intafaced/ui/lit` or `@intafaced/ui/lit/templates`); and
 *  2. that file, and every file it reaches by a relative import inside its own folder (tests aside), has none of:
 *     - `stylesheet`: an imported `.css` file (styles of the room's own);
 *     - `inline-style`: a `style=` attribute;
 *     - `old-kit`: an import from `@intafaced/ui` other than `@intafaced/ui/lit…`, or from the app's `shared/ui`;
 *     - `outside-component`: a component (a capitalised name) imported from a `.tsx` file outside the room's folder:
 *       a part the kit did not draw (hooks, copy and helpers from there are not judged);
 *     - `own-class`: a class name written in `className` that is not the kit's (`lt-…`).
 * A room that fails 1 is `not-migrated` (or `no-template` when the registry has no row for it); one that fails 2 is
 * `off-kit`, with each finding named by file and line.
 */
import { existsSync, readFileSync } from 'node:fs';
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
}

const VOLT_RULE =
  "In Volt: room-templates.ts names the screen file (migrated.file), it imports @intafaced/ui/lit, and it and the files it reaches by relative import inside its own folder import no stylesheet, set no style=, import nothing from @intafaced/ui outside /lit nor from shared/ui, import no component (a capitalised name) from a .tsx outside the folder, and write no className that is not the kit's lt- class.";

const SRC = resolve(dirname(new URL(import.meta.url).pathname), '..');
const at = (file: string, line: number) => `${relative(SRC, file)}:${line}`;

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

/** Every finding that keeps the room whose screen file is `entry` (absolute) off the kit. */
export function offKitFindings(entry: string): Finding[] {
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
        } else if (target.endsWith('.tsx') && names.some((n) => /^[A-Z]/.test(n)))
          findings.push({ kind: 'outside-component', at: where, text: `${names.filter((n) => /^[A-Z]/.test(n)).join(', ')} from ${spec}` });
      }
    }
    source.split('\n').forEach((text, i) => {
      if (/\bstyle=\{/.test(text)) findings.push({ kind: 'inline-style', at: at(file, i + 1), text: text.trim() });
      for (const m of text.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
        const literal = m[1] ?? [...(m[2] ?? '').matchAll(/['"`]([^'"`$]*)(?=['"`]|\$\{)/g)].map((s) => s[1]).join(' ');
        const own = literal.split(/\s+/).filter((c) => c && !c.startsWith('lt-'));
        if (own.length > 0) findings.push({ kind: 'own-class', at: at(file, i + 1), text: own.join(' ') });
      }
    });
  }
  return findings;
}

function judge(entry: RoomTemplate | undefined): Pick<VoltRoom, 'template' | 'file' | 'state' | 'reason' | 'findings'> {
  if (!entry)
    return { template: null, file: null, state: 'no-template', reason: 'room-templates.ts names no template for it', findings: [] };
  const template = entry.template;
  if (!entry.migrated)
    return {
      template,
      file: null,
      state: 'not-migrated',
      reason: `not on its ${template} template yet: it draws its old view`,
      findings: [],
    };
  const file = entry.migrated.file;
  const path = join(SRC, file);
  if (!existsSync(path)) return { template, file, state: 'not-migrated', reason: `its screen file ${file} does not exist`, findings: [] };
  if (!/from\s+['"]@intafaced\/ui\/lit(\/templates)?['"]/.test(readFileSync(path, 'utf8')))
    return { template, file, state: 'not-migrated', reason: `${file} does not import the kit`, findings: [] };
  const findings = offKitFindings(path);
  if (findings.length === 0) return { template, file, state: 'volt', reason: 'drawn only from the kit', findings };
  const kinds = [...new Set(findings.map((f) => f.kind))];
  return { template, file, state: 'off-kit', reason: `on its template, but draws off the kit: ${kinds.join(', ')}`, findings };
}

/** The whole count. Batches group the rooms not yet in Volt by area and template, one batch per next item. */
export function voltCount(): VoltCount {
  const list: VoltRoom[] = [];
  for (const room of rooms) {
    if (room.alias) continue;
    const entry = ROUTE_TEMPLATES[room.path];
    if (typeof entry === 'string') continue;
    list.push({ key: room.path, name: room.title, route: room.path, area: room.area, ...judge(entry) });
  }
  for (const page of PORTAL_ROOMS)
    list.push({
      key: `portal:${page}`,
      name: page,
      route: `/pay (merchant portal: ${page})`,
      area: 'pay-portal',
      ...judge(PORTAL_TEMPLATES[page]),
    });
  const groups = new Map<string, string[]>();
  for (const room of list) {
    if (room.state === 'volt') continue;
    const batch = `${room.area} · ${room.template ?? 'no template'}`;
    groups.set(batch, [...(groups.get(batch) ?? []), room.key]);
  }
  const batches = [...groups]
    .map(([batch, keys]) => ({ batch, size: keys.length, rooms: keys }))
    .sort((a, b) => b.size - a.size || a.batch.localeCompare(b.batch));
  return { n: list.filter((r) => r.state === 'volt').length, N: list.length, rule: VOLT_RULE, rooms: list, batches };
}

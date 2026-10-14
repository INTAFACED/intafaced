/**
 * `WorkspaceV1`: INTAFACED's own, versioned description of a trading-desk layout (PRO-TERMINAL-PLAN section 3).
 *
 * The docking library (flexlayout-react) never sees this shape and never owns it: `flex-adapter.ts` converts at the
 * edge, so swapping the library later loses nobody's saved layout. Everything stored on a device, and later on the
 * server (T-BE4), is this JSON.
 *
 * Rules the schema keeps:
 * - a layout is a tree of `split` (children side by side, or stacked) and `stack` (tabs sharing one box);
 * - a split's child splits run the other way (that is how every docking library lays out, and what the adapter needs);
 * - a panel is a stable instance id plus a `type` that the panel registry knows; the schema does not list types, so a
 *   new panel never needs a new schema version;
 * - `version` is the only thing a reader trusts before parsing. A newer version than this build knows is refused,
 *   never guessed at; an older one goes through `MIGRATIONS` one step at a time.
 */
import { z } from 'zod';

export const WORKSPACE_VERSION = 1 as const;
/** Same limit as OKX: ten saved workspaces. */
export const MAX_WORKSPACES = 10;
export const NAME_MAX = 32;

export const LINK_COLOURS = ['none', 'lime', 'blue', 'amber', 'pink'] as const;
export type LinkColour = (typeof LINK_COLOURS)[number];

export const PRESET_IDS = ['classic', 'chart-focus', 'scalper', 'book-focus', 'multi-market', 'minimal'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type SettingValue = string | number | boolean;

export interface PanelRef {
  /** Stable for the life of the panel in this workspace ("chart", "chart-2"). */
  id: string;
  /** What to draw. Looked up in the panel registry. */
  type: string;
  /** Link group: panels with the same colour follow the same coin. Reserved: every panel follows the desk's coin today. */
  link: LinkColour;
  /** Per-panel settings. Reserved for panels that remember something (a scanner's filter, a chart's drawings). */
  settings: Record<string, SettingValue>;
}

export interface StackNode {
  kind: 'stack';
  /** Share of the parent split, relative to its siblings. */
  weight: number;
  /** Index into `panels` of the showing tab. */
  selected: number;
  panels: PanelRef[];
}

export interface SplitNode {
  kind: 'split';
  /** `row`: children side by side. `column`: children stacked. */
  direction: 'row' | 'column';
  weight: number;
  children: LayoutNode[];
}

export type LayoutNode = StackNode | SplitNode;

export interface WorkspaceV1 {
  version: typeof WORKSPACE_VERSION;
  id: string;
  name: string;
  /** The preset this layout started from; "Reset to preset" goes back to it. Null once no preset applies. */
  preset: PresetId | null;
  /** Locked: no dragging, resizing or closing panels. Maximise still works. */
  locked: boolean;
  tree: LayoutNode;
}

const idText = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const weight = z.number().finite().positive();

const panelRef: z.ZodType<PanelRef, z.ZodTypeDef, unknown> = z.object({
  id: idText,
  type: idText,
  link: z.enum(LINK_COLOURS).default('lime'),
  settings: z.record(z.union([z.string().max(200), z.number().finite(), z.boolean()])).default({}),
});

const stackNode: z.ZodType<StackNode, z.ZodTypeDef, unknown> = z
  .object({
    kind: z.literal('stack'),
    weight,
    selected: z.number().int().min(0).default(0),
    panels: z.array(panelRef).min(1).max(12),
  })
  .refine((stack) => stack.selected < stack.panels.length, { message: 'selected tab is out of range', path: ['selected'] });

const layoutNode: z.ZodType<LayoutNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    stackNode,
    z.object({
      kind: z.literal('split'),
      direction: z.enum(['row', 'column']),
      weight,
      children: z.array(layoutNode).min(1).max(8),
    }),
  ]),
);

export const workspaceSchema: z.ZodType<WorkspaceV1, z.ZodTypeDef, unknown> = z
  .object({
    version: z.literal(WORKSPACE_VERSION),
    id: idText,
    name: z.string().trim().min(1).max(NAME_MAX),
    preset: z.enum(PRESET_IDS).nullable().default(null),
    locked: z.boolean().default(false),
    tree: layoutNode,
  })
  .superRefine((workspace, ctx) => {
    const problem = structureProblem(workspace.tree);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ['tree'] });
  });

/** Panel ids must be unique, and a split's child splits must run the other way. Null when the tree is sound. */
export function structureProblem(root: LayoutNode): string | null {
  const seen = new Set<string>();
  const visit = (node: LayoutNode, parent: 'row' | 'column' | null): string | null => {
    if (node.kind === 'stack') {
      for (const panel of node.panels) {
        if (seen.has(panel.id)) return `panel id "${panel.id}" is used twice`;
        seen.add(panel.id);
      }
      return null;
    }
    if (parent === node.direction) return 'a split inside a split must run the other way';
    for (const child of node.children) {
      const problem = visit(child, node.direction);
      if (problem) return problem;
    }
    return null;
  };
  return visit(root, null);
}

export function panelsOf(node: LayoutNode): PanelRef[] {
  return node.kind === 'stack' ? node.panels : node.children.flatMap(panelsOf);
}

// ── Reading stored JSON ────────────────────────────────────────────────────────

/** One step: JSON of version N becomes JSON of version N+1. Empty today; the first real change adds `1: from1To2`. */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type ReadResult =
  | { ok: true; workspace: WorkspaceV1; migrated: boolean }
  | { ok: false; reason: 'not-an-object' | 'no-version' | 'newer-version' | 'no-migration' | 'invalid'; detail?: string };

export interface ReadOptions {
  migrations?: Readonly<Record<number, Migration>>;
  /** The version this build writes. */
  current?: number;
  /** The check for the finished current-version JSON. */
  validate?: (raw: Record<string, unknown>) => { ok: true; workspace: WorkspaceV1 } | { ok: false; detail?: string };
}

const validateCurrent: NonNullable<ReadOptions['validate']> = (raw) => {
  const parsed = workspaceSchema.safeParse(raw);
  return parsed.success ? { ok: true, workspace: parsed.data } : { ok: false, detail: parsed.error.issues[0]?.message };
};

/**
 * Turn anything found in storage (or, later, from the server or an import) into a `WorkspaceV1`, or say why not.
 * Never throws. The options exist so the stepping can be tested before a version 2 does.
 */
export function readWorkspace(raw: unknown, options: ReadOptions = {}): ReadResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const current = options.current ?? WORKSPACE_VERSION;
  const validate = options.validate ?? validateCurrent;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' };
  let step = raw as Record<string, unknown>;
  const first = step.version;
  if (typeof first !== 'number' || !Number.isInteger(first) || first < 1) return { ok: false, reason: 'no-version' };
  if (first > current) return { ok: false, reason: 'newer-version', detail: `saved by version ${first}` };
  let version = first;
  while (version < current) {
    const migrate = migrations[version];
    if (!migrate) return { ok: false, reason: 'no-migration', detail: `no step from version ${version}` };
    try {
      step = { ...migrate(step), version: version + 1 };
    } catch {
      return { ok: false, reason: 'invalid', detail: `step from version ${version} failed` };
    }
    version += 1;
  }
  const checked = validate(step);
  if (!checked.ok) return { ok: false, reason: 'invalid', detail: checked.detail };
  return { ok: true, workspace: checked.workspace, migrated: first !== current };
}

// ── Making a stored layout safe to show ────────────────────────────────────────

/**
 * Drop panels this build does not know (a panel that was removed, or one behind a feature that is off), empty stacks
 * and splits, and fix a selected tab that no longer exists. Returns null when nothing is left to show, so the caller
 * falls back to the preset instead of drawing an empty desk.
 */
export function pruneWorkspace(workspace: WorkspaceV1, isKnownType: (type: string) => boolean): WorkspaceV1 | null {
  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'stack') {
      const panels = node.panels.filter((panel) => isKnownType(panel.type));
      if (panels.length === 0) return null;
      const keep = node.panels[node.selected];
      const selected = keep && panels.includes(keep) ? panels.indexOf(keep) : 0;
      return { ...node, panels, selected };
    }
    const children = node.children.map(prune).filter((child): child is LayoutNode => child !== null);
    if (children.length === 0) return null;
    if (children.length === 1) {
      // A split with one child is just that child; it takes the split's share and the split's own direction goes away.
      const only = children[0]!;
      return { ...only, weight: node.weight };
    }
    return { ...node, children };
  };
  const tree = prune(workspace.tree);
  if (!tree) return null;
  // The root may have collapsed to a different shape; the adapter wants a stack or a split, both are fine.
  return structureProblem(tree) ? null : { ...workspace, tree };
}

export function cleanName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

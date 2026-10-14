import { describe, expect, it } from 'vitest';
import { PRESETS, workspaceFromPreset } from './presets';
import {
  MIGRATIONS,
  panelsOf,
  pruneWorkspace,
  readWorkspace,
  structureProblem,
  WORKSPACE_VERSION,
  workspaceSchema,
  type LayoutNode,
  type WorkspaceV1,
} from './workspace';

const classic = () => workspaceFromPreset('classic', 'ws-test');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('WorkspaceV1 schema', () => {
  it('accepts every preset, as stored JSON', () => {
    for (const preset of PRESETS) {
      const result = readWorkspace(json(workspaceFromPreset(preset.id, 'ws-' + preset.id)));
      expect(result.ok, preset.id).toBe(true);
    }
  });

  it('fills the defaults a panel and a workspace may leave out', () => {
    const parsed = workspaceSchema.parse({
      version: 1,
      id: 'ws-a',
      name: '  Mine ',
      tree: { kind: 'stack', weight: 1, panels: [{ id: 'chart', type: 'chart' }] },
    });
    expect(parsed.name).toBe('Mine');
    expect(parsed.locked).toBe(false);
    expect(parsed.preset).toBeNull();
    expect(parsed.tree.kind === 'stack' && parsed.tree.selected).toBe(0);
    expect(panelsOf(parsed.tree)[0]).toMatchObject({ link: 'lime', settings: {} });
  });

  it.each([
    ['an empty name', (w: WorkspaceV1) => ({ ...w, name: '   ' })],
    ['a name over 32 characters', (w: WorkspaceV1) => ({ ...w, name: 'x'.repeat(33) })],
    ['an unknown preset', (w: WorkspaceV1) => ({ ...w, preset: 'nope' })],
    ['a zero weight', (w: WorkspaceV1) => ({ ...w, tree: { ...(w.tree as object), weight: 0 } })],
    ['a stack with no panels', () => ({ ...classic(), tree: { kind: 'stack', weight: 1, selected: 0, panels: [] } })],
    [
      'a selected tab past the end',
      () => ({
        ...classic(),
        tree: { kind: 'stack', weight: 1, selected: 3, panels: [{ id: 'chart', type: 'chart', link: 'lime', settings: {} }] },
      }),
    ],
    [
      'a bad panel id',
      () => ({
        ...classic(),
        tree: { kind: 'stack', weight: 1, selected: 0, panels: [{ id: 'Chart 1!', type: 'chart', link: 'lime', settings: {} }] },
      }),
    ],
    [
      'a bad link colour',
      () => ({
        ...classic(),
        tree: { kind: 'stack', weight: 1, selected: 0, panels: [{ id: 'chart', type: 'chart', link: 'teal', settings: {} }] },
      }),
    ],
  ])('refuses %s', (_label, change) => {
    const result = readWorkspace(json(change(classic())));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('refuses a panel id used twice and a split inside a split that runs the same way', () => {
    const twice: LayoutNode = {
      kind: 'split',
      direction: 'row',
      weight: 1,
      children: [
        { kind: 'stack', weight: 1, selected: 0, panels: [{ id: 'chart', type: 'chart', link: 'lime', settings: {} }] },
        { kind: 'stack', weight: 1, selected: 0, panels: [{ id: 'chart', type: 'chart', link: 'lime', settings: {} }] },
      ],
    };
    expect(structureProblem(twice)).toMatch(/used twice/);
    const nested: LayoutNode = {
      kind: 'split',
      direction: 'row',
      weight: 1,
      children: [
        {
          kind: 'split',
          direction: 'row',
          weight: 1,
          children: [{ kind: 'stack', weight: 1, selected: 0, panels: [{ id: 'a', type: 'chart', link: 'lime', settings: {} }] }],
        },
      ],
    };
    expect(structureProblem(nested)).toMatch(/other way/);
    expect(readWorkspace(json({ ...classic(), tree: nested })).ok).toBe(false);
  });
});

describe('reading and migrating stored JSON', () => {
  it('refuses things that are not a workspace without throwing', () => {
    for (const raw of [null, undefined, 'text', 4, [], {}]) {
      const result = readWorkspace(raw);
      expect(result.ok).toBe(false);
    }
    expect(readWorkspace({ ...classic(), version: 0 })).toMatchObject({ ok: false, reason: 'no-version' });
    expect(readWorkspace({ ...classic(), version: '1' })).toMatchObject({ ok: false, reason: 'no-version' });
  });

  it('refuses a layout saved by a newer build instead of guessing at it', () => {
    expect(readWorkspace({ ...classic(), version: WORKSPACE_VERSION + 1 })).toMatchObject({ ok: false, reason: 'newer-version' });
  });

  it('has no migrations yet, and says so for an older version that has no step', () => {
    expect(Object.keys(MIGRATIONS)).toHaveLength(0);
    expect(readWorkspace(json(classic()), { migrations: {}, current: 2 })).toMatchObject({ ok: false, reason: 'no-migration' });
  });

  it('walks migrations one version at a time, in order, then validates the result', () => {
    // A pretend future: version 3 is the current one, and versions 1 and 2 each have a step.
    const seen: number[] = [];
    const migrations = {
      1: (raw: Record<string, unknown>) => (seen.push(1), { ...raw, step1: true }),
      2: (raw: Record<string, unknown>) => (seen.push(2), { ...raw, step2: raw.step1 === true }),
    };
    const result = readWorkspace(json(classic()), {
      migrations,
      current: 3,
      validate: (raw) => ({ ok: true, workspace: raw as unknown as WorkspaceV1 }),
    });
    expect(seen).toEqual([1, 2]);
    expect(result.ok && result.migrated).toBe(true);
    expect(result.ok && result.workspace).toMatchObject({ version: 3, step1: true, step2: true });
  });

  it('starts from the version the data says, not from 1', () => {
    const seen: number[] = [];
    const migrations = {
      1: (raw: Record<string, unknown>) => (seen.push(1), raw),
      2: (raw: Record<string, unknown>) => (seen.push(2), raw),
    };
    readWorkspace(
      { ...classic(), version: 2 },
      { migrations, current: 3, validate: (raw) => ({ ok: true, workspace: raw as unknown as WorkspaceV1 }) },
    );
    expect(seen).toEqual([2]);
  });

  it('reports a migration step that throws as invalid, never as an exception', () => {
    const migrations = {
      1: () => {
        throw new Error('boom');
      },
    };
    expect(readWorkspace(json(classic()), { migrations, current: 2 })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('reports a finished layout that fails validation as invalid, with the first problem named', () => {
    const result = readWorkspace(json({ ...classic(), name: '' }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(result.ok ? '' : result.detail).toBeTruthy();
  });

  it('marks current-version JSON as not migrated', () => {
    const result = readWorkspace(json(classic()));
    expect(result.ok && result.migrated).toBe(false);
  });
});

describe('pruneWorkspace', () => {
  const known = (type: string) => type !== 'gone';

  it('keeps a workspace whose panels are all known, untouched', () => {
    expect(pruneWorkspace(classic(), known)).toEqual(classic());
  });

  it('drops an unknown panel, collapses what it empties, and fixes the selected tab', () => {
    const workspace = json(classic()) as WorkspaceV1;
    const orderbook = panelsOf(workspace.tree).find((panel) => panel.type === 'orderbook')!;
    orderbook.type = 'gone';
    const result = pruneWorkspace(workspace, known);
    expect(result).not.toBeNull();
    const types = panelsOf(result!.tree).map((panel) => panel.type);
    expect(types).toEqual(['markets', 'chart', 'ticket', 'trades', 'orders']);
    expect(structureProblem(result!.tree)).toBeNull();
    expect(readWorkspace(json(result))).toMatchObject({ ok: true });
  });

  it('removes a whole column when every panel in it is unknown', () => {
    const workspace = json(classic()) as WorkspaceV1;
    for (const panel of panelsOf(workspace.tree)) if (panel.type === 'orderbook' || panel.type === 'trades') panel.type = 'gone';
    const result = pruneWorkspace(workspace, known);
    expect(panelsOf(result!.tree).map((panel) => panel.type)).toEqual(['markets', 'chart', 'ticket', 'orders']);
  });

  it('returns null when nothing is left to show, so the caller falls back to the preset', () => {
    expect(pruneWorkspace(classic(), () => false)).toBeNull();
  });
});

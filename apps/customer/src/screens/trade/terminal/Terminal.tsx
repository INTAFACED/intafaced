/**
 * The workspace area and its rail: the part of the desk that docks. Owns the saved book of workspaces for the signed-in
 * user, the live docking model, the lock, maximise and the hotkeys. Panels come from the registry and read the desk's
 * data from `useDesk()`.
 *
 * Saving: every change (drag, resize, close, add, lock) is written to this device after 400 ms of quiet, and straight
 * away when the page is hidden or the desk closes. Reload and the same arrangement comes back.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Actions, DockLocation, Layout, Model, type Action, type ITabRenderValues, type TabNode } from 'flexlayout-react';
import { StateBlock, Button } from '../desk/deps';
import { terminalCopy } from './copy';
import { useDesk } from './desk-context';
import { fromFlexJson, LAYOUT_CHANGING_ACTIONS, lockAttributes, toFlexJson, type PanelLook } from './flex-adapter';
import { registerBuiltInPanels } from './panels';
import { Rail, type RailActions } from './Rail';
import { getPanel, isKnownPanel, listPanels, panelsVersion, subscribePanels } from './registry';
import {
  activeWorkspace,
  addFromPreset,
  canAddWorkspace,
  deleteWorkspace,
  loadBook,
  openWorkspace,
  renameWorkspace,
  resetToPreset,
  saveAs,
  saveBook,
  setLocked,
  updateWorkspace,
  type StorageLike,
  type WorkspaceBook,
} from './store';
import { panelsOf, type LayoutNode, type PresetId, type WorkspaceV1 } from './workspace';
import { presetInfo } from './presets';

registerBuiltInPanels();

const SAVE_DELAY_MS = 400;

function deviceStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // some privacy modes throw on the property read itself
  }
}

const look = (type: string): PanelLook => {
  const definition = getPanel(type);
  return { title: definition?.title ?? type, minWidth: definition?.minWidth, minHeight: definition?.minHeight };
};

const buildModel = (workspace: WorkspaceV1) => Model.fromJson(toFlexJson(workspace, look));

/** One panel's box: the registered component, dimmed with a note while the price feed is lost. */
function PanelHost({ node }: { node: TabNode }) {
  const { t } = terminalCopy.useCopy();
  const { connection } = useDesk();
  const type = ((node.getConfig() ?? {}) as { type?: string }).type ?? '';
  const definition = getPanel(type);
  const [visible, setVisible] = useState(() => node.isVisible());
  useEffect(() => {
    setVisible(node.isVisible());
    node.setEventListener('visibility', (params: { visible: boolean }) => setVisible(params.visible));
    return () => node.removeEventListener('visibility');
  }, [node]);
  if (!definition) return <StateBlock kind="empty" title={t('Panel failed')} />;
  const Panel = definition.component;
  const stale = definition.prices === true && connection === 'reconnecting';
  return (
    <div className="tm-panel" data-type={type} data-stale={stale || undefined}>
      <Panel visible={visible} />
      {stale ? (
        <div className="tm-stale" role="status">
          {t('Reconnecting dim')}
        </div>
      ) : null}
    </div>
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]'))
    return true;
  return false;
}

export const Terminal = memo(function Terminal({ userId }: { userId: string | null }) {
  const { t } = terminalCopy.useCopy();
  const [book, setBook] = useState<WorkspaceBook>(() => loadBook(deviceStorage(), userId, isKnownPanel));
  const workspace = activeWorkspace(book);
  const [layout, setLayout] = useState(() => ({ key: 0, model: buildModel(workspace) }));
  const [maximised, setMaximised] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [canSave, setCanSave] = useState(true);
  const bookRef = useRef(book);
  bookRef.current = book;
  const modelRef = useRef(layout.model);
  modelRef.current = layout.model;
  const lockedRef = useRef(workspace.locked);
  lockedRef.current = workspace.locked;
  // Re-render the "Add panel" list when a later panel registers itself.
  useSyncExternalStore(subscribePanels, panelsVersion, panelsVersion);

  /** Show a different book state: rebuild the docking model from the open workspace. */
  const show = useCallback((next: WorkspaceBook) => {
    setBook(next);
    setEmpty(false);
    setMaximised(false);
    setLayout((previous) => ({ key: previous.key + 1, model: buildModel(activeWorkspace(next)) }));
  }, []);

  // Autosave.
  const persist = useCallback(() => setCanSave(saveBook(deviceStorage(), userId, bookRef.current)), [userId]);
  useEffect(() => {
    const timer = setTimeout(persist, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [book, persist]);
  useEffect(() => {
    const flush = () => persist();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [persist]);

  const onModelChange = useCallback((model: Model) => {
    setMaximised(model.getMaximizedTabset() !== undefined);
    const current = activeWorkspace(bookRef.current);
    const next = fromFlexJson(model.toJson(), current);
    if (!next) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    if (JSON.stringify(next.tree) !== JSON.stringify(current.tree)) setBook((previous) => updateWorkspace(previous, next));
  }, []);

  const onAction = useCallback(
    (action: Action) => (lockedRef.current && LAYOUT_CHANGING_ACTIONS.has(action.type) ? undefined : action),
    [],
  );

  const toggleLock = useCallback(() => {
    const next = !lockedRef.current;
    setBook((previous) => setLocked(previous, next));
    modelRef.current.doAction(Actions.updateModelAttributes(lockAttributes(next)));
  }, []);

  const toggleMaximise = useCallback(() => {
    const model = modelRef.current;
    const target = model.getMaximizedTabset() ?? model.getActiveTabset() ?? model.getFirstTabSet();
    if (target) model.doAction(Actions.maximizeToggle(target.getId()));
  }, []);

  const addPanel = useCallback(
    (type: string) => {
      const definition = getPanel(type);
      const model = modelRef.current;
      if (!definition) return;
      const current = activeWorkspace(bookRef.current);
      if (panelsOf(current.tree).some((panel) => panel.id === type)) return;
      const target = model.getActiveTabset() ?? model.getFirstTabSet();
      if (!target) {
        // Nothing left on the desk: start a new layout from this one panel.
        const tree: LayoutNode = { kind: 'stack', weight: 100, selected: 0, panels: [{ id: type, type, link: 'lime', settings: {} }] };
        show(updateWorkspace(bookRef.current, { ...current, tree }));
        return;
      }
      const json = {
        type: 'tab',
        id: type,
        name: definition.title,
        component: 'panel',
        config: { type, link: 'lime', settings: {} },
        ...(definition.minWidth ? { minWidth: definition.minWidth } : {}),
        ...(definition.minHeight ? { minHeight: definition.minHeight } : {}),
      } as const;
      model.doAction(Actions.addTab(json, target.getId(), DockLocation.CENTER, -1));
    },
    [show],
  );

  const actions = useMemo<RailActions>(
    () => ({
      open: (id) => show(openWorkspace(bookRef.current, id)),
      create: (preset: PresetId) => show(addFromPreset(bookRef.current, preset)),
      reset: () => {
        const next = resetToPreset(bookRef.current);
        if (next) show(next);
      },
      rename: (name) => setBook((previous) => renameWorkspace(previous, activeWorkspace(previous).id, name)),
      copy: (name) => {
        const next = saveAs(bookRef.current, name);
        if (next !== bookRef.current) setBook(next); // same layout, so the live model stays
      },
      remove: () => show(deleteWorkspace(bookRef.current, activeWorkspace(bookRef.current).id)),
      addPanel,
      toggleLock,
      toggleMaximise,
    }),
    [show, addPanel, toggleLock, toggleMaximise],
  );

  // Hotkeys (PRO-TERMINAL-PLAN section 8): F maximise, L lock, 1-9 and 0 open workspaces 1-10, Esc restores a maximised panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (modelRef.current.getMaximizedTabset() && !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'))
          toggleMaximise();
        return;
      }
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        toggleMaximise();
      } else if (key === 'l') {
        event.preventDefault();
        toggleLock();
      } else if (/^[0-9]$/.test(key)) {
        const slot = key === '0' ? 9 : Number(key) - 1;
        const target = bookRef.current.items[slot];
        if (target && target.id !== bookRef.current.activeId) {
          event.preventDefault();
          show(openWorkspace(bookRef.current, target.id));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, toggleLock, toggleMaximise]);

  const factory = useCallback((node: TabNode) => <PanelHost node={node} />, []);
  const onRenderTab = useCallback(
    (node: TabNode, values: ITabRenderValues) => {
      const type = ((node.getConfig() ?? {}) as { type?: string }).type ?? '';
      if (getPanel(type)?.status === 'preview')
        values.content = (
          <>
            {node.getName()}
            <span className="tm-chip">{t('Preview')}</span>
          </>
        );
    },
    [t],
  );

  const open = useMemo(() => new Set(panelsOf(workspace.tree).map((panel) => panel.id)), [workspace.tree]);
  const preset = workspace.preset ? presetInfo(workspace.preset) : null;

  return (
    <div className="tm-workspace" data-locked={workspace.locked || undefined} data-maximised={maximised || undefined}>
      <section className="tm-area" aria-label={t('Trading desk layout')}>
        <Layout
          key={layout.key}
          model={layout.model}
          factory={factory}
          onAction={onAction}
          onModelChange={onModelChange}
          onRenderTab={onRenderTab}
          realtimeResize
        />
        {empty ? (
          <div className="tm-empty">
            <StateBlock kind="empty" title={t('Empty desk title')} body={t('Empty desk body')} />
            {workspace.preset ? (
              <Button variant="secondary" size={40} onClick={actions.reset}>
                {t('Empty desk reset')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
      <Rail
        items={book.items.map((item) => ({ id: item.id, name: item.name }))}
        activeId={book.activeId}
        locked={workspace.locked}
        maximised={maximised}
        canSave={canSave}
        canAdd={canAddWorkspace(book)}
        resetPreset={preset?.name ?? null}
        panels={listPanels().map((definition) => ({
          type: definition.type,
          title: definition.title,
          about: definition.about,
          status: definition.status,
          open: open.has(definition.type),
        }))}
        actions={actions}
      />
    </div>
  );
});

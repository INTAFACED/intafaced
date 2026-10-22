import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@intafaced/ui';
import { drawingsCopy, type drawingsMessages } from './copy';
import type { DrawingsApi } from './useDrawings';
import { TOOL_GROUPS, type ToolId } from './tools';

type Translate = (key: keyof typeof drawingsMessages, vars?: Record<string, string>) => string;

/**
 * The drawing toolbar: tool groups, undo and redo, delete, text, magnet, hide all and clear all (which asks first, in an
 * in-app dialog). Every tool is a button with its name as its label, so a test finds it by its name.
 */
export function DrawingToolbar({ api }: { api: DrawingsApi }) {
  const { t: copyT } = drawingsCopy.useCopy();
  const t = copyT as unknown as Translate;
  const [confirmClear, setConfirmClear] = useState(false);
  const hasDrawings = api.drawings.length > 0;

  return (
    <div className="dw-toolbar" role="toolbar" aria-label={t('Drawing tools')} aria-orientation="vertical">
      {TOOL_GROUPS.map((group) => (
        <div key={group.id} className="dw-group" role="group" aria-label={t(`Group ${group.id}` as keyof typeof drawingsMessages)}>
          {group.tools.map((tool) => (
            <ToolButton key={tool} tool={tool} active={api.tool === tool} onPick={() => api.setTool(tool)} t={t} />
          ))}
        </div>
      ))}

      <div className="dw-group dw-actions" role="group" aria-label={t('Drawing actions')}>
        <Button type="button" variant="secondary" size={32} disabled={!api.canUndo} onClick={api.undo}>
          {t('Undo')}
        </Button>
        <Button type="button" variant="secondary" size={32} disabled={!api.canRedo} onClick={api.redo}>
          {t('Redo')}
        </Button>
        <Button type="button" variant="secondary" size={32} disabled={!api.selected} onClick={api.deleteSelected}>
          {t('Delete selected')}
        </Button>
        <button
          type="button"
          className="dw-toggle"
          aria-pressed={api.magnet}
          disabled={!api.magnetAvailable}
          onClick={() => api.setMagnet(!api.magnet)}
        >
          {api.magnet ? t('Magnet on') : t('Magnet off')}
        </button>
        <button
          type="button"
          className="dw-toggle"
          aria-pressed={api.selected?.locked ?? false}
          disabled={!api.selected}
          onClick={() => api.selected && api.setLocked(api.selected.id, !api.selected.locked)}
        >
          {api.selected?.locked ? t('Unlock selected') : t('Lock selected')}
        </button>
        <Button type="button" variant="secondary" size={32} disabled={!hasDrawings} onClick={api.hideAll}>
          {api.hiddenAll ? t('Show all drawings') : t('Hide all drawings')}
        </Button>
        <Button type="button" variant="secondary" size={32} disabled={!hasDrawings} onClick={() => setConfirmClear(true)}>
          {t('Clear all drawings')}
        </Button>
      </div>

      <label className="dw-text-field">
        <span>{t('Text label')}</span>
        <input value={api.textValue} onChange={(event) => api.setTextValue(event.target.value)} maxLength={120} />
      </label>

      {!api.magnetAvailable ? <p className="dw-note">{t('Magnet blank')}</p> : null}
      <p className="dw-hint" role="status">
        {api.hint}
      </p>
      {api.notice ? (
        <p className="dw-notice" role="alert">
          {api.notice}
          <button type="button" className="dw-link" onClick={api.clearNotice}>
            {t('Dismiss')}
          </button>
        </p>
      ) : null}
      {!api.saved ? (
        <p className="dw-notice" role="alert" data-testid="drawings-not-saved">
          {t('Not saved on this device')}
          <button type="button" className="dw-link" onClick={api.retrySave}>
            {t('Try saving again')}
          </button>
        </p>
      ) : null}

      <AlertDialog open={confirmClear} onOpenChange={(next) => setConfirmClear(next)}>
        {confirmClear ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Clear all title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Clear all body')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="secondary" size={40} onClick={() => setConfirmClear(false)}>
                {t('Cancel')}
              </Button>
              <Button
                variant="primary"
                shape="pill"
                size={40}
                onClick={() => {
                  setConfirmClear(false);
                  api.clearAll();
                }}
              >
                {t('Clear all confirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}

function ToolButton({ tool, active, onPick, t }: { tool: ToolId; active: boolean; onPick(): void; t: Translate }) {
  const label = t(`Tool ${tool}` as keyof typeof drawingsMessages);
  return (
    <button type="button" className="dw-tool" aria-pressed={active} aria-label={label} onClick={onPick}>
      {label}
    </button>
  );
}

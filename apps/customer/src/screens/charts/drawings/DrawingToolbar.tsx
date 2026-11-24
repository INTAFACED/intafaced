import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { drawingsCopy, type drawingsMessages } from './copy';
import type { DrawingsApi } from './useDrawings';
import { TOOL_GROUPS, type ToolId } from './tools';
import { TEXT_SIZES, TONES, type Tone } from './model';

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
    <div className="lt-stack" role="toolbar" aria-label={t('Drawing tools')} aria-orientation="vertical">
      {TOOL_GROUPS.map((group) => (
        <div key={group.id} className="lt-chips" role="group" aria-label={t(`Group ${group.id}` as keyof typeof drawingsMessages)}>
          {group.tools.map((tool) => (
            <ToolButton key={tool} tool={tool} active={api.tool === tool} onPick={() => api.setTool(tool)} t={t} />
          ))}
        </div>
      ))}

      <div className="lt-chips" role="group" aria-label={t('Drawing actions')}>
        <Button tone="secondary" size="sm" disabled={!api.canUndo} onClick={api.undo}>
          {t('Undo')}
        </Button>
        <Button tone="secondary" size="sm" disabled={!api.canRedo} onClick={api.redo}>
          {t('Redo')}
        </Button>
        <Button tone="secondary" size="sm" disabled={!api.selected} onClick={api.deleteSelected}>
          {t('Delete selected')}
        </Button>
        <button type="button" aria-pressed={api.magnet} disabled={!api.magnetAvailable} onClick={() => api.setMagnet(!api.magnet)}>
          {api.magnet ? t('Magnet on') : t('Magnet off')}
        </button>
        <button
          type="button"
          aria-pressed={api.selected?.locked ?? false}
          disabled={!api.selected}
          onClick={() => api.selected && api.setLocked(api.selected.id, !api.selected.locked)}
        >
          {api.selected?.locked ? t('Unlock selected') : t('Lock selected')}
        </button>
        <Button tone="secondary" size="sm" disabled={!hasDrawings} onClick={api.hideAll}>
          {api.hiddenAll ? t('Show all drawings') : t('Hide all drawings')}
        </Button>
        <Button tone="secondary" size="sm" disabled={!hasDrawings} onClick={() => setConfirmClear(true)}>
          {t('Clear all drawings')}
        </Button>
      </div>

      <label className="lt-field">
        <span>{t('Text label')}</span>
        <input value={api.textValue} onChange={(event) => api.setTextValue(event.target.value)} maxLength={120} />
      </label>
      <label className="lt-field">
        <span>{t('Text size label')}</span>
        <select value={String(api.textSize)} onChange={(event) => api.setTextSize(Number(event.target.value))}>
          {TEXT_SIZES.map((size) => (
            <option key={size} value={String(size)}>
              {t('Text size option', { size: String(size) })}
            </option>
          ))}
        </select>
      </label>
      <label className="lt-field">
        <span>{t('Text colour label')}</span>
        <select value={api.textTone} onChange={(event) => api.setTextTone(event.target.value as Tone)}>
          {TONES.map((tone) => (
            <option key={tone} value={tone}>
              {t(`Colour ${tone}` as keyof typeof drawingsMessages)}
            </option>
          ))}
        </select>
      </label>

      {!api.magnetAvailable ? <p className="lt-note">{t('Magnet blank')}</p> : null}
      <p className="lt-hint" role="status">
        {api.hint}
      </p>
      {api.notice ? (
        <p className="lt-note lt-note-bad" role="alert" data-code={api.noticeCode ?? undefined}>
          {api.notice}
          <button type="button" className="lt-link" onClick={api.clearNotice}>
            {t('Dismiss')}
          </button>
        </p>
      ) : null}
      {!api.saved ? (
        <p className="lt-note lt-note-bad" role="alert" data-testid="drawings-not-saved">
          {t('Not saved on this device')}
          <button type="button" className="lt-link" onClick={api.retrySave}>
            {t('Try saving again')}
          </button>
        </p>
      ) : null}

      {confirmClear ? (
        <Sheet
          open
          role="alertdialog"
          title={t('Clear all title')}
          description={t('Clear all body')}
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <Button tone="secondary" onClick={() => setConfirmClear(false)}>
                {t('Cancel')}
              </Button>
              <Button
                tone="primary"
                onClick={() => {
                  setConfirmClear(false);
                  api.clearAll();
                }}
              >
                {t('Clear all confirm')}
              </Button>
            </>
          }
        >
          {null}
        </Sheet>
      ) : null}
    </div>
  );
}

function ToolButton({ tool, active, onPick, t }: { tool: ToolId; active: boolean; onPick(): void; t: Translate }) {
  const label = t(`Tool ${tool}` as keyof typeof drawingsMessages);
  return (
    <button type="button" aria-pressed={active} aria-label={label} onClick={onPick}>
      {label}
    </button>
  );
}

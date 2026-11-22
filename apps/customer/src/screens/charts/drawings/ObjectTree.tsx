import { useState } from 'react';
import { drawingsCopy, drawingsMessages } from './copy';
import { isVisible, SIZE_DEFAULT, TEXT_SIZES, TONES, type Drawing, type Tone } from './model';
import type { DrawingsApi } from './useDrawings';

type Translate = (key: keyof typeof drawingsMessages, vars?: Record<string, string>) => string;

/** A bar time as the chart's own axis reads it: UTC, to the minute. */
export const barTimeText = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Every drawing on the chart, with its bar times and decimal prices, so a test can read the exact stored values. The
 * chart's indicators list themselves in the slot above the drawings (the studies bar fills it through `onIndicatorsSlot`).
 */
export function ObjectTree({ api, onIndicatorsSlot }: { api: DrawingsApi; onIndicatorsSlot?: (slot: HTMLElement | null) => void }) {
  const { t: copyT } = drawingsCopy.useCopy();
  const t = copyT as unknown as Translate;
  const { drawings, doc } = api;
  const rows = [...drawings].reverse();

  return (
    <section className="lt-stack-tight" aria-label={t('Object tree')} data-testid="object-tree">
      <h2 className="lt-panel-title">{t('Object tree')}</h2>
      <p className="lt-note">{t('Object tree lead')}</p>
      {onIndicatorsSlot ? <div className="lt-stack-tight" ref={onIndicatorsSlot} /> : null}

      {drawings.length === 0 ? <p className="lt-note">{t('Object tree empty')}</p> : null}

      {doc.groups.length > 0 ? (
        <ul className="lt-list lt-list-rule">
          {doc.groups.map((group) => {
            const members = drawings.filter((d) => d.groupId === group.id).length;
            return (
              <li key={group.id} className="lt-row" data-group-id={group.id} data-hidden={group.hidden || undefined}>
                <span className="lt-grow">
                  {group.name} <span className="lt-note">({members})</span>
                </span>
                <button type="button" className="lt-link" aria-pressed={group.hidden} onClick={() => api.toggleGroupHidden(group.id)}>
                  {group.hidden ? t('Show group') : t('Hide group')}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ul className="lt-list lt-list-rule" aria-label={t('Object tree')}>
        {rows.map((drawing, index) => (
          <DrawingRow key={drawing.id} drawing={drawing} number={rows.length - index} api={api} t={t} visible={isVisible(doc, drawing)} />
        ))}
      </ul>

      {api.checked.length > 0 ? (
        <button type="button" className="lt-link" onClick={api.groupChecked}>
          {t('Group selected')} ({api.checked.length})
        </button>
      ) : null}
    </section>
  );
}

function DrawingRow({
  drawing,
  number,
  api,
  t,
  visible,
}: {
  drawing: Drawing;
  number: number;
  api: DrawingsApi;
  t: Translate;
  visible: boolean;
}) {
  const kind = t(`Kind ${drawing.kind}` as keyof typeof drawingsMessages);
  const name = t('Drawing name', { kind, n: String(number) });
  const selected = api.selectedId === drawing.id;
  const [levelText, setLevelText] = useState<string | null>(null);
  const points = drawing.points.map((p) => `${barTimeText(p.time)} · ${p.price}`).join(' | ');
  const figures = api.figures(drawing);
  const hasLevels = drawing.kind === 'fib' || drawing.kind === 'fibExtension';
  const hasText = drawing.kind === 'text';

  return (
    <li
      className="lt-row"
      data-drawing-id={drawing.id}
      data-kind={drawing.kind}
      data-selected={selected || undefined}
      data-visible={visible}
      data-pane={drawing.pane ?? 0}
      {...(hasText ? { 'data-size': drawing.size ?? SIZE_DEFAULT, 'data-tone': drawing.tone } : {})}
    >
      <label className="lt-field">
        <input
          type="checkbox"
          aria-label={t('Check drawing', { name })}
          checked={api.checked.includes(drawing.id)}
          onChange={() => api.toggleChecked(drawing.id)}
        />
      </label>
      <button type="button" className="lt-link" aria-pressed={selected} onClick={() => api.select(selected ? null : drawing.id)}>
        {name}
        {drawing.locked ? <span className="lt-badge"> {t('Locked')}</span> : null}
        {!visible ? <span className="lt-badge"> {t('Hidden')}</span> : null}
      </button>
      <span className="lt-note" data-testid="drawing-pane">
        {drawing.pane ? t('On pane', { n: String(drawing.pane) }) : t('On price pane')}
      </span>
      <span className="lt-note lt-num" data-testid="drawing-points">
        {points}
      </span>
      {figures.length > 0 ? (
        <ul className="lt-points lt-note lt-num" data-testid="drawing-figures">
          {figures.map((line, i) => (
            <li key={`${i}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="lt-row">
        <button type="button" className="lt-link" onClick={() => api.setHidden(drawing.id, !drawing.hidden)}>
          {drawing.hidden ? t('Show drawing') : t('Hide drawing')}
        </button>
        <button type="button" className="lt-link" onClick={() => api.setLocked(drawing.id, !drawing.locked)}>
          {drawing.locked ? t('Unlock drawing') : t('Lock drawing')}
        </button>
        <button type="button" className="lt-link" disabled={drawing.locked} onClick={() => api.remove(drawing.id)}>
          {t('Delete drawing')}
        </button>
      </div>
      {hasText ? (
        <label className="lt-field">
          <span>{t('Text label')}</span>
          <input
            key={`text-${drawing.id}-${drawing.text ?? ''}`}
            defaultValue={drawing.text ?? ''}
            maxLength={120}
            disabled={drawing.locked}
            onBlur={(event) => {
              if (event.currentTarget.value !== (drawing.text ?? '')) api.setText(drawing.id, event.currentTarget.value);
            }}
          />
        </label>
      ) : null}
      {hasText ? (
        <div className="lt-row">
          <label className="lt-field">
            <span>{t('Text size label')}</span>
            <select
              value={String(drawing.size ?? SIZE_DEFAULT)}
              disabled={drawing.locked}
              onChange={(event) => api.setSize(drawing.id, Number(event.target.value))}
            >
              {TEXT_SIZES.map((size) => (
                <option key={size} value={String(size)}>
                  {t('Text size option', { size: String(size) })}
                </option>
              ))}
            </select>
          </label>
          <label className="lt-field">
            <span>{t('Text colour label')}</span>
            <select
              value={drawing.tone}
              disabled={drawing.locked}
              onChange={(event) => api.setTone(drawing.id, event.target.value as Tone)}
            >
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {t(`Colour ${tone}` as keyof typeof drawingsMessages)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {hasLevels ? (
        <div className="lt-row">
          <label className="lt-field">
            <span>{t('Levels label')}</span>
            <input
              value={levelText ?? (drawing.levels ?? []).join(', ')}
              disabled={drawing.locked}
              onChange={(event) => setLevelText(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="lt-link"
            disabled={drawing.locked || levelText === null}
            onClick={() => {
              api.setLevels(
                drawing.id,
                (levelText ?? '').split(',').filter((v) => v.trim() !== ''),
              );
              setLevelText(null);
            }}
          >
            {t('Save levels')}
          </button>
        </div>
      ) : null}
    </li>
  );
}

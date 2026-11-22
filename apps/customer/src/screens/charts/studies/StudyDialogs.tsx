/**
 * The two dialogs of the studies layer: the indicator dialog (search, grouped list, Add) and a study's settings (its
 * inputs, colour and the intervals it shows on). Apply is disabled while an input is blank: nothing is filled in for it.
 */
import { useMemo, useState } from 'react';
import { Button, Checkbox } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { ALL_INTERVALS, intervalLabel } from '../workbench';
import type { ChartInterval } from '../../trade/chart/candles';
import {
  PALETTE,
  RATING_SIGNALS,
  groupByCategory,
  searchStudies,
  studyDef,
  type Category,
  type PaletteToken,
  type StudyKind,
} from './catalogue';
import { SOURCES } from './math';
import { readPeriod, readValue } from './compute';
import type { StudyInstance } from './model';
import { type StudiesWord } from './copy';
import { useWords } from './words';

const CATEGORY_KEY: Record<Category, StudiesWord> = {
  trend: 'Trend',
  oscillators: 'Oscillators',
  volume: 'Volume',
  volatility: 'Volatility',
  levels: 'Levels',
  analytics: 'Analytics',
  'higher-timeframe': 'Higher timeframe',
  derivatives: 'Derivatives',
  'on-chain': 'On-chain',
};

/** The dialog that adds a study: a search box, the studies grouped by category, and Add on each. */
export function IndicatorDialog({
  open,
  onOpenChange,
  onAdd,
  groupSize = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `toGroup` is true when the study goes to every chart of the sync group (only offered when there is one). */
  onAdd: (kind: StudyKind, toGroup: boolean) => void;
  /** Charts in this chart's sync group, this one included; the group option shows only above one. */
  groupSize?: number;
}) {
  const { t, word } = useWords();
  const [query, setQuery] = useState('');
  const [toGroup, setToGroup] = useState(false);
  const groups = useMemo(() => groupByCategory(searchStudies(query)), [query]);
  return (
    open && (
      <Sheet open title={t('Add an indicator')} closeLabel={t('Cancel')} onClose={() => onOpenChange(false)}>
        <div className="lt-field">
          <input
            type="search"
            aria-label={t('Search indicators')}
            placeholder={t('Search indicators')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {groupSize > 1 && (
          <Checkbox checked={toGroup} onCheckedChange={setToGroup}>
            {t('Add to every chart in this sync group ({n})', { n: String(groupSize) })}
          </Checkbox>
        )}
        {groups.length === 0 && <p className="lt-note">{t('No indicator matches {query}.', { query })}</p>}
        {groups.map((group) => (
          <section key={group.category} className="lt-stack-tight" aria-label={word(CATEGORY_KEY[group.category])}>
            <h3 className="lt-heading">{word(CATEGORY_KEY[group.category])}</h3>
            <ul className="lt-list lt-list-rule">
              {group.defs.map((def) => (
                <li key={def.kind} className="lt-row lt-row-between">
                  <span>{word(def.name)}</span>
                  <Button
                    tone="secondary"
                    size="sm"
                    aria-label={t('Add {name}', { name: word(def.name) })}
                    onClick={() => {
                      onAdd(def.kind, toGroup && groupSize > 1);
                      onOpenChange(false);
                    }}
                  >
                    {t('Add')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Sheet>
    )
  );
}

export interface StudyChanges {
  inputs: Record<string, string>;
  color: PaletteToken;
  hiddenOn: ChartInterval[];
}

/** The settings of one study. Its fields are drafts until Apply; a blank period or value keeps Apply disabled. */
export function StudySettings({
  study,
  onApply,
  onRemove,
  onClose,
}: {
  study: StudyInstance;
  onApply: (changes: StudyChanges) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t, word } = useWords();
  const def = studyDef(study.kind);
  const [inputs, setInputs] = useState<Record<string, string>>({ ...study.inputs });
  const [color, setColor] = useState<PaletteToken>(study.color);
  const [hidden, setHidden] = useState<ChartInterval[]>([...study.hiddenOn]);

  const blankPeriod = def.inputs.some((input) => input.kind === 'period' && readPeriod(inputs[input.key]) === null);
  const badValue = def.inputs.some((input) => input.kind === 'number' && readValue(inputs[input.key]) === null);
  const refusal = blankPeriod ? t('Enter a period') : badValue ? t('Enter a value') : null;

  const toggle = (interval: ChartInterval) =>
    setHidden((now) => (now.includes(interval) ? now.filter((i) => i !== interval) : [...now, interval]));

  const fieldLabel = (input: { key: string; label: string }) =>
    input.key.startsWith('w.')
      ? t('Weight for {signal}', { signal: RATING_SIGNALS.find((s) => `w.${s.id}` === input.key)?.label ?? input.key })
      : word(input.label);

  return (
    <Sheet open title={word(def.name)} closeLabel={t('Cancel')} onClose={onClose}>
      <form
        className="lt-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (refusal !== null) return;
          onApply({ inputs, color, hiddenOn: hidden });
        }}
      >
        {def.inputs.map((input) => {
          if (input.kind === 'source')
            return (
              <label key={input.key} className="lt-field">
                <span>{t('Source')}</span>
                <select value={inputs[input.key] ?? ''} onChange={(event) => setInputs({ ...inputs, [input.key]: event.target.value })}>
                  {SOURCES.map((name) => (
                    <option key={name} value={name}>
                      {word(name)}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (input.kind === 'interval')
            return (
              <label key={input.key} className="lt-field">
                <span>{t('Interval')}</span>
                <select value={inputs[input.key] ?? ''} onChange={(event) => setInputs({ ...inputs, [input.key]: event.target.value })}>
                  {ALL_INTERVALS.map((id) => (
                    <option key={id} value={id}>
                      {intervalLabel(id)}
                    </option>
                  ))}
                </select>
              </label>
            );
          const invalid =
            input.kind === 'period'
              ? readPeriod(inputs[input.key]) === null
              : input.kind === 'number'
                ? readValue(inputs[input.key]) === null
                : false;
          return (
            <label key={input.key} className="lt-field">
              <span>{fieldLabel(input)}</span>
              <input
                type="text"
                inputMode="decimal"
                value={inputs[input.key] ?? ''}
                aria-invalid={invalid || undefined}
                onChange={(event) => setInputs({ ...inputs, [input.key]: event.target.value })}
              />
            </label>
          );
        })}
        <label className="lt-field">
          <span>{t('Colour')}</span>
          <select value={color} onChange={(event) => setColor(event.target.value as PaletteToken)}>
            {PALETTE.map((token, n) => (
              <option key={token} value={token}>
                {t('Colour {n}', { n: String(n + 1) })}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="lt-group">
          <legend>{t('Shown on')}</legend>
          <div className="lt-chips">
            {ALL_INTERVALS.map((id) => (
              <Checkbox
                key={id}
                checked={!hidden.includes(id)}
                onCheckedChange={() => toggle(id)}
                aria-label={t('Shown on {interval}', { interval: intervalLabel(id) })}
              >
                {intervalLabel(id)}
              </Checkbox>
            ))}
          </div>
        </fieldset>
        {refusal !== null && (
          <p className="lt-alert" role="alert">
            {refusal}
          </p>
        )}
        <div className="lt-actions">
          <Button type="button" tone="quiet" onClick={onRemove}>
            {t('Remove study')}
          </Button>
          <Button type="submit" tone="primary" disabled={refusal !== null}>
            {t('Apply')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

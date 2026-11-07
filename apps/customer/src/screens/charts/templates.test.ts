import { describe, expect, it } from 'vitest';
import { EMPTY_CHART_TEMPLATES } from '@intafaced/contracts/chart-templates-preferences';
import { saveTemplate, studiesFrom, styleFrom } from './templates';
import { FRESH_STORE, type StudyStore } from './studies/model';

const NOW = new Date('2026-11-07T09:00:00.000Z');
const studies: StudyStore = {
  studies: [
    { id: 'sma-1', kind: 'sma', inputs: { period: '20' }, color: 'ma-2', hiddenOn: [] },
    { id: 'rsi-1', kind: 'rsi', inputs: { period: '14' }, color: 'ma-3', hiddenOn: ['1m'] },
  ],
  remembered: {},
  legendAlways: true,
};

describe('chart templates', () => {
  const value = saveTemplate(EMPTY_CHART_TEMPLATES, { name: 'TEST studies', studies, style: 'line', scheme: 'mono' }, NOW);
  const template = value.templates[0]!;

  it('keeps the study set and the style under the name', () => {
    expect(template).toMatchObject({ name: 'TEST studies', style: 'line', scheme: 'mono', legendAlways: true });
    expect(template.studies.map((study) => study.kind)).toEqual(['sma', 'rsi']);
  });

  it('the same name replaces the template', () => {
    const again = saveTemplate(value, { name: 'test studies', studies: FRESH_STORE, style: 'candles', scheme: 'standard' }, NOW);
    expect(again.templates).toHaveLength(1);
    expect(again.templates[0]?.id).toBe(template.id);
  });

  it('applies the same study set to another workbench, keeping what it remembers', () => {
    const other: StudyStore = { ...FRESH_STORE, remembered: { ema: { inputs: { period: '50' }, color: 'lime' } } };
    const applied = studiesFrom(template, other);
    expect(applied?.studies).toEqual(studies.studies);
    expect(applied?.remembered).toEqual(other.remembered);
    expect(styleFrom(template)).toEqual({ mode: 'line', scheme: 'mono' });
  });

  it('applies nothing when a study is not one the chart can draw', () => {
    expect(studiesFrom({ ...template, studies: [{ ...template.studies[0]!, kind: 'unknown' }] }, FRESH_STORE)).toBeNull();
  });
});

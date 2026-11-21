import { describe, expect, it } from 'vitest';
import { EMPTY_CHART_TEMPLATES, chartTemplatesValueSchema } from '@intafaced/contracts/chart-templates-preferences';
import { drawingsFrom, saveTemplate, studiesFrom, styleFrom } from './templates';
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

describe("a template's drawings", () => {
  const line = {
    id: 'd-1',
    kind: 'horizontal' as const,
    points: [{ time: 1_700_000_000, price: '65000.10' }],
    tone: 'accent' as const,
    locked: false,
    hidden: false,
    groupId: 'g-1',
  };
  const doc = { version: 1 as const, drawings: [line], groups: [{ id: 'g-1', name: 'Group 1', hidden: false }], hiddenAll: false };
  const saved = saveTemplate(
    EMPTY_CHART_TEMPLATES,
    { name: 'TEST lines', studies, style: 'candles', scheme: 'standard', drawings: { symbol: 'BTC/USDT', doc } },
    NOW,
  );
  const template = saved.templates[0]!;
  const empty = { version: 1 as const, drawings: [], groups: [], hiddenAll: false };

  it('keeps the drawings with the market they were drawn on, without the chart’s groups', () => {
    expect(template.drawings?.symbol).toBe('BTC/USDT');
    expect(template.drawings?.items).toEqual([
      { id: 'd-1', kind: 'horizontal', points: [{ time: 1_700_000_000, price: '65000.10' }], tone: 'accent', locked: false, hidden: false },
    ]);
    expect(chartTemplatesValueSchema.safeParse(saved).success).toBe(true);
  });

  it('places them on that market, once', () => {
    const placed = drawingsFrom(template, 'BTC/USDT', empty);
    expect(placed).toMatchObject({ placed: 1 });
    const again = placed && 'doc' in placed ? drawingsFrom(template, 'BTC/USDT', placed.doc) : null;
    expect(again).toMatchObject({ placed: 0 });
    expect(again && 'doc' in again ? again.doc.drawings : []).toHaveLength(1);
  });

  it('places none on another market and says where they are kept', () => {
    expect(drawingsFrom(template, 'ETH/USDT', empty)).toEqual({ keptFor: 'BTC/USDT', count: 1 });
  });

  it('a template with no drawings changes none', () => {
    const plain = saveTemplate(EMPTY_CHART_TEMPLATES, { name: 'TEST plain', studies, style: 'line', scheme: 'mono' }, NOW).templates[0]!;
    expect(plain.drawings).toBeUndefined();
    expect(drawingsFrom(plain, 'ETH/USDT', doc)).toEqual({ placed: 0, doc });
  });
});

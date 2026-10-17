import { describe, expect, it } from 'vitest';
import { COST_MODELS, HYPOTHESES, HYPOTHESIS_COPY, MODEL_COPY, draftStrategyNames } from './quant-analysis';
import { registeredCopy } from '../../shared/i18n';
import { analysisCopy } from './quant-analysis-copy';
import { emptyDraft } from './quant-draft';

describe('Quant analysis labels', () => {
  it('has plain-English text for every cost model and hypothesis in en, es and fr', () => {
    const keys = [...Object.values(MODEL_COPY), ...Object.values(HYPOTHESIS_COPY)];
    for (const locale of ['en', 'es', 'fr'] as const) {
      const copy = analysisCopy.forLocale(locale);
      for (const key of keys) {
        const text = copy.t(key);
        expect(text, `${locale}:${key}`).not.toMatch(/^[a-z]+(-[a-z]+)+$/);
        expect(text.length).toBeGreaterThan(3);
      }
    }
    for (const kinds of Object.values(COST_MODELS)) for (const kind of kinds) expect(MODEL_COPY).toHaveProperty([kind]);
    expect(HYPOTHESES.every((h) => h in HYPOTHESIS_COPY)).toBe(true);
  });

  it('offers only a named local draft as a strategy', () => {
    expect(draftStrategyNames(null)).toEqual([]);
    expect(draftStrategyNames(emptyDraft())).toEqual([]);
    expect(draftStrategyNames({ ...emptyDraft(), name: '   ' })).toEqual([]);
    expect(draftStrategyNames({ ...emptyDraft(), name: ' Momentum ' })).toEqual(['Momentum']);
  });

  it('never promises a later capability: no "yet" wording anywhere in the file, in en, es or fr', () => {
    const catalog = registeredCopy().find((entry) => entry.namespace === 'more.quant.analysis');
    expect(catalog).toBeDefined();
    for (const locale of ['en', 'es', 'fr'] as const)
      for (const [key, value] of Object.entries(catalog?.messages[locale] ?? {}))
        expect(String(value), `${locale}:${key}`).not.toMatch(/\byet\b|\baún\b|\btodavía\b|pas encore/i);
  });
});

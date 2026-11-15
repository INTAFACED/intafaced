import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS } from './activity-kind.js';
import { TEST_TAX_EFFECT_BY_KIND, TestTaxEffectsRefusedError, taxEffectsFor } from './tax-effects.js';

describe('taxEffectsFor (J-portfolio-03 #7)', () => {
  it('is blank by default, so the view refuses by name', () => {
    expect(taxEffectsFor('off', { APP_ENV: 'test' })).toBeNull();
    expect(taxEffectsFor('off', { APP_ENV: 'production', NODE_ENV: 'production' })).toBeNull();
  });

  it('gives the TEST map, labelled TEST, on a dev or test stack only', () => {
    const map = taxEffectsFor('test', { APP_ENV: 'test' });
    expect(map?.label).toBe('TEST');
    expect(Object.keys(map!.effects).sort()).toEqual([...ACTIVITY_KINDS].sort());
    for (const effect of Object.values(map!.effects)) expect(['income', 'disposal', 'neutral']).toContain(effect);
    expect(taxEffectsFor('test', { APP_ENV: 'dev' })?.label).toBe('TEST');
  });

  it('refuses to start with the TEST map anywhere else', () => {
    for (const env of [
      { APP_ENV: 'production' },
      { APP_ENV: undefined },
      { APP_ENV: 'staging' },
      { APP_ENV: 'test', NODE_ENV: 'production' },
    ]) {
      expect(() => taxEffectsFor('test', env)).toThrow(TestTaxEffectsRefusedError);
    }
  });

  it("takes the owner's map once it is set, unlabelled, with or without the switch", () => {
    const owner = { trade: 'disposal' } as const;
    expect(taxEffectsFor('off', { APP_ENV: 'production' }, owner)).toEqual({ effects: { trade: 'disposal' }, label: null });
    expect(taxEffectsFor('test', { APP_ENV: 'test' }, owner)).toEqual({ effects: { trade: 'disposal' }, label: null });
  });

  it('the TEST map is frozen', () => {
    expect(Object.isFrozen(TEST_TAX_EFFECT_BY_KIND)).toBe(true);
  });
});

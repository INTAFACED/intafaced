import { describe, expect, it } from 'vitest';
import { ACTIONS, readAction, refusalCode, refusalWords } from './model';

describe('card programme desk model (J-bank-26)', () => {
  it('posts only the listed steps, each to its svc-bank procedure', () => {
    expect(readAction({ action: 'ruleCreate', body: { ruleKey: 'k' } })).toEqual({
      procedure: 'ops.cardProgrammeRuleCreate',
      body: { ruleKey: 'k' },
    });
    expect(readAction({ action: 'export' })).toEqual({ procedure: 'ops.cardProgrammeExport', body: undefined });
    expect(readAction({ action: 'cardAuthorize', body: {} })).toBeNull();
    expect(readAction({ action: 'toString', body: {} })).toBeNull();
    expect(readAction({ action: 'export', body: {} })).toBeNull();
    expect(readAction({ action: 'configure' })).toBeNull();
    expect(Object.values(ACTIONS).every((p) => p.startsWith('ops.cardProgramme'))).toBe(true);
  });

  it('reads svc-bank’s code from its message and has words for the refusals the desk shows', () => {
    expect(refusalCode(null, 'Your role is Viewer (bank.card_programme_viewer)')).toBe('bank.card_programme_viewer');
    expect(refusalCode('bank.cardholder_unverified', 'x')).toBe('bank.cardholder_unverified');
    expect(refusalWords('bank.card_programme_viewer')).toContain('Viewer');
    expect(refusalWords('constructor')).toBeNull();
  });
});

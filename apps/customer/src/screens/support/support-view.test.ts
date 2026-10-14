import { describe, expect, it } from 'vitest';
import { canReply, paragraphs, pickableCategories, visibleArticles } from './support-view';

const known: Record<string, string> = { t1: 'Sign-in help', b1: 'Use recovery.', t2: 'Deposits', b2: 'Soon.' };
const text = (key: string) => known[key] ?? null;

describe('visibleArticles', () => {
  const rows = [
    { id: 'kb-account-access', titleKey: 't1', bodyKey: 'b1' },
    { id: 'kb-deposit-withdraw-honest', titleKey: 't2', bodyKey: 'b2' },
    { id: 'kb-draft', titleKey: 't1', bodyKey: 'b1', published: false },
    { id: 'kb-missing', titleKey: 'nope', bodyKey: 'b1' },
  ];
  it('drops unpublished articles, articles with no readable text, and hidden-feature articles', () => {
    expect(visibleArticles(rows, text, true).map((row) => row.id)).toEqual(['kb-account-access']);
  });
  it('keeps the hidden-feature article once that feature is on', () => {
    expect(visibleArticles(rows, text, false).map((row) => row.id)).toEqual(['kb-account-access', 'kb-deposit-withdraw-honest']);
  });
});

describe('support helpers', () => {
  it('hides the deposit category while deposits are hidden', () => {
    expect(pickableCategories(true)).toEqual(['account', 'trading', 'other']);
    expect(pickableCategories(false)).toContain('deposit_withdraw');
  });
  it('lets a person reply until the request is closed', () => {
    expect(canReply('open')).toBe(true);
    expect(canReply('resolved')).toBe(true);
    expect(canReply('closed')).toBe(false);
  });
  it('splits paragraphs', () => {
    expect(paragraphs('a\n\n\nb\n')).toEqual(['a', 'b']);
  });
});

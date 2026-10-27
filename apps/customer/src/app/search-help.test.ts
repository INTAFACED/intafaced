import { describe, expect, it, vi } from 'vitest';
import { HELP_MIN_CHARS, helpRows, searchHelp } from './search-help';

const article = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'b',
  version: 2,
  ...extra,
});
const signal = new AbortController().signal;
const fake = (answer: unknown) => {
  const query = vi.fn(async () => answer);
  return { query, api: { query } as never };
};
const answering = (data: unknown) => fake({ ok: true as const, data });

describe('help results in the header search', () => {
  it('keeps published articles with a published title, in order, up to the limit', () => {
    const rows = helpRows(
      [
        article('kb-a'),
        article('kb-b', { published: false }),
        article('kb-c', { titleKey: 'not.a.key' }),
        article('kb-d'),
        article('kb-e'),
      ],
      2,
      false,
    );
    expect(rows.map((row) => row.id)).toEqual(['kb-a', 'kb-d']);
    expect(rows[0]).toMatchObject({ title: 'Sign-in and account access', lang: 'en', href: expect.stringContaining('kb-a') });
  });

  it('leaves out articles about features this release does not offer when those rooms are hidden', () => {
    const articles = [article('kb-paper-vs-live'), article('kb-deposit-withdraw-honest'), article('kb-other')];
    expect(helpRows(articles, 10, true).map((row) => row.id)).toEqual(['kb-other']);
    expect(helpRows(articles, 10, false)).toHaveLength(3);
  });

  it('does not call the service for a query that is too short', async () => {
    const { api, query } = answering([]);
    expect(await searchHelp(api, 'a'.repeat(HELP_MIN_CHARS - 1), 5, signal)).toEqual({ status: 'idle' });
    expect(await searchHelp(api, '  ', 5, signal)).toEqual({ status: 'idle' });
    expect(query).not.toHaveBeenCalled();
  });

  it('says the limit is not set, and does not call the service, when it is blank or not a whole number above zero', async () => {
    const { api, query } = answering([article('kb-a')]);
    for (const cap of [null, 0, -1, 2.5]) expect(await searchHelp(api, 'earn', cap, signal)).toEqual({ status: 'unset' });
    expect(query).not.toHaveBeenCalled();
  });

  it('asks for exactly the limit and returns the rows', async () => {
    const { api, query } = answering([article('kb-a'), article('kb-b')]);
    const state = await searchHelp(api, '  dust ', 1, signal, false);
    expect(query).toHaveBeenCalledWith('support', 'searchKb', { q: 'dust', limit: 1 }, expect.anything(), { signal });
    expect(state).toMatchObject({ status: 'ready', rows: [{ id: 'kb-a' }] });
  });

  it('reports a refused or lost answer as failed and does not retry', async () => {
    const { api, query } = fake({ ok: false });
    expect(await searchHelp(api, 'dust', 3, signal)).toEqual({ status: 'failed' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

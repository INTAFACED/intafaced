import { describe, expect, it } from 'vitest';
import { searchKb } from './kb-catalog.js';
import type { SupportKbArticle } from '@intafaced/contracts';

/**
 * SP-kb-03. A labelled article ranks ahead of one that only mentions the word
 * in the body. J-support-public-01 step 4. The help screen shows this order.
 */

function article(over: Partial<SupportKbArticle> & Pick<SupportKbArticle, 'id' | 'titleKey' | 'bodyKey'>): SupportKbArticle {
  return { version: 1, published: true, ...over };
}

describe('searchKb ranking (SP-kb-03)', () => {
  const labelled = article({
    id: 'kb-labelled',
    titleKey: 'support.kb.labelled.title',
    bodyKey: 'support.kb.labelled.body',
    tags: ['withdrawal'],
  });
  const bodyOnly = article({
    id: 'kb-body',
    titleKey: 'support.kb.body.title',
    bodyKey: 'support.kb.withdrawal_words.body',
  });

  it('puts the labelled article first, and finds a label the body does not repeat', () => {
    expect(searchKb('withdrawal', [bodyOnly, labelled]).map((row) => row.id)).toEqual(['kb-labelled', 'kb-body']);
    expect(searchKb('withdrawal', [labelled]).map((row) => row.id)).toEqual(['kb-labelled']);
  });

  it('keeps catalog order for an empty query and stays empty when nothing matches', () => {
    expect(searchKb('', [bodyOnly, labelled]).map((row) => row.id)).toEqual(['kb-body', 'kb-labelled']);
    expect(searchKb('no-such-word', [bodyOnly, labelled])).toEqual([]);
    expect(searchKb('withdrawal', [])).toEqual([]);
  });
});

describe('searchKb finds a catalogue-keyed article by the title people read (HM-navigation-04, J-home-ia-02 #5)', () => {
  const access = article({
    id: 'kb-account-access',
    titleKey: 'support.kb.account_access.title',
    bodyKey: 'support.kb.account_access.body',
  });

  it('matches the English title as shown, in any case, whole or in part', () => {
    expect(searchKb('Sign-in and account access', [access]).map((row) => row.id)).toEqual(['kb-account-access']);
    expect(searchKb('ACCOUNT ACCESS', [access]).map((row) => row.id)).toEqual(['kb-account-access']);
  });

  it('still finds nothing for words in no title, key, label or body', () => {
    expect(searchKb('zebra crossing', [access])).toEqual([]);
  });

  it('matches a title typed in the desk on that text and still on the catalogue title the header shows', () => {
    const typed = { ...access, title: 'Getting back in' };
    expect(searchKb('Getting back in', [typed]).map((row) => row.id)).toEqual(['kb-account-access']);
    expect(searchKb('account access', [typed]).map((row) => row.id)).toEqual(['kb-account-access']);
  });

  it('never matches a key that has no catalogue text', () => {
    const unknown = article({ id: 'kb-x', titleKey: 'support.kb.no_such.title', bodyKey: 'support.kb.no_such.body' });
    expect(searchKb('account access', [unknown])).toEqual([]);
  });
});

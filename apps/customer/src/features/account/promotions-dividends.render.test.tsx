import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { PromotionTabs, promotionsViewFor } from './Promotions';
import { Dividends } from './Dividends';
import { dividendsCopy } from './dividends-copy';
import { promotionsCopy } from './promotions-copy';

describe('/uc/promotion subroutes', () => {
  it('each address opens its own section', () => {
    expect(promotionsViewFor('/uc/promotion')).toBe('overview');
    expect(promotionsViewFor('/uc/promotion/')).toBe('overview');
    expect(promotionsViewFor('/uc/promotion/mycards')).toBe('link');
    expect(promotionsViewFor('/uc/promotion/mypromotion')).toBe('records');
    expect(promotionsViewFor('/uc/promotion/mypromotion?x=1')).toBe('records');
    expect(promotionsViewFor('/uc/invitingmining')).toBe('overview');
  });

  it('draws three tabs and marks only the open one as current', () => {
    for (const [view, open] of [
      ['overview', '/uc/promotion'],
      ['link', '/uc/promotion/mycards'],
      ['records', '/uc/promotion/mypromotion'],
    ] as const) {
      const html = renderToString(<PromotionTabs view={view} />);
      expect(html.match(/<a /g)?.length).toBe(3);
      expect(html.match(/aria-current="page"/g)?.length).toBe(1);
      expect(html).toMatch(new RegExp(`href="${open}"[^>]*aria-current="page"|aria-current="page"[^>]*href="${open}"`));
      expect(html).toContain('Invitation link');
      expect(html).toContain('Referral records');
    }
  });

  it('has the new labels in Spanish and French', () => {
    for (const locale of ['es', 'fr'] as const) {
      const copy = promotionsCopy.forLocale(locale);
      for (const key of ['tabsLabel', 'tabOverview', 'tabLink', 'tabRecords'] as const) expect(copy.t(key)).not.toBe(promotionsCopy.t(key));
    }
  });
});

describe('/uc/paydividends room', () => {
  const html = renderToString(<Dividends />);

  it('explains what dividends are here and what is needed', () => {
    expect(html).toContain('What dividends are here');
    expect(html).toContain('What is needed');
    expect(html).toContain('not switched on');
    expect(html).toContain('not a statement that you were paid nothing');
  });

  it('shows the history as a table with headers and an empty state, and invents no rows', () => {
    expect(html).toContain('Your dividend history');
    for (const head of ['Date', 'Asset', 'Amount', 'Paid for']) expect(html).toContain(`>${head}</th>`);
    expect(html).toContain('No dividends listed');
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)?.length).toBe(1);
    expect(html).not.toMatch(/<td[^>]*>\s*[\d.,]+\s*(USDT|USDC|IFC|BTC)?\s*<\/td>/);
  });

  it('links to the rooms where holdings live', () => {
    for (const href of ['/token', '/bank/earn', '/money/activity']) expect(html).toContain(`href="${href}"`);
  });

  it('is written in plain language, in every language, with every key translated', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const { missing } = dividendsCopy.coverage(locale);
      expect(missing, locale).toEqual([]);
    }
    const copy = dividendsCopy.forLocale('en');
    const engineering = /\b(procedure|endpoint|contract|mounted|owner-scoped|payload|schema|rpc|api)\b/i;
    for (const key of ['whatBody', 'needBody', 'needToken', 'emptyBody', 'description'] as const)
      expect(copy.t(key)).not.toMatch(engineering);
  });
});

import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { PromotionTabs, promotionsViewFor } from './Promotions';
import { DividendsView } from './Dividends';
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
    expect(promotionsViewFor('/uc/promotion/points')).toBe('points');
  });

  it('draws four tabs and marks only the open one as current', () => {
    for (const [view, open] of [
      ['overview', '/uc/promotion'],
      ['link', '/uc/promotion/mycards'],
      ['records', '/uc/promotion/mypromotion'],
      ['points', '/uc/promotion/points'],
    ] as const) {
      const html = renderToString(<PromotionTabs view={view} />);
      expect(html.match(/<a /g)?.length).toBe(4);
      expect(html.match(/aria-current="page"/g)?.length).toBe(1);
      expect(html).toMatch(new RegExp(`href="${open}"[^>]*aria-current="page"|aria-current="page"[^>]*href="${open}"`));
      expect(html).toContain('Invitation link');
      expect(html).toContain('Referral records');
      expect(html).toContain('Points programme');
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
  const view = (over: Partial<Parameters<typeof DividendsView>[0]> = {}) =>
    renderToString(
      <DividendsView kind="airdrop" onKind={() => undefined} records={{ status: 'ready', data: { records: [] } }} {...over} />,
    );
  const html = view();

  it('explains what an airdrop is here and why dividends are not paid', () => {
    expect(html).toContain('What an airdrop is here');
    expect(html).toContain('Dividends');
    expect(html).toContain('wait for an owner decision');
    expect(html).toContain('not a statement that you were owed one or paid nothing');
  });

  it('shows the history as a table with headers and an honest empty state, and invents no rows', () => {
    expect(html).toContain('Your records');
    for (const head of ['Date', 'Asset', 'Amount', 'Paid for', 'Payment']) expect(html).toContain(`>${head}</th>`);
    expect(html).toContain('No records yet');
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr /g)?.length).toBe(1);
    expect(html).not.toMatch(/<td[^>]*>\s*[\d.,]+\s*(USDT|USDC|IFC|BTC)?\s*<\/td>/);
    // While the records are read, the table still invents none.
    const loading = view({ records: { status: 'loading' } });
    expect(loading).toContain('Reading your records');
    expect(loading.match(/data-testid="dividend-record"/g)).toBeNull();
  });

  it('lists a distribution with its snapshot, share and, once paid, its chain reference', () => {
    const record = {
      campaignId: 'c1',
      campaignName: 'TEST airdrop',
      kind: 'airdrop' as const,
      snapshotAt: '2026-11-16T10:00:00.000Z',
      asset: 'USDC',
      pool: '0.05',
      standing: 'counted' as const,
      equity: '100',
      equityAsset: 'USDC',
      equityAsOf: '2026-11-16T10:00:01.000Z',
      heldOut: null,
      share: '0.016667',
      rewardKey: 'distribution:c1:me',
      state: 'paid',
      chainTx: `0x${'ab'.repeat(32)}`,
      toWallet: `0x${'11'.repeat(20)}`,
    };
    const one = view({ records: { status: 'ready', data: { records: [record] } } });
    expect(one).toContain('data-testid="dividend-record"');
    expect(one).toContain('0.016667 USDC');
    expect(one).toContain(`data-tx="${record.chainTx}"`);
    expect(one).toContain('by your venue equity of 100 USDC at the snapshot');
    const held = view({
      records: {
        status: 'ready',
        data: {
          records: [
            {
              ...record,
              standing: 'held_out',
              equity: null,
              share: null,
              rewardKey: null,
              state: null,
              chainTx: null,
              heldOut: 'trade.venue.venue_down',
            },
          ],
        },
      },
    });
    expect(held).toContain('held out');
    expect(held).toContain('this is not a share of zero');
    expect(held).toContain('No share');
  });

  it('opening dividends names the owner decision and lists none', () => {
    const refused = view({
      kind: 'dividend',
      records: {
        status: 'failed',
        failure: { ok: false, reason: 'error', code: 'owner.decision', message: 'Does INTAFACED pay dividends? [owner.decision]' },
      },
    });
    expect(refused).toContain('data-testid="dividends-refusal"');
    expect(refused).toContain('Dividends wait for an owner decision: Does INTAFACED pay dividends?');
    expect(refused).toContain('No dividend records');
    expect(refused.match(/data-testid="dividend-record"/g)).toBeNull();
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

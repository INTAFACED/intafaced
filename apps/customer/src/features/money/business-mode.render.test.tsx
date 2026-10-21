import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// A business is in view. Nothing else in the session matters to these two rooms.
vi.mock('../session/session', () => ({
  useSession: () => ({ mode: 'Business', userId: '00000000-0000-4000-8000-000000000001', api: {} }),
}));

import { MoneyActivity } from './activity';
import { RepeatBuy } from './repeat-buy';

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'https://app.test', pathname: '/money/activity', search: '' },
    configurable: true,
  });
});

describe('rooms that are personal only name that when a business is in view (HM-navigation-01)', () => {
  it('Activity says company activity is not connected and links to the business bank, never a blank page', () => {
    const html = renderToString(<MoneyActivity />);
    expect(html).toContain('Company activity is not connected');
    expect(html).toContain('href="/bank/business"');
  });

  it('Repeat buy says it is personal only', () => {
    const html = renderToString(<RepeatBuy asset="BTC" open={() => undefined} />);
    expect(html).toMatch(/personal/i);
    expect(html).not.toContain('Invalid');
  });
});

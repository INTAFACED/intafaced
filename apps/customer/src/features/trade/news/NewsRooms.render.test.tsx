// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { CalendarRoom, NewsRoom } from './NewsRooms';
import type { CalendarEvent, NewsItem } from './news-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
async function show(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}
async function pick(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// TEST items only.
const items: NewsItem[] = [
  {
    id: 'n1',
    title: 'TEST one',
    source: 'TEST source',
    category: 'markets',
    language: 'en',
    symbols: ['BTC'],
    publishedAt: '2026-10-20T08:00:00Z',
  },
  {
    id: 'n2',
    title: 'TEST two',
    source: 'TEST source',
    category: 'crypto',
    language: 'es',
    symbols: [],
    publishedAt: '2026-10-20T09:00:00Z',
  },
];
const events: CalendarEvent[] = [
  {
    id: 'e1',
    title: 'TEST release',
    country: 'XX',
    priority: 'high',
    releaseAt: '2026-10-21T08:00:00Z',
    actual: '3.2',
    forecast: '3.1',
    previous: '3.0',
  },
  {
    id: 'e2',
    title: 'TEST no forecast',
    country: 'XX',
    priority: 'low',
    releaseAt: '2026-10-22T08:00:00Z',
    actual: null,
    forecast: null,
    previous: null,
  },
  { id: 'e3', title: 'TEST untimed', country: 'YY', priority: 'low', releaseAt: null, actual: null, forecast: null, previous: null },
];

describe('News', () => {
  it('shows the feed.news notice, the filters and an honest empty store', async () => {
    await show(<NewsRoom />);
    const text = host.textContent ?? '';
    expect(text).toContain('News needs a news data feed. It is switched off in this build.');
    expect(host.querySelector('code')?.textContent).toBe('feed.news');
    expect(text).toContain('The store holds no items, so there is nothing to list.');
    expect(host.querySelectorAll('select')).toHaveLength(2);
    expect(host.querySelector('input')).not.toBeNull();
    expect(text).not.toMatch(/coming soon/i);
  });

  it('filters the stored items and says so when none match', async () => {
    await show(<NewsRoom items={items} />);
    expect(host.querySelectorAll('.news-list li')).toHaveLength(2);
    const [category, language] = [...host.querySelectorAll('select')];
    await pick(category!, 'crypto');
    expect([...host.querySelectorAll('.news-list li')].map((li) => li.textContent)).toEqual([expect.stringContaining('TEST two')]);
    await pick(language!, 'en');
    expect(host.textContent).toContain('Nothing matches these filters');
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
    expect(host.querySelectorAll('.news-list li')).toHaveLength(2);
  });
});

describe('Economic calendar', () => {
  it('shows the notice, the filters and an honest empty store', async () => {
    await show(<CalendarRoom />);
    expect(host.textContent).toContain('The calendar needs a news data feed. It is switched off in this build.');
    expect(host.querySelector('code')?.textContent).toBe('feed.news');
    expect(host.textContent).toContain('The store holds no items, so there is nothing to list.');
    expect(host.querySelectorAll('select')).toHaveLength(2);
  });

  it('reads "not published" for a blank forecast, colours only a published pair, and counts untimed events apart', async () => {
    await show(<CalendarRoom events={events} />);
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('td[data-surprise]')?.getAttribute('data-surprise')).toBe('above');
    expect(rows[1]!.textContent).toContain('not published');
    expect(rows[1]!.querySelector('td[data-surprise]')?.getAttribute('data-surprise')).toBe('none');
    expect(host.textContent).toContain('1 events have no release time and are not placed on the timeline.');
  });

  it('turns the colouring off and filters by priority', async () => {
    await show(<CalendarRoom events={events} />);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(host.querySelector('td[data-surprise="above"]')).toBeNull();
    await pick(host.querySelectorAll('select')[0]!, 'high');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});

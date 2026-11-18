import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchMissesPanel } from './notify-search-misses';

describe('the search misses panel', () => {
  it('shows each day and the total, and says it never stores who or what', () => {
    const html = renderToStaticMarkup(
      <SearchMissesPanel
        part={{ kind: 'ok', data: { from: '2026-11-01', to: '2026-11-14', days: [{ day: '2026-11-09', count: 3 }], total: 3 } }}
      />,
    );
    expect(html).toContain('3 misses from 2026-11-01 to 2026-11-14');
    expect(html).toContain('2026-11-09');
    expect(html).toContain('No account and no search words are stored');
  });
  it('says the read failed, with its code, instead of showing zero', () => {
    const html = renderToStaticMarkup(
      <SearchMissesPanel
        part={{
          kind: 'failed',
          message: 'svc-notify did not answer.',
          code: 'notify.nav_metrics_storage_unconfigured',
          notBuilt: false,
          forbidden: false,
        }}
      />,
    );
    expect(html).toContain('Search misses unavailable');
    expect(html).toContain('notify.nav_metrics_storage_unconfigured');
    expect(html).not.toContain('misses from');
  });
});

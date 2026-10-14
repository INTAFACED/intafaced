import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/security' }));

import { Nav } from './nav';

describe('Nav', () => {
  it('lists Security after the enabled modules, and marks it current on /security', () => {
    const html = renderToStaticMarkup(<Nav />);
    expect(html).toContain('href="/security"');
    expect(html.indexOf('Operator tools')).toBeLessThan(html.indexOf('Security'));
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>Security<\/a>/);
  });
  it('still shows Security, and so still shows the nav, when ADMIN_MODULES leaves only one module', () => {
    const html = renderToStaticMarkup(<Nav modules={['crm']} />);
    expect(html).toContain('>CRM<');
    expect(html).toContain('>Security<');
    expect(html).not.toContain('Ledger ops');
  });
  it('hides the bar when Security would be its only link (nothing else to go to)', () => {
    const html = renderToStaticMarkup(<Nav modules={[]} />);
    // The page is still reachable by URL.
    expect(html).toBe('');
  });
});

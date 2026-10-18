import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { PortalNotFound } from './PortalNotFound';

describe('an unknown business address', () => {
  it('stays inside the frame, says so plainly, and links back to Overview', () => {
    const out = renderToString(<PortalNotFound />);
    expect(out).toContain('Page not found');
    expect(out).toContain('plo-navigation');
    expect(out).toContain('href="/pay/merchant"');
    expect(out).not.toMatch(/404|backend|route/i);
  });
});

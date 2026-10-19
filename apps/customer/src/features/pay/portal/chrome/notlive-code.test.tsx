import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NotLiveCard } from './NotLiveCard';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

describe('NotLiveCard allowlist code', () => {
  it('shows the allowlisted blocker code under the reason', () => {
    const out = renderToString(<NotLiveCard reason="Email sending needs a provider." code="vendor.email" />);
    expect(out).toContain('vendor.email');
    expect(out).toContain('data-code="vendor.email"');
  });
  it('renders no code line when none is given', () => {
    expect(renderToString(<NotLiveCard reason="x" />)).not.toContain('pfo-soon-code');
  });
});

// @ts-expect-error an unknown blocker code is refused at type-check
export const refused = <NotLiveCard reason="x" code="backend.later" />;

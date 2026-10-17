import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../../account/IdentitySessions', () => ({ IdentitySessions: () => <p>SESSION LIST</p> }));
import { parsePortalRoute } from '../../routes';
import { SecurityView } from './Security';

describe('security', () => {
  it('is routed', () => {
    expect(parsePortalRoute('/pay/settings/security')).toEqual({ room: 'settings-security' });
  });
  it('shows this session, the session list and where to manage sign-in', () => {
    const out = renderToString(<SecurityView role="owner" interactive verified />);
    expect(out).toContain('Signed in with two-step verification');
    expect(out).toContain('SESSION LIST');
    expect(out).toContain('href="/settings/security"');
    expect(out).toContain('href="/pay/developer/keys"');
  });
  it('says so, and asks for two-step sign-in, when the session has none', () => {
    const out = renderToString(<SecurityView role="finance" interactive={false} verified={false} />);
    expect(out).toContain('Signed in without two-step verification');
    expect(out).toContain('needs two-step verification');
  });
  it('never claims what it does not know', () => {
    const out = renderToString(<SecurityView role={null} interactive={null} verified={false} />);
    expect(out).toContain('Not known');
    expect(out).not.toContain('Signed in with two-step verification');
  });
  it('names the team-wide rules as waiting, not as a pass', () => {
    const out = renderToString(<SecurityView role="owner" interactive verified />);
    expect(out).toContain('Waiting on team sign-in rules');
    expect(out).not.toContain('Coming soon');
  });
});

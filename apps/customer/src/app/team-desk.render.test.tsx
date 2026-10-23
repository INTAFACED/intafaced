import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shared/preferences', async (original) => {
  const real = await original<typeof import('../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { authoredRefusal } from '../shared/api';
import { TeamDeskView, ownAnswer, teamConsoleHref } from './TeamDesk';

describe('console address', () => {
  it('is read from the configured address and joined to the room path', () => {
    expect(teamConsoleHref('/ops', 'https://console.example.com')).toBe('https://console.example.com/ops');
    expect(teamConsoleHref('/platform', 'https://console.example.com/team/')).toBe('https://console.example.com/team/platform');
  });
  it('is absent when nothing is configured', () => {
    expect(teamConsoleHref('/ops', undefined)).toBeUndefined();
    expect(teamConsoleHref('/ops', '')).toBeUndefined();
  });
  it('refuses an unsafe address: plain http, embedded sign-in details, query or fragment, or junk', () => {
    expect(teamConsoleHref('/ops', 'http://console.example.com')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'https://user:pw@console.example.com')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'https://console.example.com/?token=1')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'https://console.example.com/#x')).toBeUndefined();
    expect(teamConsoleHref('/ops', 'not a url')).toBeUndefined();
  });
  it('allows plain http only for a local dev server', () => {
    expect(teamConsoleHref('/ops', 'http://localhost:3100', true)).toBe('http://localhost:3100/ops');
    expect(teamConsoleHref('/ops', 'http://localhost:3100', false)).toBeUndefined();
    expect(teamConsoleHref('/ops', 'http://console.example.com', true)).toBeUndefined();
  });
});

const personal = 'Personal' as const;
const business = 'Business' as const;

describe('/ops and /platform room', () => {
  it('has a back link and says honestly that the tools live in a separate console', () => {
    const html = renderToString(<TeamDeskView href={undefined} check={{ kind: 'not_operator' }} mode={personal} />);
    expect(html).toContain('Back to home');
    expect(html).toContain('href="/"');
    expect(html).toContain('separate console with its own sign-in');
    expect(html).toContain('no operator tools');
  });
  it('opens the console for a founder whose entitlement is enabled', () => {
    const html = renderToString(<TeamDeskView href="https://console.example.com/ops" check={{ kind: 'enabled' }} mode={personal} />);
    expect(html).toContain('href="https://console.example.com/ops"');
    expect(html).toContain('Open Team');
    expect(html).not.toContain('not configured');
  });
  it('tells a founder the address is not configured, and offers no dead link, when it is missing', () => {
    const html = renderToString(<TeamDeskView href={undefined} check={{ kind: 'enabled' }} mode={personal} />);
    expect(html).toContain('not configured');
    expect(html).not.toContain('Open Team');
  });
  it.each(['not_operator', 'revoked', 'unconfigured'] as const)(
    'offers no console link to a %s account even when the address is set',
    (kind) => {
      const html = renderToString(<TeamDeskView href="https://console.example.com/ops" check={{ kind }} mode={personal} />);
      expect(html).not.toContain('console.example.com');
      expect(html).not.toContain('Open Team');
      expect(html).toContain('Nothing to open here');
    },
  );
  it('points a business user at merchant admin, with no founder control', () => {
    const html = renderToString(<TeamDeskView href="https://console.example.com/ops" check={{ kind: 'not_operator' }} mode={business} />);
    expect(html).toContain('href="/pay/merchant"');
    expect(html).toContain('Open merchant admin');
    expect(html).not.toContain('Open Team');
  });
  it('asks a signed-out visitor to sign in instead of offering the console', () => {
    const html = renderToString(<TeamDeskView href="https://console.example.com/ops" check={{ kind: 'signed_out' }} mode={personal} />);
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('Open Team');
  });
  it('says the check is running, and when it failed offers a retry but no console link', () => {
    expect(renderToString(<TeamDeskView href="https://console.example.com/ops" check={{ kind: 'checking' }} mode={personal} />)).toContain(
      'Checking founder access',
    );
    const html = renderToString(
      <TeamDeskView href="https://console.example.com/ops" check={{ kind: 'unread', retry: () => {} }} mode={personal} />,
    );
    expect(html).toContain('could not be checked');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Open Team');
  });
});

describe('founder answer ownership', () => {
  const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const enabled = {
    ok: true as const,
    data: { status: 'enabled' as const, userId: USER, version: '1', changedAt: '2026-10-22T00:00:00.000Z' },
  };
  it('keeps an answer about the signed-in account, whatever the id case', () => {
    expect(ownAnswer(enabled, USER)).toBe(enabled);
    expect(ownAnswer(enabled, USER.toUpperCase())).toBe(enabled);
  });
  it('refuses an answer about anybody else', () => {
    const other = ownAnswer(enabled, '1b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(other.ok).toBe(false);
    expect(other.ok ? undefined : other.reason).toBe('invalid_response');
  });
  it('passes a refusal through unchanged', () => {
    const refused = authoredRefusal('unreachable', { key: 'loadFailed' });
    expect(ownAnswer(refused, USER)).toBe(refused);
  });
});

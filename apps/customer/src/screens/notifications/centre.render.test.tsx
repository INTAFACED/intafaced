import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../../features/session/session';
import { ChannelCard } from './ChannelCard';
import { CategoryGrid, CategoryTable, cellKind } from './CategoryGrid';
import { mergeRows } from './use-category-prefs';
import type { CategoryPrefRow } from './notify-api';
import { buildChannels } from './use-centre';

const html = (node: React.ReactNode) => renderToString(<SessionProvider>{node}</SessionProvider>);
const mute = async () => true;

describe('channel card', () => {
  it('switches the pause switch and the add button off, with the reason, when the platform cannot send email', () => {
    const channels = buildChannels([{ channel: 'email', configured: false, available: false }], [{ channel: 'email', muted: false }], []);
    const page = html(<ChannelCard channel="email" view={channels.email} onMute={mute} onChanged={() => undefined} />);
    expect(page).toContain('Not switched on for this platform');
    expect(page).toContain('Switched off: this way of reaching you is not set up on the platform.');
    expect(page).toContain('Switched off: this channel is not set up on the platform, so a code cannot be sent.');
    const buttons = page.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toContain('disabled');
  });

  it('offers add and keeps the switch on when email is ready and nothing is saved', () => {
    const channels = buildChannels([{ channel: 'email', configured: true, available: true }], [{ channel: 'email', muted: false }], []);
    const page = html(<ChannelCard channel="email" view={channels.email} onMute={mute} onChanged={() => undefined} />);
    expect(page).toContain('No address saved yet.');
    expect(page).toContain('Add address');
    expect(page).not.toContain('Switched off: this channel');
  });

  it('opens the code step for an address that is saved but not confirmed', () => {
    const channels = buildChannels(
      [{ channel: 'sms', configured: true, available: true }],
      [{ channel: 'sms', muted: false }],
      [{ channel: 'sms', address: '+447700900000', verifiedAt: null }],
    );
    const page = html(<ChannelCard channel="sms" view={channels.sms} onMute={mute} onChanged={() => undefined} />);
    expect(page).toContain('Not confirmed');
    expect(page).toContain('Six-digit code');
  });

  it('explains why a phone cannot be added from the web', () => {
    const channels = buildChannels([{ channel: 'push', configured: true, available: true }], [{ channel: 'push', muted: false }], []);
    const page = html(<ChannelCard channel="push" view={channels.push} onMute={mute} onChanged={() => undefined} />);
    expect(page).toContain('Registering one is not available from the web app');
  });
});

const row = (over: Partial<CategoryPrefRow>): CategoryPrefRow => ({
  category: 'promotions',
  channel: 'email',
  enabled: true,
  locked: false,
  configured: true,
  notConnected: null,
  ...over,
});

describe('category grid', () => {
  it('shows a loading block before the service answers', () => {
    expect(html(<CategoryGrid />)).toContain('What reaches you, by category');
  });

  it('names why a cell cannot be changed: not connected first, then not set up, then fixed on', () => {
    expect(cellKind(row({ notConnected: 'vendor.sms', configured: false, locked: true }))).toBe('notConnected');
    expect(cellKind(row({ configured: false, locked: true }))).toBe('platformOff');
    expect(cellKind(row({ locked: true }))).toBe('locked');
    expect(cellKind(row({}))).toBe('free');
  });

  it('replaces only the rows the service returned', () => {
    const current = [row({ channel: 'email' }), row({ channel: 'sms', enabled: true })];
    const merged = mergeRows(current, [row({ channel: 'sms', enabled: false })]);
    expect(merged.map((r) => [r.channel, r.enabled])).toEqual([
      ['email', true],
      ['sms', false],
    ]);
  });

  it('switches a fixed or unconnected cell off and says why beside it', () => {
    const rows = [
      row({ category: 'security', channel: 'email', locked: true }),
      row({ category: 'promotions', channel: 'sms', notConnected: 'vendor.sms', configured: false, enabled: false }),
      row({ category: 'promotions', channel: 'email' }),
    ];
    const page = html(<CategoryTable rows={rows} onSet={() => undefined} />);
    expect(page).toContain('Always on. We keep this one on for your protection.');
    expect(page).toContain('Not connected on this platform, so nothing can be sent here.');
    const switches = page.match(/<[a-z]+\b[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches.length).toBe(3);
    expect(switches.filter((tag) => tag.includes('data-disabled=""')).length).toBe(2);
  });
});

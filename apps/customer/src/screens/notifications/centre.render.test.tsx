import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../../features/session/session';
import { ChannelCard } from './ChannelCard';
import { TopicTable } from './TopicTable';
import { buildChannels } from './use-centre';

const html = (node: React.ReactNode) => renderToString(<SessionProvider>{node}</SessionProvider>);
const mute = async () => true;

describe('channel card', () => {
  it('switches the pause switch and the add button off, with the reason, when the platform cannot send email', () => {
    const channels = buildChannels([{ channel: 'email', configured: false, available: false }], [{ channel: 'email', muted: false }], []);
    const page = html(<ChannelCard channel="email" view={channels.email} onMute={mute} onChanged={() => undefined} />);
    expect(page).toContain('Not switched on for this platform yet');
    expect(page).toContain('Switched off: this way of reaching you is not set up on the platform yet.');
    expect(page).toContain('Switched off: this channel is not set up on the platform yet, so a code cannot be sent.');
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
    expect(page).toContain('Registering one is not available from the web app yet');
  });
});

describe('topic table', () => {
  it('lists every topic against the inbox and each outside channel, and shows the per-topic switch off with its reason', () => {
    const channels = buildChannels([], [], []);
    const page = html(<TopicTable channels={channels} />);
    for (const topic of ['Trading', 'P2P', 'Account', 'Money', 'Token', 'Agents']) expect(page).toContain(topic);
    expect(page).toContain('Not set up');
    expect(page).toContain('Switched off: choosing by topic is not available yet.');
  });
});

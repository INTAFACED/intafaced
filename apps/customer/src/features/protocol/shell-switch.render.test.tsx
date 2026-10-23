import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { ShellSwitch } from './ShellSwitch';

const links = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)"( aria-current="page")?>/g)].map((m) => `${m[1]}${m[2] ? ' (here)' : ''}`);

describe('The Exchange | Web3 switch (HM-shell-01)', () => {
  it('marks the shell on screen and links it to the route on screen, the other shell to its default with no history', () => {
    expect(links(renderToString(<ShellSwitch current="exchange" here="/money/activity" />))).toEqual(['/money/activity (here)', '/dex']);
    expect(links(renderToString(<ShellSwitch current="web3" here="/dex/pools" />))).toEqual(['/', '/dex/pools (here)']);
  });
});

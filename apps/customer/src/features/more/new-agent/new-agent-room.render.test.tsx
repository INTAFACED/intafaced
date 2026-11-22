import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.stubGlobal('location', new URL('https://app.example.com/agents/new'));

import { SessionProvider } from '../../session';
import { NewAgentRoom } from './NewAgentRoom';

const html = () =>
  renderToString(
    <SessionProvider>
      <NewAgentRoom />
    </SessionProvider>,
  );

describe('/agents/new on the flow template (J-agents-03)', () => {
  it('is titled New agent, with the template picker and the drafting assistant, each a named region', () => {
    const page = html();
    expect(page).toMatch(/<h1[^>]*>New agent<\/h1>/);
    expect(page).toContain('data-template="flow"');
    expect(page).toContain('role="region" aria-label="Templates"');
    expect(page).toContain('role="region" aria-label="Draft with the assistant"');
    // "Start blank" needs no read; the starter waits on the service's catalogue.
    expect(page).toContain('Start blank');
    expect(page).not.toContain('Use the service starter');
    expect(page).toContain('Describe the agent in plain words');
    expect(page).toContain('Draft it');
    expect(page).not.toContain('Your agent');
  });
});

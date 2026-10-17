import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import type { useAction } from './common';
import { SupportRequestActions } from './SupportRequestActions';
import type { Ticket } from './support-schemas';

const action = { stage: () => undefined, disabled: false } as unknown as ReturnType<typeof useAction>;
const ticket = (status: Ticket['status']): Ticket => ({
  id: '22222222-2222-4222-8222-222222222222',
  userId: '11111111-1111-4111-8111-111111111111',
  category: 'account',
  subject: 'Cannot sign in',
  body: 'Help',
  status,
  assigneeId: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
});
const page = (status: Ticket['status']) =>
  renderToString(
    <SessionProvider>
      <SupportRequestActions ticket={ticket(status)} action={action} onChanged={() => undefined} />
    </SessionProvider>,
  );
const button = (html: string, label: string) => {
  const found = new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0];
  if (!found) throw new Error(`No "${label}" button on the page`);
  return found;
};

describe('close, rate and attach on a request', () => {
  it('shows all three as live controls on an open request, and never the old "no procedure" reason', () => {
    const html = page('open');
    expect(button(html, 'Close this request')).not.toContain('disabled');
    expect(button(html, 'Review attachment')).not.toContain('disabled');
    expect(html).not.toContain('has no way for you');
    expect(html).not.toContain('does not record ratings');
    expect(html).not.toContain('cannot take files. Describe');
  });

  it('keeps rating on the page, switched off with the reason, until the request is resolved', () => {
    const html = page('open');
    expect(button(html, 'Review rating')).toContain('disabled');
    expect(html).toContain('You can rate a request once it is resolved or closed.');
  });

  it('lets a resolved request be rated', () => {
    expect(button(page('resolved'), 'Review rating')).not.toContain('disabled');
  });

  it('on a closed request, close and attach are off with their reasons and rating is open', () => {
    const html = page('closed');
    expect(button(html, 'Close this request')).toContain('disabled');
    expect(html).toContain('This request is already closed.');
    expect(button(html, 'Review attachment')).toContain('disabled');
    expect(html).toContain('This request is closed, so it cannot take files.');
    expect(button(html, 'Review rating')).not.toContain('disabled');
  });
});

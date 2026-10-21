import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { RequestList } from './Support';
import type { Ticket } from './support-schemas';

const row = (id: string, status: Ticket['status']): Ticket => ({
  id,
  userId: '11111111-1111-4111-8111-111111111111',
  category: 'account',
  subject: `Subject ${status}`,
  body: 'Help',
  status,
  assigneeId: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
});
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const page = (ratedIds: ReadonlySet<string> | null) =>
  renderToString(
    <SessionProvider>
      <RequestList
        rows={[row(A, 'resolved'), row(B, 'closed'), row(C, 'open')]}
        ratedIds={ratedIds}
        onOpen={() => undefined}
        onStart={() => undefined}
      />
    </SessionProvider>,
  );
const chips = (html: string) => html.match(/data-testid="rate-chip"/g)?.length ?? 0;

describe('rate chip in My requests (SP-csat-01)', () => {
  it('shows on a solved request that has no rating, and only there', () => {
    expect(chips(page(new Set([B])))).toBe(1);
    expect(page(new Set([B]))).toContain('Rate this request');
  });

  it('shows on none once every solved request is rated', () => {
    expect(chips(page(new Set([A, B])))).toBe(0);
  });

  it('shows none while the rated ids are unread or unreadable, never a guess', () => {
    expect(chips(page(null))).toBe(0);
  });
});

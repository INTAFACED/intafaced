// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// J-agents-11 #6: a team read sent before a grant was saved landed while the save was still on its way, and the
// ticked box flipped back to unticked and unlocked. The tick must hold until a read that holds the saved grant lands.
type Answer = { ok: true; data: unknown } | { ok: false; reason: string; message: string; code?: string };
type Held = { path: string; input: unknown; answer: (a: Answer) => void };
const held: Held[] = [];
const OWNER = '11111111-1111-4111-8111-111111111111';
const ROLES = ['creator', 'runner', 'approver', 'log_reader', 'spend_reader'] as const;
const team = (runnerAllow: boolean, runnerVersion: number) => ({
  businessId: 'b-1',
  myRole: 'admin',
  canManage: true,
  members: [
    {
      userId: OWNER,
      businessRole: 'admin',
      grants: ROLES.map((role) => ({
        role,
        allow: role === 'runner' ? runnerAllow : false,
        deny: false,
        version: role === 'runner' ? runnerVersion : 0,
      })),
      effective: runnerAllow ? ['runner'] : [],
      allocation: null,
      used: '0',
    },
  ],
  pool: null,
  projects: [],
  nextProjectSeq: 1,
  used: '0',
});

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = {
    call(record: { path: string }, input?: unknown) {
      if (record.path === 'business.list')
        return Promise.resolve({ ok: true, data: [{ id: 'b-1', name: 'TEST business', status: 'active' }] });
      // The runs, approvals and usage panels are not what this test reads: their reads stay loading.
      if (!['team.view', 'team.grants.set', 'team.projects.create'].includes(record.path)) return new Promise(() => {});
      return new Promise((answer) => held.push({ path: record.path, input, answer }));
    },
  };
  return { useApi: () => api, useSession: () => ({ userId: OWNER }) };
});

const { AgentsTeam } = await import('./AgentsTeam');

/** Answers the oldest held call to `path`. */
async function answer(path: string, a: Answer) {
  await vi.waitFor(() => expect(held.some((h) => h.path === path)).toBe(true));
  const at = held.findIndex((h) => h.path === path);
  const [call] = held.splice(at, 1);
  await act(async () => call!.answer(a));
  return call!;
}

describe('AgentsTeam roles', () => {
  it('keeps a saved tick shown and locked while a team read sent before the save lands, until a read holding it lands', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AgentsTeam />));
    await answer('team.view', { ok: true, data: team(false, 0) });
    const box = () => host.querySelector<HTMLElement>('[role="checkbox"][aria-label="Allow Runner"]')!;
    await vi.waitFor(() => expect(box()).not.toBeNull());
    expect(box().getAttribute('aria-checked')).toBe('false');

    // A project is saved, and its team read is on its way.
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="New project"]')!.requestSubmit());
    await answer('team.projects.create', {
      ok: true,
      data: { project: { id: 'p-1', name: 'TEST', assetId: 'USDT', limit: '1', memberUserIds: [] }, replayed: false },
    });
    await vi.waitFor(() => expect(held.some((h) => h.path === 'team.view')).toBe(true));

    // The owner ticks Allow Runner while that read is still on its way.
    await act(async () => box().click());
    await vi.waitFor(() => expect(held.some((h) => h.path === 'team.grants.set')).toBe(true));
    expect(box().getAttribute('aria-checked')).toBe('true');

    // The read sent before the save lands: the tick stays, and the boxes stay locked.
    await answer('team.view', { ok: true, data: team(false, 0) });
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(box().hasAttribute('aria-disabled') || box().hasAttribute('data-disabled')).toBe(true);

    // The save lands as version 1, and the read after it holds it: the box is ticked and unlocked.
    const saved = await answer('team.grants.set', {
      ok: true,
      data: { grant: { role: 'runner', allow: true, deny: false, version: 1 }, replayed: false },
    });
    expect(saved.input).toMatchObject({ memberUserId: OWNER, role: 'runner', allow: true, deny: false, revision: 1 });
    expect(box().getAttribute('aria-checked')).toBe('true');
    await answer('team.view', { ok: true, data: team(true, 1) });
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(box().hasAttribute('aria-disabled') || box().hasAttribute('data-disabled')).toBe(false);
    expect(host.textContent).toContain('Saved.');

    act(() => root.unmount());
    host.remove();
  });
});

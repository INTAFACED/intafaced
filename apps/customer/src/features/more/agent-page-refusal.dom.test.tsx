// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { ok: false; reason: string; message: string };
let answer: Answer;

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = { query: async () => answer, mutate: async () => answer };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { OwnAgentPage } = await import('./AgentBuilder');

async function mount(id: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<OwnAgentPage id={id} />));
  await vi.waitFor(() => expect(host.textContent).not.toBe(''));
  return host;
}

describe("an agent's page the person cannot open", () => {
  it("names the service's not-found refusal, its code and a way back, with no retry", async () => {
    answer = { ok: false, reason: 'not_mounted', message: 'agents.own.not_found' };
    const host = await mount('TEST-not-a-record');
    await vi.waitFor(() => expect(host.textContent).toContain('This agent is not one of yours, or it no longer exists.'));
    expect(host.querySelector('code')?.textContent).toBe('agents.own.not_found');
    expect(host.querySelector('a[href="/agents"]')?.textContent).toBe('Back to your agents');
    expect(host.textContent).not.toMatch(/try again/i);
  });

  it('keeps any other failure as the read failure, with its retry', async () => {
    answer = { ok: false, reason: 'unreachable', message: 'Network down' };
    const host = await mount('11111111-1111-4111-8111-111111111111');
    await vi.waitFor(() => expect(host.textContent).not.toContain('Loading'));
    expect(host.textContent).not.toContain('This agent is not one of yours');
    expect(host.querySelector('a[href="/agents"]')).toBeNull();
  });
});

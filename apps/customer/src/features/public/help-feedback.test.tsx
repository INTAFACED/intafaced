// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const USER = '11111111-1111-4111-8111-111111111111';
const TICKET = '22222222-2222-4222-8222-222222222222';
const world = vi.hoisted(() => ({
  signedIn: true,
  sent: [] as unknown[],
  answer: undefined as unknown as (input: Record<string, unknown>) => unknown,
}));
vi.mock('../session/session', () => {
  const api = {
    query: async () => ({ ok: true, data: [] }),
    mutate: async (_module: string, _procedure: string, input: Record<string, unknown>) => {
      world.sent.push(input);
      return world.answer(input);
    },
  };
  return {
    useApi: () => api,
    useSession: () => ({ api, userId: world.signedIn ? USER : null, session: world.signedIn ? { accessToken: 'token' } : null }),
  };
});

import { HelpFeedback } from './HelpFeedback';

let host: HTMLDivElement, root: Root;
const vote = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ok: true,
  data: { articleId: input.id, version: 3, userId: USER, helpful: input.helpful, ...extra },
});
async function mount() {
  await act(async () => root.render(<HelpFeedback articleId="kb-a" version={3} />));
}
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
const text = () => host.textContent ?? '';
async function type(value: string) {
  const area = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState(null, '', '/helpdetail?id=kb-a');
  world.signedIn = true;
  world.sent = [];
  world.answer = (input) => vote(input);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('rating a published answer (J-support-public-01 #8)', () => {
  it('signed out, offers sign-in back to this answer and sends nothing', async () => {
    world.signedIn = false;
    await mount();
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/login?redirect=%2Fhelpdetail%3Fid%3Dkb-a');
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(world.sent).toEqual([]);
  });

  it('keeps a "Yes" vote under a business key for this version', async () => {
    await mount();
    await act(async () => button('Yes').click());
    expect(world.sent).toEqual([{ id: 'kb-a', helpful: true, clientRequestId: 'kb-vote:kb-a:3' }]);
    expect(text()).toContain('Thank you. Your vote is kept.');
  });

  it('sends "No" with a comment as one request and links to it', async () => {
    world.answer = (input) => vote(input, { ticketId: TICKET });
    await mount();
    await act(async () => button('No').click());
    await type('  The steps did not work  ');
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(world.sent).toEqual([
      { id: 'kb-a', helpful: false, clientRequestId: 'kb-vote:kb-a:3', comment: 'The steps did not work', openRequest: true },
    ]);
    expect(text()).toContain('your support request is open');
    expect(host.querySelector('[data-testid="help-feedback-done"] a')!.getAttribute('href')).toBe(`/support/tickets/${TICKET}`);
  });

  it('asks for words before sending a request, and sends nothing until then', async () => {
    await mount();
    await act(async () => button('No').click());
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(world.sent).toEqual([]);
    expect(text()).toContain('Write a few words about what you need');
  });

  it('says when the first vote on this version stands', async () => {
    world.answer = (input) => vote({ ...input, helpful: true }, { earlier: true });
    await mount();
    await act(async () => button('No').click());
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(text()).toContain('You already rated this version of the answer, so your first vote stands.');
  });

  it('says a request did not open when the first vote stands, and points to the desk', async () => {
    world.answer = (input) => vote(input);
    await mount();
    await act(async () => button('No').click());
    await type('Need help');
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(text()).toContain('first vote stands');
    expect(text()).toContain('Your comment was not sent as a request.');
    expect(host.querySelector('[data-testid="help-feedback-done"] a')!.getAttribute('href')).toBe('/support');
  });

  it('over the owner rate, says so in plain words and offers to go back', async () => {
    world.answer = () => ({
      ok: false,
      reason: 'error',
      status: 429,
      code: 'TOO_MANY_REQUESTS',
      message: 'support.feedback_rate_exceeded',
    });
    await mount();
    await act(async () => button('Yes').click());
    expect(text()).toContain('You have rated many answers in a short time, so this vote was not kept.');
    await act(async () => button('Back').click());
    expect(button('Yes')).toBeTruthy();
  });
});

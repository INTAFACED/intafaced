// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../features/session/session';
import { TopSearch } from './TopSearch';

let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();

const input = () => host.querySelector<HTMLInputElement>('input[name="global-search"]')!;
const panel = () => host.querySelector('.tb-search-panel');
const rowTexts = () => Array.from(host.querySelectorAll('[role="option"]')).map((row) => row.textContent);
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(key: string, target: EventTarget = document.body) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
}
const helpCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('searchKb'));

async function mount(helpCap?: number | null) {
  await act(async () => {
    root.render(<SessionProvider>{helpCap === undefined ? <TopSearch /> : <TopSearch helpCap={helpCap} />}</SessionProvider>);
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  // Markets and the session refresh are down; Help answers when asked.
  fetcher.mockReset().mockImplementation(async (url: string) =>
    String(url).includes('searchKb')
      ? new Response(
          JSON.stringify({
            result: { data: [{ id: 'kb-account-access', titleKey: 'support.kb.account_access.title', bodyKey: 'b', version: 1 }] },
          }),
          { status: 200 },
        )
      : new Response('{}', { status: 503 }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('header search: where a page lives and the Help group', () => {
  it('shows each page with the place it lives, and a parked room says it opens to its blockers', async () => {
    await mount();
    await type('earn');
    expect(rowTexts().some((text) => text?.includes('Money > '))).toBe(true);
    await type('chain');
    expect(rowTexts().find((text) => text?.includes('More > '))).toContain('Opens to its blockers');
  });

  it('with no result limit set, says so, never calls Help, and still offers Help itself', async () => {
    await mount();
    await type('password');
    expect(host.textContent).toContain('Help articles are hidden: no limit for the number of results is set.');
    expect(rowTexts()).toContain('Open Help');
    expect(helpCalls()).toHaveLength(0);
  });

  it('with a limit set, waits for a pause in typing, then lists the article before the link to Help', async () => {
    vi.useFakeTimers();
    await mount(3);
    await type('sign in');
    expect(host.textContent).toContain('Searching Help');
    expect(helpCalls()).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(helpCalls()).toHaveLength(1);
    const rows = rowTexts();
    expect(rows.slice(-2)).toEqual(['Sign-in and account access', 'Open Help']);
  });

  it('keeps the other groups when the Help call fails', async () => {
    vi.useFakeTimers();
    fetcher.mockImplementation(async () => new Response('{}', { status: 500 }));
    await mount(3);
    await type('earn');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(host.textContent).toContain('Help articles did not load.');
    expect(rowTexts().some((text) => text?.includes('Money > '))).toBe(true);
  });

  it('opens on "/" outside a field, but a "/" typed into a field stays a character', async () => {
    await mount();
    expect(panel()).toBeNull();
    await press('/', input());
    expect(panel()).toBeNull();
    await press('/');
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });
});

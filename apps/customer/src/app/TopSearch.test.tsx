// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../features/session/session';
import { TopSearch } from './TopSearch';

let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
/** The owner's help result limit as svc-ops' `home.config` answers it. */
let helpCap: number | null = null;

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
  helpCap = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  // Markets and the session refresh are down; Home's owner values leave the help result limit blank; Help answers when asked.
  fetcher.mockReset().mockImplementation(async (url: string) =>
    String(url).includes('home.config')
      ? new Response(
          JSON.stringify({ result: { data: { workListCap: null, workListOrder: null, searchResultCap: helpCap, revision: 0 } } }),
          {
            status: 200,
          },
        )
      : String(url).includes('searchKb')
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

  it("reads the help result limit from Home's owner values and lists that many articles", async () => {
    vi.useFakeTimers();
    helpCap = 2;
    await mount();
    await type('sign in');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(helpCalls()).toHaveLength(1);
    expect(String(helpCalls()[0]![0])).toContain(encodeURIComponent('"limit":2'));
    expect(rowTexts()).toContain('Open Help');
  });

  it('says Help did not load, and still offers Help, when the owner values cannot be read', async () => {
    fetcher.mockImplementation(async () => new Response('{}', { status: 500 }));
    await mount();
    await type('password');
    expect(host.textContent).toContain('Help articles did not load.');
    expect(rowTexts()).toContain('Open Help');
    expect(helpCalls()).toHaveLength(0);
  });

  it('reads the owner values again when the results reopen after a failed read', async () => {
    const answer = fetcher.getMockImplementation()!;
    let down = true;
    fetcher.mockImplementation(async (url: string) =>
      down && String(url).includes('home.config') ? new Response('{}', { status: 500 }) : answer(url),
    );
    await mount();
    await type('password');
    expect(host.textContent).toContain('Help articles did not load.');
    down = false;
    await press('Escape', input());
    await act(async () => input().focus());
    await type('password');
    expect(host.textContent).toContain('Help articles are hidden: no limit for the number of results is set.');
  });

  it('counts a submitted search that found nothing once, with no words or session in the call, and Enter opens Help', async () => {
    fetcher.mockImplementation(async (url: string) =>
      String(url).includes('/api/v1/markets')
        ? new Response(JSON.stringify([]), { status: 200 })
        : String(url).includes('home.config')
          ? new Response(
              JSON.stringify({ result: { data: { workListCap: null, workListOrder: null, searchResultCap: null, revision: 0 } } }),
              {
                status: 200,
              },
            )
          : new Response('{}', { status: 503 }),
    );
    await mount();
    await type('zzqx nothing here');
    expect(host.textContent).toContain('No results for "zzqx nothing here"');
    await press('Enter', input());
    await type('zzqx nothing here');
    await press('Enter', input());
    const misses = fetcher.mock.calls.filter(([url]) => String(url).includes('navMetrics.searchMiss'));
    expect(misses).toHaveLength(1);
    const [url, init] = misses[0] as [string, RequestInit];
    expect(url).not.toContain('zzqx');
    expect(String(init.body ?? '')).not.toContain('zzqx');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'search_miss' });
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('counts a miss once "No results" has stood for a moment, without Enter, and not the words passed while typing', async () => {
    fetcher.mockImplementation(async (url: string) =>
      String(url).includes('/api/v1/markets')
        ? new Response(JSON.stringify([]), { status: 200 })
        : String(url).includes('home.config')
          ? new Response(
              JSON.stringify({ result: { data: { workListCap: null, workListOrder: null, searchResultCap: null, revision: 0 } } }),
              { status: 200 },
            )
          : new Response('{}', { status: 503 }),
    );
    const misses = () => fetcher.mock.calls.filter(([url]) => String(url).includes('navMetrics.searchMiss'));
    await mount();
    await type('zzqx');
    await type('zzqx nothing');
    expect(misses()).toHaveLength(0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_400)));
    expect(misses()).toHaveLength(1);
    await press('Enter', input());
    expect(misses()).toHaveLength(1);
  });

  it('does not count a search where Help found an article', async () => {
    helpCap = 3;
    await mount();
    await type('zzqx nothing here');
    await press('Enter', input());
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('navMetrics.searchMiss'))).toHaveLength(0);
  });

  it('does not count a search that found something', async () => {
    await mount();
    await type('earn');
    await press('Enter', input());
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('navMetrics.searchMiss'))).toHaveLength(0);
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

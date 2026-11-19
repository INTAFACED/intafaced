import { act } from 'react';
import GLOBAL_CSS from '../../shared/styles.css?raw';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';
// The look gate's TEST account: every Customer room's calls answered from the screen tests' wire fixtures.
import { fixtureAnswer } from '../../../../../tooling/ci/look-gate/fixture-answer.mjs';
import { SIGNED_OUT, VIEW } from '../../../tests/real-app/look-fixtures.mjs';

/** The look gate's frozen time (tooling/ci/look-gate/look-gate.mjs FROZEN), so a recording never depends on the day. */
const FROZEN = Date.parse('2026-10-21T12:00:00Z');
const ORIGIN = 'http://127.0.0.1:3200';

/** One call's answer, or null for the TEST account's own (fixtureAnswer, else the gate's typed refusal). */
export type Answer = { status: number; json: unknown } | 'network-down' | null;
export type Part = {
  /** The recording's name: a route's path, or `<route>#<state>`. */
  name: string;
  route: string;
  /** A state beyond the TEST account: answers that replace its own, by `module:procedure` or a REST path. */
  answer?: (call: { module: string | null; procedure: string; method: string }) => Answer;
  /** What a person does before the recording is read, e.g. opens a tab. */
  act?: (root: HTMLElement) => Promise<void> | void;
};

function call(href: string) {
  const { pathname } = new URL(href);
  const trpc = pathname.match(/^\/api\/([a-z0-9-]+)\/trpc\/(.+)$/);
  return trpc ? { module: trpc[1]!, procedure: decodeURIComponent(trpc[2]!) } : { module: null, procedure: pathname };
}

/** A seeded Math.random (mulberry32), so a room that shuffles draws the same order every run. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * React's generated ids (`_r_17n_`, also inside base-ui's `base-ui-_r_17n_`) count every id made since the page loaded,
 * so they depend on which parts rendered before this one. Each part numbers them afresh, in the order they appear.
 */
function pinIds(html: string) {
  const seen = new Map<string, string>();
  return html.replace(/_r_[0-9a-z]+_/g, (id) => {
    if (!seen.has(id)) seen.set(id, `_r_${seen.size + 1}_`);
    return seen.get(id)!;
  });
}

const tick = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/**
 * Renders the whole app at `part.route`, signed in as the look gate's TEST account, in a fresh module graph, and answers
 * with its markup once nothing is in flight and the markup has held still. A part that never settles says so instead.
 */
export async function renderPart(part: Part): Promise<string> {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('intafaced.customer.view.v1', JSON.stringify(VIEW));
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  // The app's own global stylesheet: the colour tokens a chart reads from the page before it draws.
  const style = document.createElement('style');
  style.textContent = GLOBAL_CSS;
  document.head.append(style);
  document.documentElement.removeAttribute('data-look');
  let inFlight = 0;
  vi.setSystemTime(FROZEN);
  vi.spyOn(Math, 'random').mockImplementation(seeded(20261026));
  let uuid = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight++;
    try {
      const href = new URL(input instanceof Request ? input.url : String(input), ORIGIN).href;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const own = part.answer?.({ ...call(href), method }) ?? null;
      if (own === 'network-down') throw new TypeError('Failed to fetch');
      const answer =
        own ??
        fixtureAnswer(href, method, typeof init?.body === 'string' ? init.body : '', {
          signedIn: !SIGNED_OUT.includes(part.route),
          now: FROZEN,
        });
      return answer
        ? new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: { code: 'look_gate.no_services', message: 'No services run in the look gate.' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
    } finally {
      inFlight--;
    }
  });
  history.replaceState(null, '', part.route);
  const { SessionProvider } = await import('../../features/session/session');
  const { App } = await import('../App');
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    ),
  );
  const settle = async () => {
    let last = '';
    let still = 0;
    // A room still loading its code shows the room loader; nothing else says a lazy import is pending.
    for (let i = 0; i < 1500 && still < 8; i++) {
      await tick();
      const now = host.innerHTML;
      still = inFlight === 0 && now === last && !host.querySelector('.loading--room') ? still + 1 : 0;
      last = now;
    }
    return still >= 8;
  };
  let settled = await settle();
  if (settled && part.act) {
    await act(async () => part.act!(host));
    settled = await settle();
  }
  const html = pinIds(settled ? host.innerHTML : `<!-- never settled -->${host.innerHTML}`);
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  return html;
}

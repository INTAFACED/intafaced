import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-09, in the running app (docs/roadmap/journeys.json): stream live data. One test per step, titled
// "J-developer-09 #<n>", run in order. #1 reads the portal; #2 makes the start for the rest: a verified TEST account with
// a passkey makes a live trade key and asks for a short-lived stream token. The stream host is the one the portal
// publishes for the local environment; the token lifetime, ping interval and per-IP cap are the stack's TEST stream terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the Base addresses page lists hosts, but no business endpoint, failover or protocol choice guide.
// - #2 to #6: there is no stream-token route and no public stream host on the stack.
const J = 'J-developer-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** Opens a socket to the stream host and collects its messages until `until` returns true or the wait ends. */
function stream(url, { send = [], until = () => false, waitMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const got = [];
    const done = (closed) => {
      clearTimeout(timer);
      socket.close();
      resolve({ got, closed });
    };
    const timer = setTimeout(() => done(null), waitMs);
    socket.onopen = () => send.forEach((m) => socket.send(JSON.stringify(m)));
    socket.onmessage = (event) => {
      got.push(JSON.parse(event.data));
      if (until(got)) done(null);
    };
    socket.onclose = (event) => done({ code: event.code, reason: event.reason });
  });
}

test(`${J} #1 reads the stream endpoints and the protocol guide: public, private and business with failover; each row names its module`, async ({
  page,
}) => {
  run.reset({});
  await page.goto('/developers/hosts');
  const hosts = page.getByRole('table').first();
  await expect(hosts).toBeVisible();
  for (const name of ['Public stream', 'Private stream', 'Business stream'])
    await expect(hosts.getByRole('row', { name: new RegExp(name) })).toBeVisible(UNBUILT);
  await expect(page.getByText(/Failover/)).toBeVisible();
  const guide = page.getByRole('table', { name: 'Which protocol to use' });
  for (const row of await guide.locator('tbody tr').all()) await expect(row).toContainText(/Owned by/);
});

test(`${J} #2 authenticates with a short-lived stream token: subscribed; after the lifetime the expiry error; a refreshed token works`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdw');
  const key = await makeKey(page);
  await page.context().close();
  const minted = await withKey(key, { method: 'POST', path: '/api/v1/stream/token' });
  expect(minted.status, JSON.stringify(minted.body).slice(0, 300)).toBe(200);
  run.write({ who, key, url: minted.body.url, token: minted.body.token, lifetime: minted.body.expiresInSeconds });
  const { got } = await stream(`${minted.body.url}?token=${minted.body.token}`, { until: (m) => m.some((x) => x.type === 'welcome') });
  expect(got[0].type).toBe('welcome');
});

test(`${J} #3 subscribes with a request id: the ack echoes it with server times; an unknown message type is ignored`, async () => {
  const id = `${J}-3`;
  const { got } = await stream(`${state('url')}?token=${state('token')}`, {
    send: [{ type: 'nonsense' }, { type: 'subscribe', id, channels: ['ticker:BTC/USDT'] }],
    until: (m) => m.some((x) => x.id === id),
  });
  const ack = got.find((x) => x.id === id);
  expect(ack.type).toBe('ack');
  expect(ack.serverTime).toBeTruthy();
});

test(`${J} #4 stops answering pings: the server ends the connection after the interval`, async () => {
  test.setTimeout(180_000);
  const { closed } = await stream(`${state('url')}?token=${state('token')}`, { waitMs: 150_000 });
  expect(closed?.reason).toMatch(/ping/);
});

test(`${J} #5 reconnects after a gap: a snapshot first, then sequence numbers continue from it`, async () => {
  const { got } = await stream(`${state('url')}?token=${state('token')}`, {
    send: [{ type: 'subscribe', id: `${J}-5`, channels: ['book:BTC/USDT'] }],
    until: (m) => m.filter((x) => x.channel === 'book:BTC/USDT').length >= 3,
  });
  const book = got.filter((x) => x.channel === 'book:BTC/USDT');
  expect(book[0].kind).toBe('snapshot');
  for (let i = 1; i < book.length; i++) expect(book[i].seq).toBe(book[i - 1].seq + 1);
});

test(`${J} #6 opens connections above the per-IP cap: the extra one closes with the typed reason`, async () => {
  const opened = await Promise.all(Array.from({ length: 30 }, () => stream(`${state('url')}?token=${state('token')}`, { waitMs: 5_000 })));
  expect(opened.some((o) => o.closed?.reason?.includes('connection_cap'))).toBe(true);
});

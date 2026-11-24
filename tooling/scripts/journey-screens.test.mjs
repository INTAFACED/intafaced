import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BETA_SCREENS, makeScreens } from './journey-screens.mjs';

/** A page stand-in: its main frame, its URL, and the `framenavigated` and `close` events Playwright sends. */
function fakePage(url = 'about:blank') {
  const page = new EventEmitter();
  const main = { url: () => url };
  let closed = false;
  page.mainFrame = () => main;
  page.url = () => url;
  page.isClosed = () => closed;
  page.go = (next, frame = main) => {
    if (frame === main) url = next;
    page.emit('framenavigated', frame === main ? main : { url: () => next });
  };
  page.close = () => ((closed = true), page.emit('close'));
  return page;
}
const customer = (url) => new URL(url).port === '5173';

test("each test's screens: its main-frame navigations on the customer app, and what open pages showed as it began", () => {
  const screens = makeScreens(customer);
  const page = fakePage();
  screens.watch(page);
  screens.watch(page); // watched once
  page.go('http://127.0.0.1:5173/home'); // before any test: not recorded
  const first = screens.begin();
  page.go('http://127.0.0.1:5173/dex/pools?tab=mine#x');
  page.go('http://127.0.0.1:4000/admin'); // another app
  page.go('http://127.0.0.1:5173/frame-only', { url: () => 'sub' }); // a frame inside the page
  page.go('http://127.0.0.1:5173/dex/pools'); // the same path twice
  assert.deepEqual(screens.end(first), { type: BETA_SCREENS, description: JSON.stringify(['/dex/pools', '/home']) });
  page.go('http://127.0.0.1:5173/trade'); // between tests: not recorded
  const second = screens.begin();
  assert.deepEqual(screens.end(second), { type: BETA_SCREENS, description: JSON.stringify(['/trade']) }, 'the page left open');
  page.close();
  assert.equal(screens.end(screens.begin()), null, 'a closed page shows nothing, and no screens is no annotation');
});

test('a URL that throws is not recorded and never throws', () => {
  const screens = makeScreens(() => {
    throw new Error('bad');
  });
  const page = fakePage();
  screens.watch(page);
  const seen = screens.begin();
  assert.doesNotThrow(() => page.go('http://127.0.0.1:5173/home'));
  assert.equal(screens.end(seen), null);
});

test('a popup seen only after its first navigation records the screen it shows', () => {
  const screens = makeScreens(customer);
  const seen = screens.begin();
  screens.watch(fakePage('http://127.0.0.1:5173/dex/pools'));
  assert.deepEqual(screens.end(seen), { type: BETA_SCREENS, description: JSON.stringify(['/dex/pools']) });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BETA_SCREENS, makeFileContexts, makeScreens } from './journey-screens.mjs';

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

const shown = (...paths) => ({ type: BETA_SCREENS, description: JSON.stringify(paths) });
const A = '/real-app/J-a.pw.mjs';
const B = '/real-app/J-b.pw.mjs';

test("a page another journey file left open never shows in this file's screens (run 11655: J-campaigns-04's pages)", () => {
  const screens = makeScreens(customer);
  screens.enter(A);
  const left = fakePage();
  screens.watch(left, A);
  const inA = screens.begin();
  left.go('http://127.0.0.1:5173/uc/promotion');
  assert.deepEqual(screens.end(inA), shown('/uc/promotion'), 'its own file records it');
  screens.enter(B);
  const own = fakePage();
  screens.watch(own, B);
  const inB = screens.begin();
  left.go('http://127.0.0.1:5173/wallet/venue'); // still open, still moving, never closed by file A
  own.go('http://127.0.0.1:5173/trade/futures');
  assert.deepEqual(screens.end(inB), shown('/trade/futures'), "file A's page is neither a first screen nor a navigation of B");
  assert.deepEqual(screens.end(screens.begin()), shown('/trade/futures'), "B's next step: still only B's own page");
});

test("a page file B's beforeAll opened is B's: every later step that goes on with it records its screen", () => {
  const screens = makeScreens(customer);
  screens.enter(B);
  const shared = fakePage();
  screens.watch(shared, B); // opened in test.beforeAll, before B's first test
  shared.go('http://127.0.0.1:5173/charts');
  const first = screens.begin();
  assert.deepEqual(screens.end(first), shown('/charts'));
  const second = screens.begin();
  shared.go('http://127.0.0.1:5173/charts/desk');
  assert.deepEqual(screens.end(second), shown('/charts', '/charts/desk'));
  assert.deepEqual(screens.end(screens.begin()), shown('/charts/desk'), 'a step that only reads it');
});

test('a page no journey file opened (a worker fixture) records in every file, as before', () => {
  const screens = makeScreens(customer);
  screens.enter(A);
  const worker = fakePage('http://127.0.0.1:5173/home');
  screens.watch(worker);
  screens.enter(B);
  assert.deepEqual(screens.end(screens.begin()), shown('/home'));
});

/** A context stand-in: Playwright's `close` event, and a close that may fail. */
function fakeContext({ fails = false } = {}) {
  const context = new EventEmitter();
  context.closed = false;
  context.close = async () => {
    if (fails) throw new Error('Target page, context or browser has been closed');
    context.closed = true;
    context.emit('close');
  };
  return context;
}

test("file B's first hook closes what file A left open, keeps its own and the worker's, and a failed close is not B's", async () => {
  const contexts = makeFileContexts();
  const leftA = fakeContext();
  const brokenA = fakeContext({ fails: true });
  const closedA = fakeContext();
  const worker = fakeContext();
  contexts.opened(leftA, A);
  contexts.opened(brokenA, A);
  contexts.opened(closedA, A);
  contexts.opened(worker, null);
  await closedA.close(); // A closed this one itself
  assert.equal(contexts.ownerOf(leftA), A);
  assert.equal(contexts.ownerOf(worker), null);
  assert.equal(await contexts.enter(A, (c) => c.close()), 0, "a file's own contexts stay open for all its tests");
  const closing = [];
  const close = (c) => (closing.push(c), c.close());
  assert.equal(await contexts.enter(B, close), 2, 'resolves even though one close throws');
  assert.deepEqual(closing, [leftA, brokenA]);
  assert.equal(leftA.closed, true);
  assert.equal(worker.closed, false, 'a context no file opened is never closed here');
  const ownB = fakeContext();
  contexts.opened(ownB, B); // B's beforeAll page
  assert.equal(await contexts.enter(B, close), 0, "B's next test keeps its beforeAll page");
  assert.equal(ownB.closed, false);
  assert.equal(await contexts.enter(A, close), 1, 'and the file after B closes it');
  assert.equal(await contexts.enter(B, close), 0, 'a closed context is closed once');
});

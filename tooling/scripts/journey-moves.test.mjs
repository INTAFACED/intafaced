import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BETA_MOVES, makeMoves } from './journey-moves.mjs';

const APP = 'http://127.0.0.1:5173';
/**
 * A page stand-in: its main frame, its URL, the `framenavigated` and `close` events Playwright sends, Playwright's typed
 * entries (`goto`, `reload`, `goBack`, `goForward`, each navigating while it runs), and `app(url)`, a navigation the app
 * makes on its own (a click on a link or a button).
 */
function fakePage(url = 'about:blank') {
  const page = new EventEmitter();
  const main = { url: () => url };
  const history = [url];
  let at = 0;
  let closed = false;
  const nav = (next, frame = main) => {
    if (frame === main) url = next;
    page.emit('framenavigated', frame === main ? main : { url: () => next });
  };
  page.mainFrame = () => main;
  page.url = () => url;
  page.isClosed = () => closed;
  page.goto = async (next) => {
    const full = new URL(next, APP).href;
    history.splice(at + 1, Infinity, full);
    at = history.length - 1;
    nav(full);
  };
  page.reload = async () => nav(url);
  page.goBack = async () => nav(history[(at = Math.max(0, at - 1))]);
  page.goForward = async () => nav(history[(at = Math.min(history.length - 1, at + 1))]);
  page.app = (next, frame) => {
    const full = new URL(next, APP).href;
    if (!frame) {
      history.splice(at + 1, Infinity, full);
      at = history.length - 1;
    }
    nav(full, frame);
  };
  page.close = () => ((closed = true), page.emit('close'));
  return page;
}
const customer = (url) => new URL(url).port === '5173';
const moved = (...pairs) => ({ type: BETA_MOVES, description: JSON.stringify(pairs) });

test('known-good: a click from a room the step reached is a move; goto, reload, back and forward are none', async () => {
  const moves = makeMoves(customer);
  const page = fakePage();
  moves.watch(page);
  moves.watch(page); // watched once
  const seen = moves.begin();
  await page.goto('/agents/new');
  page.app('/agents/0f9a7c'); // "Use the service starter"
  page.app('/agents/0f9a7c?tab=limits#x'); // the same path: no move
  page.app('/agents/0f9a7c/', { url: () => 'sub' }); // a frame inside the page
  await page.reload();
  await page.goBack();
  await page.goForward(); // back on the address with a query: judged as typed, so the next plain entry restarts it
  page.app('/agents/'); // no move
  await page.goto('/agents/0f9a7c');
  page.app('/agents/'); // a link back to the list, trailing slash dropped
  assert.deepEqual(moves.end(seen), moved(['/agents/0f9a7c', '/agents'], ['/agents/new', '/agents/0f9a7c']));
});

test('planted fault: a room entered by page.goto is no move, from anywhere', async () => {
  const moves = makeMoves(customer);
  const page = fakePage();
  moves.watch(page);
  const seen = moves.begin();
  await page.goto('/home');
  await page.goto('/unreached'); // typed: never the app's own move
  await page.goto('/agents/0f9a7c');
  assert.equal(moves.end(seen), null);
});

test('a typed query or fragment set its own state: no move counts until the next plain typed entry', async () => {
  const moves = makeMoves(customer);
  const page = fakePage();
  moves.watch(page);
  const seen = moves.begin();
  await page.goto('/agents?open=0f9a7c');
  page.app('/agents/0f9a7c'); // the typed state led here: not a menu's way
  page.app('/agents/0f9a7c/usage');
  await page.goto('/agents#mine');
  page.app('/agents/0f9a7c');
  await page.goto('/agents');
  page.app('/agents?tab=mine'); // a query the app adds as it goes is the app's own
  page.app('/agents/0f9a7c');
  assert.deepEqual(moves.end(seen), moved(['/agents', '/agents/0f9a7c']));
});

test('leaving the app, a closed page and the time between tests make no move; a popup starts from its first screen', async () => {
  const moves = makeMoves(customer);
  const page = fakePage();
  moves.watch(page);
  await page.goto('/home');
  page.app('/money'); // before any test: not recorded
  const seen = moves.begin();
  page.app('http://127.0.0.1:4000/admin'); // another app
  page.app('/support/tickets/7'); // back into the app: where from is unknown
  const popup = fakePage(`${APP}/pay/links/3`);
  moves.watch(popup); // a popup is seen first on its own screen
  popup.app('/pay/links/3/edit'); // and moves from there
  page.close();
  page.app('/support'); // after close: no event Playwright sends, and none recorded
  assert.deepEqual(moves.end(seen), moved(['/pay/links/3', '/pay/links/3/edit']));
  popup.app('/pay'); // between tests
  assert.equal(moves.end(moves.begin()), null);
});

test('a URL that throws is not recorded and never throws', async () => {
  const moves = makeMoves(() => {
    throw new Error('bad');
  });
  const page = fakePage();
  moves.watch(page);
  const seen = moves.begin();
  await assert.doesNotReject(page.goto('/home'));
  assert.doesNotThrow(() => page.app('/money'));
  assert.equal(moves.end(seen), null);
});

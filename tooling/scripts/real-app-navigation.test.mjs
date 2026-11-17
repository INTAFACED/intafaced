// responseAfterNavigation (apps/customer/tests/real-app/navigation.mjs, docs/runbooks/harness-rewrite-plan.md piece 7):
// a response the old page made before the navigation committed is never the one returned, nor one the old page started
// before the navigation that answers after it committed (#8061); the body is read when the response arrives, and the
// listeners are gone afterwards; a reloaded page's read whose body the browser no longer holds is skipped for the page's
// next read (J-wallet-04 #7 on #8634). Run: node tooling/scripts/real-app-navigation.test.mjs
// Before a push: runs from .githooks/pre-push when the push changes a journey file (it takes under a second).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { GONE, responseAfterNavigation } = await import('../../apps/customer/tests/real-app/navigation.mjs');

/**
 * A page whose reload sends its document request (started at 2), answers `before` (the old page's read, started at 1),
 * then commits, then answers `after` (started at 3). With `late`, the old page's read answers only after the commit, and
 * its body is gone, as Chromium drops it. With `newGone`, the new page's first read (started at 3) answers with its body
 * gone, and its next read (started at 4) answers `after`. As Playwright's waitForResponse does, a predicate's promise is
 * awaited before a response is taken.
 */
function fakePage({ before, after, frames = ['main'], late = false, newGone = null }) {
  const ev = new EventEmitter();
  const waiters = [];
  const main = { name: 'main' };
  const other = { name: 'child' };
  const respond = async (r) => {
    for (const w of [...waiters]) {
      let taken;
      try {
        taken = await w.pred(r);
      } catch (err) {
        waiters.splice(waiters.indexOf(w), 1);
        w.reject(err);
        continue;
      }
      if (taken) (waiters.splice(waiters.indexOf(w), 1), w.resolve(r));
    }
  };
  const response = (name, startTime, body, gone = false) => ({
    name,
    url: () => 'http://127.0.0.1:3210/api/bank/trpc/ramps.destinations.list',
    status: () => 200,
    request: () => ({ method: () => 'GET', timing: () => ({ startTime }) }),
    json: async () => {
      if (gone instanceof Error) throw gone;
      if (gone) throw new Error('Response body is not available for a response that was navigated away from.');
      return body;
    },
  });
  const docRequest = { isNavigationRequest: () => true, frame: () => main, timing: () => ({ startTime: 2 }) };
  return {
    page: {
      mainFrame: () => main,
      on: (e, f) => ev.on(e, f),
      off: (e, f) => ev.off(e, f),
      listeners: () => ev.listenerCount('framenavigated') + ev.listenerCount('request'),
      waitForResponse: (pred) => new Promise((resolve, reject) => waiters.push({ pred, resolve, reject })),
      reload: async () => {
        await null;
        ev.emit('request', { isNavigationRequest: () => false, frame: () => main, timing: () => ({ startTime: 1 }) });
        ev.emit('request', docRequest);
        if (!late) await respond(response('old', 1, before));
        for (const f of frames) ev.emit('framenavigated', f === 'main' ? main : other);
        if (late) await respond(response('old', 1, before, true));
        if (newGone) await respond(response('new-gone', 3, null, newGone));
        await respond(response('new', newGone ? 4 : 3, after));
        for (const w of [...waiters]) w.reject(new Error('Timeout 30000ms exceeded while waiting for event "response"'));
        return { request: () => docRequest };
      },
    },
  };
}

const match = (r) => r.request().method() === 'GET' && /ramps\.destinations\.list/.test(r.url());
{
  const { page } = fakePage({ before: { rows: ['old'] }, after: { rows: ['new'] } });
  const { res, doc } = await responseAfterNavigation(page, match);
  assert.deepEqual(res, { status: 200, startedAt: 3, body: { rows: ['new'] } }, "the reloaded page's own read, not the old page's");
  assert.equal(doc.request().timing().startTime, 2);
  assert.equal(page.listeners(), 0, 'the listeners are removed');
}
{
  // #8061: the old page's read answers after the commit, its body gone; it is not matched, so its body is never read.
  const { page } = fakePage({ before: { rows: ['old'] }, after: { rows: ['new'] }, late: true });
  const { res } = await responseAfterNavigation(page, match);
  assert.deepEqual(res, { status: 200, startedAt: 3, body: { rows: ['new'] } }, 'the late old read is not the one read');
  assert.equal(page.listeners(), 0, 'the listeners are removed');
}
{
  // A child frame's navigation is not the page's: the match waits for the main frame.
  const { page } = fakePage({ before: { rows: ['old'] }, after: { rows: ['new'] }, frames: ['child', 'main'] });
  assert.deepEqual((await responseAfterNavigation(page, match)).res.body, { rows: ['new'] });
}
{
  // `navigate` and `read` are the caller's.
  const { page } = fakePage({ before: 'x', after: 'y' });
  const { res } = await responseAfterNavigation(page, match, { navigate: () => page.reload(), read: async (r) => `read ${r.name}` });
  assert.equal(res.body, 'read new');
}
{
  // J-wallet-04 #7 on #8634: the reloaded page's own first read answered with its body gone. It is no answer the test
  // can check, so the page's next read is the one returned.
  const gone = new Error('response.json: Protocol error (Network.getResponseBody): No data found for resource with given identifier');
  assert.ok(GONE.test(gone.message) && GONE.test('No resource with given identifier found'), "the browser's two wordings");
  const { page } = fakePage({ before: { rows: ['old'] }, after: { rows: ['new'] }, newGone: gone });
  const { res } = await responseAfterNavigation(page, match);
  assert.deepEqual(res, { status: 200, startedAt: 4, body: { rows: ['new'] } }, "a gone body is skipped for the page's next read");
  assert.equal(page.listeners(), 0, 'the listeners are removed');
}
{
  // A wait that sees only gone bodies fails with the browser's own error, not a bare timeout.
  const gone = new Error('No data found for resource with given identifier');
  const { page } = fakePage({ before: { rows: ['old'] }, after: { rows: ['new'] }, newGone: gone });
  await assert.rejects(
    responseAfterNavigation(page, (r) => match(r) && r.name !== 'new'),
    (err) => err === gone,
  );
}
{
  // Any other read error is no gone body: it fails at once, and the next read is never taken.
  const broken = new SyntaxError('Unexpected token < in JSON at position 0');
  const { page } = fakePage({ before: { rows: ['old'] }, after: { rows: ['new'] }, newGone: broken });
  await assert.rejects(responseAfterNavigation(page, match), /Unexpected token/);
}
console.log("real-app navigation: a response is read from the page's next navigation only");

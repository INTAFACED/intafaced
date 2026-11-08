// responseAfterNavigation (apps/customer/tests/real-app/navigation.mjs, docs/runbooks/harness-rewrite-plan.md piece 7):
// a response the old page made before the navigation committed is never the one returned, the body is read when the
// response arrives, and the listener is gone afterwards. Run: node tooling/scripts/real-app-navigation.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { responseAfterNavigation } = await import('../../apps/customer/tests/real-app/navigation.mjs');

/** A page whose reload answers `before` (the old page's read), then commits, then answers `after`. */
function fakePage({ before, after, frames = ['main'] }) {
  const ev = new EventEmitter();
  const waiters = [];
  const main = { name: 'main' };
  const other = { name: 'child' };
  const respond = (r) => {
    for (const w of [...waiters]) if (w.pred(r)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(r));
  };
  const response = (name, startTime, body) => ({
    name,
    url: () => 'http://127.0.0.1:3210/api/bank/trpc/ramps.destinations.list',
    status: () => 200,
    request: () => ({ method: () => 'GET', timing: () => ({ startTime }) }),
    json: async () => body,
  });
  return {
    page: {
      mainFrame: () => main,
      on: (e, f) => ev.on(e, f),
      off: (e, f) => ev.off(e, f),
      listeners: () => ev.listenerCount('framenavigated'),
      waitForResponse: (pred) => new Promise((resolve) => waiters.push({ pred, resolve })),
      reload: async () => {
        await null;
        respond(response('old', 1, before));
        for (const f of frames) ev.emit('framenavigated', f === 'main' ? main : other);
        respond(response('new', 3, after));
        return { request: () => ({ timing: () => ({ startTime: 2 }) }) };
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
  assert.equal(page.listeners(), 0, 'the listener is removed');
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
console.log("real-app navigation: a response is read from the page's next navigation only");

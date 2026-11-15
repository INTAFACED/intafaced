// The TEST partner bank's starts survive a svc-bank restart (apps/customer/tests/real-app/partner-start.mjs): every
// testPartner.set and testPartner.fund a journey file made is sent again, in order, after the file restarts svc-bank,
// and before its next request. Failure it prevents: #8392 `0822ed95`, J-bank-01 #3 and #7 read "0 USDT" where 100 was
// paid in, because the restart emptied the TEST partner's in-process book. Every value here is fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beforeRequest, noteResponse, noteStackTool, partnerDue, partnerFile } from '../../apps/customer/tests/real-app/partner-start.mjs';

const EDGE = 'http://127.0.0.1:65530';
const SET = `${EDGE}/api/bank/trpc/testPartner.set`;
const FUND = `${EDGE}/api/bank/trpc/testPartner.fund`;
const LOGIN = `${EDGE}/api/identity/trpc/auth.login`;
const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const post = (token, body) => ({
  method: 'POST',
  headers: { origin: 'http://127.0.0.1:65531', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** A fake partner process: what it holds, emptied by `restart`, and every request it was sent. */
function fakeBank() {
  const sent = [];
  let book = new Map();
  const send = async (url, init) => {
    sent.push({ url, init });
    if (url === LOGIN) return ok({ result: { data: { accessToken: 'fresh-token' } } });
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === FUND) book.set(body.fundId, body.amount);
    if (url === SET) book.set('switches', body);
    return ok({ result: { data: {} } });
  };
  return { sent, send, book: () => book, restart: () => (book = new Map()) };
}

/** A journey's own request, through the wrapper's order: the starts first when due, then the request, then the note. */
async function request(bank, url, init) {
  const due = beforeRequest(bank.send);
  if (due) await due;
  const res = await bank.send(url, init);
  await noteResponse(url, init, res);
  return res;
}

test('a svc-bank restart puts back each start the file made, in order and as the same person, before its next request', async () => {
  const bank = fakeBank();
  partnerFile('J-fake-01.pw.mjs');
  const login = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'a@local-test.invalid' }),
  };
  await request(bank, LOGIN, login);
  await request(bank, SET, post('fresh-token', { custody: 'off' }));
  await request(bank, FUND, post('fresh-token', { fundId: 'jfake-a', assetId: 'USDT', amount: '100' }));
  assert.equal(partnerDue(), false, 'nothing is due before a restart');

  noteStackTool('local-test-stack.mjs', ['restart', 'bank']);
  bank.restart();
  assert.equal(bank.book().size, 0, 'the restart emptied the fake partner');
  assert.equal(partnerDue(), true);
  bank.sent.length = 0;
  await request(bank, `${EDGE}/api/bank/trpc/spaces.list`, { method: 'GET', headers: {} });
  // A fresh sign-in from the same body, then the set and the fund, then the journey's own read.
  assert.deepEqual(
    bank.sent.map((s) => s.url),
    [LOGIN, SET, FUND, `${EDGE}/api/bank/trpc/spaces.list`],
  );
  assert.equal(new Headers(bank.sent[2].init.headers).get('authorization'), 'Bearer fresh-token');
  assert.equal(bank.book().get('jfake-a'), '100', 'the pay-in is back');
  assert.deepEqual(bank.book().get('switches'), { custody: 'off' });
  assert.equal(partnerDue(), false, 'sent once per restart');
});

test('only a restart or start of svc-bank marks the starts due, and a new file starts with none', async () => {
  const bank = fakeBank();
  partnerFile('J-fake-02.pw.mjs');
  await request(bank, FUND, post('t', { fundId: 'jfake-b', assetId: 'USDT', amount: '5' }));
  noteStackTool('local-test-stack.mjs', ['restart', 'trade']);
  noteStackTool('local-test-stack.mjs', ['stop', 'bank']);
  noteStackTool('local-test-stack.mjs', ['start', '--only', 'trade']);
  noteStackTool('local-test-gates.mjs', ['restart', 'bank']);
  assert.equal(partnerDue(), false);
  noteStackTool('local-test-stack.mjs', ['start', '--only', 'bank']);
  assert.equal(partnerDue(), true);
  partnerFile('J-fake-03.pw.mjs');
  assert.equal(partnerDue(), false, "another file's starts are never sent");
  noteStackTool('local-test-stack.mjs', ['restart', 'bank']);
  assert.equal(partnerDue(), false, 'a file that made no start has nothing to put back');
});

test('a start the partner refuses on the way back stops the test in one line that names the fix', async () => {
  partnerFile('J-fake-04.pw.mjs');
  const bank = fakeBank();
  await request(bank, FUND, post('old-token', { fundId: 'jfake-c', assetId: 'USDT', amount: '5' }));
  noteStackTool('local-test-stack.mjs', ['restart', 'bank']);
  const refusing = async () => new Response('{"error":"expired"}', { status: 401 });
  await assert.rejects(
    beforeRequest(refusing),
    /^Error: svc-bank restarted and the TEST partner's start was not put back \(testPartner\.fund -> HTTP 401 .*send testPartner\.set and testPartner\.fund again after the restart$/,
  );
});

test('a refused start, a GET and a non-partner write are never noted', async () => {
  partnerFile('J-fake-05.pw.mjs');
  await noteResponse(FUND, post('t', { fundId: 'x' }), new Response('{}', { status: 412 }));
  await noteResponse(`${EDGE}/api/bank/trpc/spaces.create`, post('t', { name: 'x' }), ok());
  await noteResponse(SET, { method: 'GET' }, ok());
  noteStackTool('local-test-stack.mjs', ['restart', 'bank']);
  assert.equal(partnerDue(), false);
});

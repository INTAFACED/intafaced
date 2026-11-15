// The clause and refusal helpers, version 1 (journey-clauses-v1.mjs; apps/customer/tests/real-app/clauses-v1.mjs).
// Run: node --test tooling/scripts/journey-clauses-v1.test.mjs (also by the tooling-tests Doctrine gate).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkExpectation, clauseTitle, readResponse, refusalProblems, typedCodes } from './journey-clauses-v1.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sha = (rel) =>
  createHash('sha256')
    .update(readFileSync(`${ROOT}/${rel}`))
    .digest('hex');

test('version 1 is frozen: a change goes in a new version, never in these two files', () => {
  assert.equal(sha('tooling/scripts/journey-clauses-v1.mjs'), '206333880b0362351a34d891befbf925be83ee00c085bb38bc8664f7e27f7cdb');
  assert.equal(sha('apps/customer/tests/real-app/clauses-v1.mjs'), 'c93a790cc4055086bf6bf1431087368b2a4eb62d5aea461f4c5e028bd72a4fa7');
});

test('a clause is named in words', () => {
  assert.equal(clauseTitle('  the order shows as resting '), 'clause: the order shows as resting');
  assert.throws(() => clauseTitle(''), TypeError);
  assert.throws(() => clauseTitle('   '), TypeError);
  assert.throws(() => clauseTitle(undefined), TypeError);
});

test('the expectation names an exact refusal status and an exact typed code', () => {
  assert.doesNotThrow(() => checkExpectation({ status: 409, code: 'trade.market_closed' }));
  assert.throws(() => checkExpectation({ status: 200, code: 'trade.market_closed' }), /400 to 599/);
  assert.throws(() => checkExpectation({ code: 'trade.market_closed' }), /status/);
  assert.throws(() => checkExpectation({ status: 409, code: 'FORBIDDEN' }), /typed code/);
  assert.throws(() => checkExpectation({ status: 409 }), /typed code/);
  assert.throws(() => checkExpectation(), TypeError);
});

test('typed codes are found where the services put them, and only typed ones', () => {
  const trpc = { error: { message: 'no', data: { code: 'FORBIDDEN', cause: { code: 'academy.access_code_invalid' } } } };
  assert.deepEqual(typedCodes(trpc), [{ path: 'error.data.cause.code', code: 'academy.access_code_invalid' }]);
  assert.deepEqual(typedCodes({ code: 'bank.address_book_cap_unset' }), [{ path: 'code', code: 'bank.address_book_cap_unset' }]);
  assert.deepEqual(typedCodes({ error: { code: 'agents.request_id_replay' } }), [{ path: 'error.code', code: 'agents.request_id_replay' }]);
  assert.deepEqual(typedCodes(null), []);
  assert.deepEqual(typedCodes('academy.x'), []);
  assert.deepEqual(typedCodes({ error: { data: { code: 'FORBIDDEN' } } }), []);
});

test('the refusal expected passes; every other answer says why it is not', () => {
  const want = { status: 403, code: 'academy.access_code_invalid' };
  const body = { error: { data: { cause: { code: 'academy.access_code_invalid' } } } };
  assert.deepEqual(refusalProblems({ status: 403, body }, want), []);
  assert.deepEqual(refusalProblems({ status: 412, body }, want), ['status 412, expected 403']);
  assert.match(refusalProblems({ status: 200, body: { ok: true } }, want).join('\n'), /status 200, expected 403\nno typed code/);
  assert.deepEqual(refusalProblems({ status: 403, body: { code: 'academy.ip_unreadable' } }, want), [
    'code academy.ip_unreadable (at code), expected academy.access_code_invalid',
  ]);
  assert.match(refusalProblems({ status: 403, body: undefined }, want)[0], /no typed code/);
});

test('a Playwright response, a fetch response and one already read are all read the same way', async () => {
  const body = { code: 'bank.destination_label_taken' };
  const playwright = { status: () => 409, json: async () => body };
  const fetched = new Response(JSON.stringify(body), { status: 409 });
  assert.deepEqual(await readResponse(playwright), { status: 409, body });
  assert.deepEqual(await readResponse(fetched), { status: 409, body });
  assert.deepEqual(await readResponse({ status: 409, body }), { status: 409, body });
  assert.deepEqual(await readResponse(new Response('not json', { status: 502 })), { status: 502, body: null });
  await assert.rejects(readResponse(undefined), TypeError);
});

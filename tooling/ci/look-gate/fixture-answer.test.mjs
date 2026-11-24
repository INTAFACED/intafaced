// The TEST account's typed refusals: a read the account's deployment refuses answers with its own status and code,
// never the gate's generic refusal, so a room that keeps today's read on that refusal draws as it does today.
// Run: node --test tooling/ci/look-gate/fixture-answer.test.mjs (also by the tooling-tests gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAnswer } from './fixture-answer.mjs';

const at = { signedIn: true, now: Date.parse('2026-11-01T00:00:00Z') };

test("the venue's market states answer as the door off: a 404 with trade.user_venue_off", () => {
  const answer = fixtureAnswer('http://x/api/v1/venue/market-states', 'GET', null, at);
  assert.equal(answer?.status, 404);
  assert.equal(answer.json.intafacedCode, 'trade.user_venue_off');
});

test('a refused read is refused only on GET, and a read with no fixture still gets none', () => {
  assert.equal(fixtureAnswer('http://x/api/v1/venue/market-states', 'POST', '{}', at), null);
  assert.equal(fixtureAnswer('http://x/api/v1/venue/no-such-read', 'GET', null, at), null);
});

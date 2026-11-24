// The state files that only hold while the stack's database does (#10352); no stack or database started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { lostAccountFiles, retireAccountFiles } from './local-test-db-state.mjs';

const A = '04f89b80-648e-4f62-8b9b-5631227b493a';
const B = 'bd99de72-4e7a-48ee-9b3b-6b35eb5f8068';
const OP_A = '11111111-2222-4333-8444-555555555555';
const OP_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function stateWith() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-state-'));
  fs.mkdirSync(path.join(dir, 'run'));
  const w = (rel, json) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(json));
  w('founders.json', {
    founders: [
      { handle: 'local_test_founder_a', userId: A },
      { handle: 'local_test_founder_b', userId: B },
    ],
  });
  w('founder-totp-steps.json', { a: 1, b: 2 });
  w('run/identity-founder-pin.json', { nitroUserId: A, phantomUserId: B });
  w('operators.json', { operators: { a: { userId: OP_A }, b: { userId: OP_B } } });
  return dir;
}

test('a database made again after a box restart: the founder vault and its companions move aside, and the stack enrols afresh', () => {
  const dir = stateWith();
  // The beta at 09:01 UTC on 23 Nov: identity held only the two TEST market accounts, none of the founders or operators.
  const lost = lostAccountFiles(dir, new Set(['99999999-0000-4000-8000-000000000000']));
  assert.deepEqual(
    lost.map((e) => e.file),
    ['founders.json', 'operators.json'],
  );
  const moved = retireAccountFiles(dir, lost, { now: new Date('2026-11-23T09:01:49Z') });
  assert.equal(moved.length, 4);
  for (const rel of ['founders.json', 'founder-totp-steps.json', 'run/identity-founder-pin.json', 'operators.json']) {
    assert.equal(fs.existsSync(path.join(dir, rel)), false, `${rel} moved`);
    assert.equal(fs.existsSync(path.join(dir, `${rel}.lost-2026-11-23T09-01-49-000Z`)), true, `${rel} kept beside it`);
  }
});

test('a database that still holds the accounts leaves every file in place', () => {
  const dir = stateWith();
  assert.deepEqual(lostAccountFiles(dir, new Set([A, B, OP_A, OP_B])), []);
});

test('ids are compared without case', () => {
  const dir = stateWith();
  assert.deepEqual(lostAccountFiles(dir, new Set([A, B, OP_A, OP_B].map((x) => x.toLowerCase()))), []);
});

test('a file with one account present and one gone is refused, never moved: enrolling again would collide', () => {
  const dir = stateWith();
  assert.throws(() => lostAccountFiles(dir, new Set([A, OP_A, OP_B])), /founders\.json names 2 accounts and identity holds only 1/);
});

test('a vault not yet enrolled (no ids) or missing is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-state-'));
  fs.writeFileSync(path.join(dir, 'founders.json'), JSON.stringify({ founders: [{ userId: null }, { userId: null }] }));
  assert.deepEqual(lostAccountFiles(dir, new Set()), []);
});

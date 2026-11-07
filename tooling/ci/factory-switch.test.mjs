// The planted cases of the factory switch (factory-switch.mjs): only `run` passes; `pause`, blank, other text and any
// unreadable answer fail closed. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeSwitch, readSwitch } from './factory-switch.mjs';

test('run passes, with or without a trailing newline', () => {
  assert.equal(judgeSwitch('run').pass, true);
  assert.equal(judgeSwitch('run\n').pass, true);
});

test('pause, blank and any other text fail', () => {
  for (const t of ['pause', 'pause\n', '', '   ', 'Run', 'RUN', 'running', 'run\npause', 'paused', undefined, null]) {
    assert.equal(judgeSwitch(t).pass, false, JSON.stringify(t));
  }
  assert.match(judgeSwitch('pause\n').why, /says "pause", not "run"/);
  assert.doesNotMatch(judgeSwitch('pause\n::warning::x').why, /\n/);
});

test('reads the raw file on the factory-switch branch', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => 'run\n' };
  };
  assert.equal(await readSwitch({ repo: 'o/r', token: 't', fetchImpl }), 'run\n');
  assert.equal(seen.url, 'https://api.github.com/repos/o/r/contents/FACTORY?ref=factory-switch');
  assert.equal(seen.init.headers.accept, 'application/vnd.github.raw');
});

test('a missing branch or file, or any refusal, throws so the seal fails closed', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const fetchImpl = async () => ({ ok: false, status, text: async () => 'run' });
    await assert.rejects(readSwitch({ repo: 'o/r', token: 't', fetchImpl }), new RegExp(`HTTP ${status}`));
  }
});

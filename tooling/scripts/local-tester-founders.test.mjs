/**
 * Unit tests for local-tester-founders (the tester compose stack's founder step): what it refuses before it reaches any
 * stack. No stack, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enrol } from './local-tester-founders.mjs';

const folder = (marker) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-founders-'));
  if (marker) fs.writeFileSync(path.join(dir, 'LOCAL-TEST-STACK.json'), JSON.stringify(marker));
  return dir;
};

test('a relative state folder, or one with no marker, refuses', async () => {
  await assert.rejects(enrol({ stateDir: 'relative/state', log: () => {} }), /absolute path/);
  await assert.rejects(enrol({ stateDir: folder(null), log: () => {} }), /no stack marker/);
});

test('a `pnpm local:stack` marker refuses: that stack enrols its own pair', async () => {
  const dir = folder({ kind: 'intafaced-local-test-stack', repo: '/repo', ports: { edge: 14500 } });
  await assert.rejects(enrol({ stateDir: dir, log: () => {} }), /`pnpm local:stack` enrols its own founder pair/);
  assert.equal(fs.existsSync(path.join(dir, 'founders.json')), false);
});

test('a compose marker whose database does not answer with its stack id refuses before any vault is written', async () => {
  const dir = folder({
    kind: 'intafaced-local-test-stack',
    runtime: 'compose',
    stackId: 'd'.repeat(32),
    ports: { postgres: 9, edge: 9, identity: 9 },
    database: { host: '127.0.0.1', port: 9, name: 'intafaced' },
  });
  await assert.rejects(enrol({ stateDir: dir, log: () => {} }), /not this compose stack/);
  assert.equal(fs.existsSync(path.join(dir, 'founders.json')), false);
});

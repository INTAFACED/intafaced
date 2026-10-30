/**
 * `.env.tester` holds LOCAL TEST values for the compose tester profile only (J-home-ia-11 #1). These checks keep it that
 * way: it names exactly the values .env.example leaves blank on purpose, under its never-a-live-value header, and
 * .env.example keeps them blank, so a real deployment still refuses to start without its own (compose `${VAR:?}`, pinned
 * by services/svc-edge/src/rate-limit-compose-flags-pin.test.ts).
 * Run: node --test tooling/scripts/env-tester.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pairs = (file) =>
  readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.split(/=(.*)/s).slice(0, 2));
const TESTER_KEYS = ['EDGE_RATE_LIMIT_MAX', 'EDGE_RATE_LIMIT_WINDOW_MS', 'LITELLM_MASTER_KEY', 'LITELLM_CONFIG_PATH'];

test('.env.tester names only the tester profile values, under its LOCAL TEST header', () => {
  const text = readFileSync(path.join(ROOT, '.env.tester'), 'utf8');
  assert.equal(text.split('\n')[0], '# LOCAL TEST values for the tester profile only; never a live value.');
  assert.deepEqual(Object.fromEntries(pairs('.env.tester')), {
    EDGE_RATE_LIMIT_MAX: '6000',
    EDGE_RATE_LIMIT_WINDOW_MS: '60000',
    LITELLM_MASTER_KEY: 'placeholder-not-a-key-tester-profile',
    LITELLM_CONFIG_PATH: '/dev/null',
  });
});

test('.env.example keeps every one of them blank', () => {
  const example = Object.fromEntries(pairs('.env.example'));
  for (const key of TESTER_KEYS) assert.equal(example[key], '', `${key} must stay blank in .env.example`);
});

test('the tester edge budget is the one the local stack runs on', () => {
  const edge = readFileSync(path.join(ROOT, 'tooling/scripts/local-stack-services/edge.mjs'), 'utf8');
  assert.match(edge, /EDGE_RATE_LIMIT_MAX: '6000'/);
  assert.match(edge, /EDGE_RATE_LIMIT_WINDOW_MS: '60000'/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./validate-env.mjs', import.meta.url));
const validate = (teamUrl) => spawnSync(process.execPath, [script], {
  env: { ...process.env, VITE_TEAM_URL: teamUrl }, encoding: 'utf8',
});

test('production deployment refuses a remote HTTP team desk origin', () => {
  const result = validate('http://team.invalid');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VITE_TEAM_URL.*HTTPS/);
});

test('team deployment is optional and accepts an explicit HTTPS desk base', () => {
  assert.equal(validate('').status, 0);
  assert.match(validate('').stdout, /unavailable/);
  assert.equal(validate('https://team.invalid/desk').status, 0);
});

test('team deployment refuses credentials and ambiguous URL suffixes', () => {
  for (const url of ['https://name:secret@team.invalid', 'https://team.invalid?tenant=x', 'https://team.invalid#ops', 'invalid']) {
    assert.equal(validate(url).status, 1, url);
  }
});

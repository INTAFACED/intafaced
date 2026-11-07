import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DROPPED, leaks, redact, redactDir, secretValues } from './redact-stack-logs.mjs';

const env = { INTAFACED_SANCTIONS_REGIONS: 'XX,YY', INTAFACED_SANCTIONS_LIST_SOURCE: 'planted "source" value' };
const secretsJson = { jwt: { key: 'generated-signing-key-123' }, founders: [{ password: 'founder-pass-456' }], short: 'abc' };

test('a sanctions line is dropped, whatever it holds', () => {
  const text = 'boot\n{"msg":"sanctions screening: TEST","declaration":"unplanted"}\nready';
  assert.equal(redact(text, []), `boot\n${DROPPED}\nready`);
});

test('a secret value elsewhere is masked, as written and JSON-escaped; short secrets.json strings are not values', () => {
  const values = secretValues({ env, secretsJson });
  assert.ok(values.includes('XX,YY') && values.includes('planted \\"source\\" value') && !values.includes('abc'));
  const text = 'a XX,YY b\n{"v":"planted \\"source\\" value"}\nkey generated-signing-key-123 and founder-pass-456 abc';
  const out = redact(text, values);
  assert.equal(out, 'a *** b\n{"v":"***"}\nkey *** and *** abc');
  assert.equal(leaks(out, values), false);
});

test('no secrets set masks nothing and keeps the log', () => {
  assert.deepEqual(secretValues({ env: {} }), []);
  assert.equal(redact('plain line', []), 'plain line');
});

test('a file in which a value can still be found is left out (fails closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'edge.log'), 'sanctions: XX,YY\nother XX,YY\n');
  fs.writeFileSync(path.join(dir, 'logs', 'identity.log'), 'fine\n');
  const values = secretValues({ env });
  // A planted fault: masking that drops the sanctions lines but misses the value elsewhere. The leak check leaves it out.
  const dropsOnly = (text) => text.replace(/^.*sanction.*$/gim, DROPPED);
  assert.deepEqual(redactDir(path.join(dir, 'logs'), path.join(dir, 'broken'), values, dropsOnly), {
    kept: ['identity.log'],
    left: ['edge.log'],
    missing: false,
  });
  assert.equal(fs.existsSync(path.join(dir, 'broken', 'edge.log')), false);
  // The real redaction masks it, so both are kept and neither holds a value.
  assert.deepEqual(redactDir(path.join(dir, 'logs'), path.join(dir, 'out'), values), {
    kept: ['edge.log', 'identity.log'],
    left: [],
    missing: false,
  });
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'edge.log'), 'utf8'), `${DROPPED}\nother ***\n`);
});

test('the command line reads the environment and secrets.json, and a missing logs dir keeps nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-cli-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'bank.log'), 'pass founder-pass-456, list XX,YY\n');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secretsJson));
  const script = path.join(import.meta.dirname, 'redact-stack-logs.mjs');
  const out = execFileSync(
    process.execPath,
    [script, path.join(dir, 'logs'), path.join(dir, 'out'), '--secrets', path.join(dir, 'secrets.json')],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  assert.match(out, /kept 1 log/);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'bank.log'), 'utf8'), 'pass ***, list ***\n');
  const none = execFileSync(process.execPath, [script, path.join(dir, 'nope'), path.join(dir, 'out2')], { encoding: 'utf8' });
  assert.match(none, /no logs at/);
  assert.equal(fs.existsSync(path.join(dir, 'out2')), false);
});

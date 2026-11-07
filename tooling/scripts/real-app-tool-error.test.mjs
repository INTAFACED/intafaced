// The error a real-app journey's stack tool throws (apps/customer/tests/real-app/stack.mjs `toolError`): only the
// allow-listed lines of its output, masked and cut, and nothing else of it anywhere on the error (#7463, review round 1).
// Every value here is fake.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';
import { shownOutput, toolError } from '../../apps/customer/tests/real-app/stack.mjs';

// A fake generated secret (64 hex, as the stack generates them), a short fake one, and a fake log value.
const LONG = 'f'.repeat(16) + '0123456789abcdef'.repeat(3);
const SHORT = 'plantedShort9';
const LOGGED = 'PLANTED-LOG-VALUE';
const FAKES = [LONG, SHORT, LOGGED, LONG.slice(0, 24), LONG.slice(-24)];

/** Every text an error carries: its own properties (hidden ones too), its stack, its causes, and how it prints. */
function everything(error) {
  const parts = [util.inspect(error, { showHidden: true, depth: Infinity, breakLength: Infinity })];
  for (let e = error; e; e = e.cause) {
    parts.push(String(e.message), String(e.stack));
    for (const key of Reflect.ownKeys(e)) parts.push(util.inspect(e[key], { depth: Infinity }));
  }
  return parts.join('\n');
}

const carriesNone = (text) => FAKES.filter((f) => text.includes(f));

test('status lines, health-table rows and typed refusals are shown; anything else is withheld and counted', () => {
  const out = [
    '  matching: stopped',
    'INTAFACED local test stack',
    "  founders: a's email address is confirmed",
    '  host dispatch (TEST): app http://127.0.0.1:3210 served',
    '  SERVICE          PORT        PID     HEALTH',
    '  svc-identity     14502       5688    down (no answer on /health)',
    'refusing [seed.app_env_not_local]: APP_ENV is "staging"',
    'test market: ok (TEST)',
    `{"level":30,"msg":"boot","value":"${LOGGED}"}`,
    'Error: something broke',
    '    at run (file.mjs:1:1)',
  ].join('\n');
  const shown = shownOutput(out);
  assert.equal(shown.lines, 8);
  assert.equal(shown.withheld, 3);
  assert.match(shown.text, /^ {2}matching: stopped$/m);
  assert.match(shown.text, /svc-identity +14502 +5688 +down/);
  assert.match(shown.text, /^refusing \[seed\.app_env_not_local\]/m);
  assert.ok(shown.text.startsWith('  matching: stopped'));
  assert.deepEqual(carriesNone(shown.text), []);
});

test('a status line keeps its shape with opaque runs masked, a credential line is withheld, and lines are cut to 160', () => {
  const shown = shownOutput([`  chain: seeded with key ${LONG}`, `  admin: password: ${SHORT}`, `  build: ${'x '.repeat(120)}`].join('\n'));
  assert.equal(shown.lines, 2);
  assert.equal(shown.withheld, 1);
  assert.match(shown.text, /^ {2}chain: seeded with key \[withheld\]$/m);
  assert.ok(shown.text.split('\n').every((l) => l.length <= 161));
  assert.deepEqual(carriesNone(shown.text), []);
});

test('planted fault: a failing restart whose service log tail holds a value shows the header only, and its status lines', () => {
  const raw = Object.assign(new Error(`Command failed: node local-test-stack.mjs restart identity\nedge exited during start`), {
    status: 1,
    stdout: '  identity: stopped\n  postgres, nats: already running\n',
    stderr: [
      'edge exited during start. Log /state/logs/edge.log:',
      `{"level":30,"msg":"configured","source":"${LOGGED}"}`,
      `  value: ${SHORT}`,
      `${LONG}`,
    ].join('\n'),
  });
  const error = toolError(raw, 'local-test-stack.mjs', ['restart', 'identity']);
  assert.match(error.message, /^tool local-test-stack\.mjs restart identity exit 1$/m);
  assert.match(error.message, /identity: stopped/);
  assert.match(error.message, /postgres, nats: already running/);
  assert.match(error.message, /^ {4}edge exited during start$/m);
  assert.match(error.message, /its stderr \(1 line\(s\) shown, 3 withheld\)/);
  assert.deepEqual(carriesNone(everything(error)), []);
});

test('the error tool() throws for a real failed command carries none of a secret its stderr held: message, stdout, stderr, stack, causes', () => {
  // A real command that fails as a stack tool can: status lines on stdout, then a value on stderr in every shape.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-error-'));
  const script = path.join(dir, 'planted-tool.mjs');
  fs.writeFileSync(
    script,
    [
      `console.log('  identity: stopped');`,
      `console.log('test market: ok (TEST)');`,
      `console.error('  admin: token ${LONG}');`,
      `console.error('password: ${SHORT}');`,
      `console.error(JSON.stringify({ value: '${LOGGED}' }));`,
      `console.error(new Error('${LOGGED} ${SHORT}').stack);`,
      `process.exit(3);`,
    ].join('\n'),
  );
  let raw;
  try {
    execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    raw = e;
  }
  // Node's own error carries every fake value: in its message (stderr appended) and in its stderr and output.
  assert.ok(raw && carriesNone(everything(raw)).length === FAKES.length, 'the planted command must leak through Node');
  const error = toolError(raw, 'planted-tool.mjs', []);
  assert.equal(error.status, 3);
  assert.equal(error.cause, undefined);
  assert.equal(error.stdout, '  identity: stopped\ntest market: ok (TEST)');
  assert.match(error.stderr, /^ {2}admin: token \[withheld\]$/);
  assert.deepEqual(carriesNone(everything(error)), []);
  // What a test report gets from a thrown error: Playwright serializes `message`, `stack` and its causes (all above),
  // and a `String(err.stdout ?? '')` reader still finds the status line it parses first.
  assert.match(String(error.stdout ?? ''), /^test market: /m);
});

test('a timeout says spawnSync … ETIMEDOUT, as a runner error is read, and keeps the shown lines', () => {
  const raw = Object.assign(new Error(`spawnSync ${process.execPath} ETIMEDOUT`), {
    code: 'ETIMEDOUT',
    status: null,
    signal: 'SIGTERM',
    stdout: '  svc-identity: starting (founder pin restart)\n',
    stderr: `stuck ${LONG}\n`,
  });
  const error = toolError(raw, 'local-test-stack.mjs', ['restart', 'identity']);
  assert.match(error.message, /timed out after 120 s \(spawnSync .* ETIMEDOUT\)/);
  assert.match(error.message, /svc-identity: starting \(founder pin restart\)/);
  assert.equal(error.code, 'ETIMEDOUT');
  assert.deepEqual(carriesNone(everything(error)), []);
});

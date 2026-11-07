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
import { assertStackUp, restartChecked, shownOutput, toolError } from '../../apps/customer/tests/real-app/stack.mjs';

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

/** Stand-ins for a restart: a clock that moves 2 s per pause, no real sleep, and a mark file of the test's own. */
function standIns(check) {
  let t = 0;
  const markFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-down-')), 'run', 'journey-stack-down.json');
  return { check, now: () => t, pause: (ms) => (t += ms), markFile };
}

test('the health wait: a restart that returns while the service stays down fails by name and marks the stack down', () => {
  const calls = [];
  const s = standIns((names) => (calls.push(names), names.filter((n) => n === 'identity')));
  assert.throws(
    () => restartChecked(['restart', 'identity'], { ...s, exec: () => '  identity: stopped\n' }),
    /^Error: stack: identity not healthy after `restart identity` \(120 s of the 120 s cap\)/,
  );
  // The check ran until the cap, not once: 2 s apart over 120 s.
  assert.equal(calls.length, 61);
  const mark = JSON.parse(fs.readFileSync(s.markFile, 'utf8'));
  assert.deepEqual(mark.services, ['identity']);
  assert.match(mark.why, /the restart returned, but the health check never read ok/);
  // ...and the next file fails at once, naming it.
  assert.throws(() => assertStackUp({ markFile: s.markFile, check: (n) => n }), /^Error: stack: identity down since /);
});

test('the health wait: a service that comes back within the cap passes, and leaves no mark', () => {
  let reads = 0;
  const s = standIns((names) => (++reads < 3 ? names : []));
  assert.equal(restartChecked(['restart', 'identity'], { ...s, exec: () => 'restarted\n' }), 'restarted\n');
  assert.equal(fs.existsSync(s.markFile), false);
});

test('a stack-down mark that is corrupt or names no service reads as down; no mark reads as up; a healthy stack clears it', () => {
  const { markFile } = standIns();
  fs.mkdirSync(path.dirname(markFile), { recursive: true });
  const healthy = () => [];
  assert.equal(assertStackUp({ markFile, check: healthy }), undefined);
  for (const corrupt of ['{"services": ["identity"', 'not json', '{"services": []}', '{"services": "identity"}', 'null']) {
    fs.writeFileSync(markFile, corrupt);
    assert.throws(() => assertStackUp({ markFile, check: healthy }), /reads as down/, `mark ${JSON.stringify(corrupt)}`);
    assert.equal(fs.existsSync(markFile), true);
  }
  fs.writeFileSync(markFile, JSON.stringify({ services: ['identity'], at: 'then', restart: 'restart identity', why: 'w' }));
  assert.throws(() => assertStackUp({ markFile, check: (n) => n }), /^Error: stack: identity down since then/);
  assert.equal(assertStackUp({ markFile, check: healthy }), undefined);
  assert.equal(fs.existsSync(markFile), false);
});

test("scoped-session's stdout (a TEST session's cookies) is never shown, even when it fails", () => {
  const raw = Object.assign(new Error('Command failed'), {
    status: 1,
    stdout: `{"cookies":[{"name":"session","value":"${SHORT}"}]}\n  console: session ${LONG}\n`,
    stderr: 'refusing [gates.scope_unknown]: no such scope\n',
  });
  const error = toolError(raw, 'local-test-gates.mjs', ['scoped-session', '--without', 'admin:read']);
  assert.equal(error.stdout, '');
  assert.match(error.message, /its stdout \(0 line\(s\) shown, 2 withheld\)/);
  assert.match(error.stderr, /^refusing \[gates\.scope_unknown\]/);
  assert.deepEqual(carriesNone(everything(error)), []);
});

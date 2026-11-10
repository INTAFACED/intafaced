import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explain, answerOf, classify, resetOf, RETRY_ACTION, SIGN_IN_ACTION } from './reviewer-error.mjs';

test('a json answer that is an error names its fields and text', () => {
  const a = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'limit reached' });
  assert.equal(explain(a, 1), 'the reviewer CLI exited 1; subtype="success"; is_error=true; api_error_status=429; result: limit reached');
});

test("a stream's last result line is the one read", () => {
  const s = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key' }),
  ].join('\n');
  assert.equal(answerOf(s).result, 'Invalid API key');
  assert.match(explain(s, 1), /is_error=true; result: Invalid API key$/);
});

test('no answer and non-JSON output are both named', () => {
  assert.equal(explain('', 1), 'the reviewer CLI exited 1 and wrote no answer');
  assert.equal(explain('error: unknown option --x\n', 2), 'the reviewer CLI exited 2; its output, not JSON: error: unknown option --x');
});

test('a key-shaped string is masked in an error text', () => {
  const a = JSON.stringify({ is_error: true, api_error_status: 401, result: 'Invalid bearer sk-ant-oat01-AbC_123-x' });
  const line = explain(a, 1);
  assert.ok(!line.includes('AbC_123'));
  assert.match(line, /result: Invalid bearer sk-ant-\*\*\*$/);
});

test('the command prints one ::error:: line from the file, and a missing file is no answer', () => {
  const d = mkdtempSync(join(tmpdir(), 'rev-err-'));
  const f = join(d, 'answer.json');
  writeFileSync(f, JSON.stringify({ is_error: true, result: 'overloaded' }));
  const script = new URL('./reviewer-error.mjs', import.meta.url).pathname;
  // An overload is the judge down, not the change: a warning with its one action, never a red annotation.
  assert.equal(
    execFileSync('node', [script, f, '1'], { encoding: 'utf8' }),
    `::warning::judge down (a limit or an overload): the reviewer CLI exited 1; is_error=true; result: overloaded. One action: ${RETRY_ACTION}\n`,
  );
  writeFileSync(f, JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'x' }));
  assert.equal(
    execFileSync('node', [script, f, '1'], { encoding: 'utf8' }),
    '::error::the reviewer CLI exited 1; subtype="error_max_structured_output_retries"; is_error=true; result: 1 characters, not printed\n',
  );
  assert.equal(
    execFileSync('node', [script, join(d, 'none.json'), '1'], { encoding: 'utf8' }),
    '::warning::judge down (no answer): the reviewer CLI exited 1 and wrote no answer. One action: none, retried on the next push\n',
  );
});

test("text that doesn't read as an error is not printed, because it could repeat the prompt's private step words", () => {
  const a = JSON.stringify({
    type: 'result',
    subtype: 'error_max_structured_output_retries',
    is_error: true,
    result: 'Step 3 says the learner sees their own lines',
  });
  const line = explain(a, 1);
  assert.ok(!line.includes('learner'));
  assert.match(line, /result: 44 characters, not printed$/);
  const long = JSON.stringify({ is_error: true, result: `rate ${'z'.repeat(400)}` });
  assert.match(explain(long, 1), /not printed$/);
});

// The real answers, as the reviewer CLI wrote them. The weekly limit is the one every review got from about 04:39 UTC
// on 10 Nov (runs 42784559009, 42784111207, 42783846637); the rest are the CLI's auth, overload and network shapes.
const NOW = new Date('2026-11-10T11:00:00Z');
const WEEKLY = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  result: "You've hit your weekly limit · resets Nov 14, 10am (UTC)",
};
const EXPIRED = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 401,
  result:
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
};
const kindOf = (o, code = 1) => classify(typeof o === 'string' ? o : JSON.stringify(o), code, NOW);

test('down: the weekly limit waits for its reset, named in Bali time', () => {
  const c = kindOf(WEEKLY);
  assert.equal(c.kind, 'down');
  assert.equal(c.signIn, false);
  assert.equal(c.action, 'wait for the reset at Nov 14, 18:00 Bali time (Nov 14, 10am UTC)');
  assert.equal(resetOf('resets 3pm (UTC)', NOW), 'Nov 10, 23:00 Bali time (3pm UTC)');
  assert.equal(resetOf('resets soon', NOW), 'soon', 'words it cannot read as a UTC time are kept as said');
  assert.equal(resetOf('limit reached', NOW), null);
});

test('down: a refused, expired or used-up key needs a sign-in or a new key', () => {
  for (const a of [
    EXPIRED,
    { type: 'result', is_error: true, result: 'Invalid API key · Please run /login' },
    { type: 'result', is_error: true, api_error_status: 403, result: 'API Error: 403 forbidden' },
    { type: 'result', is_error: true, result: 'Credit balance is too low' },
  ]) {
    const c = kindOf(a);
    assert.equal(c.kind, 'down', a.result);
    assert.equal(c.action, SIGN_IN_ACTION, a.result);
    assert.equal(c.signIn, true, a.result);
  }
  // A stream's result line reads the same.
  const s = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify(EXPIRED)].join('\n');
  assert.equal(classify(s, 1, NOW).signIn, true);
});

test('down: an overload, a rate limit, a network error, a timeout or no answer is retried on the next push', () => {
  for (const [a, code] of [
    [
      {
        type: 'result',
        is_error: true,
        api_error_status: 529,
        result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      },
      1,
    ],
    [{ type: 'result', is_error: true, api_error_status: 429, result: 'Rate limited' }, 1],
    [{ type: 'result', is_error: true, result: 'API Error: Request timed out.' }, 1],
    [{ type: 'result', is_error: true, result: 'API Error: Connection error.' }, 1],
    ['', 1],
    ['', 143],
    ['Error: getaddrinfo ENOTFOUND api.example.com', 1],
  ]) {
    const c = kindOf(a, code);
    assert.equal(c.kind, 'down', JSON.stringify(a));
    assert.equal(c.action, RETRY_ACTION, JSON.stringify(a));
    assert.equal(c.signIn, false);
  }
});

test("error: a malformed answer, a bad flag, a too-large prompt, or the model's own words stay red", () => {
  for (const a of [
    { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'Step 3 says the token expired' },
    { type: 'result', subtype: 'success', is_error: false, result: 'The login screen times out; PASS' },
    { type: 'result', is_error: true, api_error_status: 400, result: 'prompt is too long' },
    { type: 'result', is_error: true, api_error_status: 413, result: 'request too large' },
    'error: unknown option --x',
    '{"type":"result","is_error":true,"result":"' + 'z'.repeat(400) + ' expired"}',
  ])
    assert.equal(kindOf(a).kind, 'error', JSON.stringify(a).slice(0, 80));
});

test('--kind prints the kind alone, and --outputs writes kind, action, line and sign_in for the next steps', () => {
  const d = mkdtempSync(join(tmpdir(), 'rev-kind-'));
  const f = join(d, 'answer.json');
  const out = join(d, 'out');
  const script = new URL('./reviewer-error.mjs', import.meta.url).pathname;
  writeFileSync(f, JSON.stringify(EXPIRED));
  assert.equal(execFileSync('node', [script, f, '1', '--kind'], { encoding: 'utf8' }), 'down\n');
  writeFileSync(out, '');
  execFileSync('node', [script, f, '1', '--outputs'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  const got = Object.fromEntries(
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  assert.equal(got.kind, 'down');
  assert.equal(got.action, SIGN_IN_ACTION);
  assert.equal(got.sign_in, 'true');
  assert.match(got.line, /^the reviewer CLI exited 1; subtype="success"; is_error=true; api_error_status=401; result: /);
  writeFileSync(f, JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'x' }));
  assert.equal(execFileSync('node', [script, f, '1', '--kind'], { encoding: 'utf8' }), 'error\n');
});

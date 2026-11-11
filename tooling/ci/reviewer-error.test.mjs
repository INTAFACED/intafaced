import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explain, answerOf, classify, otherKey, resetOf, RETRY_ACTION, SIGN_IN_ACTION } from './reviewer-error.mjs';

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
    '::error::the reviewer CLI exited 1 and wrote no answer\n',
    'no answer and no stderr is not an outage the CLI named: red, as before the judge-down rule',
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
const kindOf = (o, code = 1, err = '') => classify(typeof o === 'string' ? o : JSON.stringify(o), code, NOW, err);

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
  for (const [a, err] of [
    [EXPIRED, ''],
    [{ type: 'result', is_error: true, api_error_status: 403, result: 'API Error: 403 forbidden' }, ''],
    [{ type: 'result', is_error: true, api_error_status: 400, result: 'Credit balance is too low' }, ''],
    // No status: stderr is the evidence.
    [{ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }, 'Invalid API key · Please run /login\n'],
    ['', 'Error: OAuth token has expired. Please run /login\n'],
  ]) {
    const c = kindOf(a, 1, err);
    assert.equal(c.kind, 'down', a.result);
    assert.equal(c.action, SIGN_IN_ACTION, a.result);
    assert.equal(c.signIn, true, a.result);
  }
  // A stream's result line reads the same.
  const s = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify(EXPIRED)].join('\n');
  assert.equal(classify(s, 1, NOW).signIn, true);
});

test('down: an overload, a rate limit, a network error, a timeout or no answer is retried on the next push', () => {
  for (const [a, code, err = ''] of [
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
    ['', 1, 'Error: connect ECONNREFUSED 10.0.0.1:443'],
    ['', 143, 'API Error: Request timed out.'],
    ['', 1, 'API Error: 429 rate limit exceeded'],
    ['Error: getaddrinfo ENOTFOUND api.example.com', 1],
  ]) {
    const c = kindOf(a, code, err);
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
    // Key and limit words with no status the API sent and nothing on stderr: text the model could shape, never down.
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your weekly limit · resets Nov 14, 10am (UTC)",
    },
    { type: 'result', is_error: true, result: 'Invalid API key · Please run /login' },
    { type: 'result', is_error: true, result: 'Credit balance is too low' },
    { type: 'result', is_error: true, result: 'Rate limited, too many requests' },
  ])
    assert.equal(kindOf(a).kind, 'error', JSON.stringify(a).slice(0, 80));
});

test("error: no answer is red unless stderr names an outage, so a CLI crash on the change's own input never hides as down", () => {
  for (const [code, err] of [
    [1, ''],
    [143, ''],
    [137, ''],
    [124, ''],
    [1, 'TypeError: Cannot read properties of undefined (reading "map")\n    at parse (cli.js:1:2)'],
    [1, 'SyntaxError: Unexpected token in JSON at position 4'],
  ])
    assert.equal(kindOf('', code, err).kind, 'error', `${code} ${err}`);
});

test('stderr: only its first error-shaped line is printed, keys masked; other stderr is never printed', () => {
  const key = 'sk-ant-oat01-' + 'Q'.repeat(40);
  const line = explain('', 1, `starting up\nError: Invalid API key ${key}\nmore`);
  assert.equal(line, 'the reviewer CLI exited 1 and wrote no answer; stderr: Error: Invalid API key sk-ant-***');
  assert.equal(explain('', 1, 'Step 3 of J-bank-13 says hello\n'), 'the reviewer CLI exited 1 and wrote no answer');
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
  // An empty answer reads the stderr file beside it.
  writeFileSync(f, '');
  assert.equal(execFileSync('node', [script, f, '1', '--kind'], { encoding: 'utf8' }), 'error\n');
  writeFileSync(`${f}.stderr`, 'Error: getaddrinfo ENOTFOUND api.example.com\n');
  assert.equal(execFileSync('node', [script, f, '1', '--kind'], { encoding: 'utf8' }), 'down\n');
});

test("a well-formed answer that isn't an error stays the review's own: stderr naming a 429 never makes it judge down", () => {
  const fail = { type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: FAIL\n1. a real finding' };
  assert.equal(kindOf(fail, 1, 'Error: 429 rate_limit_error: retrying\n').kind, 'error');
  // The same stderr beside an error answer is still read.
  assert.equal(kindOf({ ...fail, is_error: true, result: 'x' }, 1, 'Error: 429 rate_limit_error\n').kind, 'down');
});

/**
 * The second key (project-state#2180), run as the workflow runs it: each reviewer step's own script from ci-review.yml,
 * under bash -e with pipefail, with a planted CLI that answers by the key in its environment. Proves the first key's
 * usage refusal is asked again on CLAUDE_CODE_OAUTH_TOKEN_2, a refusal about the change is not, the call never holds
 * both keys, and with no second key set the step behaves as before.
 */
const WF_TEXT = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');
const stepRun = (name) => {
  const at = WF_TEXT.indexOf(`      - name: ${name}\n`);
  const from = WF_TEXT.indexOf('        run: |\n', at) + '        run: |\n'.length;
  const end = WF_TEXT.indexOf('\n\n', from);
  return WF_TEXT.slice(from, end)
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n');
};
const LIMIT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  result: "API Error: 429 You've hit your weekly limit · resets Nov 13, 10am (UTC)",
};
const ANSWER = { type: 'result', subtype: 'success', is_error: false, structured_output: { verdict: 'PASS', findings: [] } };
// A failure that is not the key's: the call ran out of structured-output retries on the change's own input.
const CHANGE = { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'x' };

/** Runs a step's script with a planted CLI; `plan` maps a key to the answer that key gets. */
function runStep(name, { keys, plan, edit = (s) => s }) {
  const root = mkdtempSync(join(tmpdir(), 'rev-key-'));
  const temp = join(root, 'temp');
  const bin = join(temp, 'reviewer', 'node_modules', '.bin');
  execFileSync('mkdir', ['-p', bin, join(temp, 'review')]);
  const log = join(root, 'calls.log');
  // The planted CLI: logs which key it holds and whether any second key reached it, then answers by the key.
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env bash\ncat > /dev/null\necho "$CLAUDE_CODE_OAUTH_TOKEN second-in-env:\${CLAUDE_CODE_OAUTH_TOKEN_2:+yes}" >> ${JSON.stringify(log)}\n` +
      `case "$CLAUDE_CODE_OAUTH_TOKEN" in\n${Object.entries(plan)
        .map(([k, a]) => `  ${k}) echo '${JSON.stringify(a).replace(/'/g, "'\\''")}'; exit ${a.is_error ? 1 : 0};;`)
        .join('\n')}\nesac\nexit 9\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(temp, 'review', 'schema.json'), '{}');
  writeFileSync(join(temp, 'review', 'prompt.txt'), 'p');
  const out = join(root, 'out');
  writeFileSync(out, '');
  const script = edit(stepRun(name));
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: temp,
        GITHUB_WORKSPACE: new URL('../..', import.meta.url).pathname.replace(/\/$/, ''),
        GITHUB_OUTPUT: out,
        GH_TOKEN: 'x',
        HEAD_SHA: 'abc',
        READER_MODEL: 'm',
        READER_EFFORT: 'e',
        ...keys,
      },
    });
  } catch (e) {
    code = e.status;
    stdout = String(e.stdout);
  }
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return { code, stdout, calls: read(log).trim().split('\n').filter(Boolean), outputs: read(out) };
}
// The read of the answer is ci-review.mjs's, tested elsewhere: here it only shows the step reached it.
const reviewEdit = (s) => s.replaceAll('node "$GITHUB_WORKSPACE/tooling/ci/ci-review.mjs" read "$dir"', 'echo READ-ANSWER');

test('the Review step: a usage refusal on the first key is asked again on the second, and the record says so', () => {
  const r = runStep('Review', {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1', CLAUDE_CODE_OAUTH_TOKEN_2: 'k2' },
    plan: { k1: LIMIT, k2: ANSWER },
    edit: reviewEdit,
  });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.calls, ['k1 second-in-env:', 'k2 second-in-env:'], 'key 1, then key 2; no call ever holds the second key beside it');
  assert.match(r.stdout, /READ-ANSWER/);
  assert.match(r.stdout, /reviewer key: second/);
  assert.match(r.outputs, /^key=second$/m);
  assert.match(r.outputs, /^first_line=.*weekly limit/m);
  assert.doesNotMatch(r.outputs, /^kind=down/m, "the first key's refusal leaves no judge-down output once the second answered");
  assert.ok(!/k1|k2/.test(r.stdout.replace(/second-in-env/g, '')), 'no key in the log');
});

test('the Review step: a refusal about the change is never retried on the second key', () => {
  const r = runStep('Review', {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1', CLAUDE_CODE_OAUTH_TOKEN_2: 'k2' },
    plan: { k1: CHANGE, k2: ANSWER },
    edit: reviewEdit,
  });
  assert.equal(r.code, 1, 'red, as before');
  assert.deepEqual(r.calls, ['k1 second-in-env:']);
  assert.doesNotMatch(r.stdout, /READ-ANSWER/);
});

test('the Review step: with no second key, a usage refusal is the judge down as before, after one call', () => {
  const r = runStep('Review', { keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1' }, plan: { k1: LIMIT }, edit: reviewEdit });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, ['k1 second-in-env:']);
  assert.match(r.outputs, /^kind=down$/m);
  assert.doesNotMatch(r.outputs, /^key=/m);
  // And with both keys used up: two calls, then the judge down.
  const both = runStep('Review', {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1', CLAUDE_CODE_OAUTH_TOKEN_2: 'k2' },
    plan: { k1: LIMIT, k2: LIMIT },
    edit: reviewEdit,
  });
  assert.equal(both.code, 0);
  assert.deepEqual(both.calls, ['k1 second-in-env:', 'k2 second-in-env:']);
  assert.match(both.outputs, /^kind=down$/m);
  // A first key that answers: one call, on the first key.
  const ok = runStep('Review', {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1', CLAUDE_CODE_OAUTH_TOKEN_2: 'k2' },
    plan: { k1: ANSWER },
    edit: reviewEdit,
  });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.calls, ['k1 second-in-env:']);
  assert.match(ok.outputs, /^key=first$/m);
});

// The proof read's input and answer reads are step-read.mjs's, tested elsewhere: here two prompts and a stub read.
const readEdit = (s) =>
  s
    .replace(
      'node "$GITHUB_WORKSPACE/tooling/ci/step-read.mjs" prepare "$dir"',
      'mkdir -p "$dir/second" && for x in "$dir" "$dir/second"; do echo p > "$x/prompt.txt"; echo "{}" > "$x/schema.json"; done',
    )
    .replace('gh api ', 'echo 0 || gh api ')
    .replace('node "$GITHUB_WORKSPACE/tooling/ci/step-read.mjs" read "$dir"', 'echo READ-ANSWER');

test('the proof read: both calls go to the second key on a usage refusal; a refusal about the change is not retried', () => {
  const r = runStep('Read the steps (proof v2)', {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1', CLAUDE_CODE_OAUTH_TOKEN_2: 'k2' },
    plan: { k1: LIMIT, k2: ANSWER },
    edit: readEdit,
  });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.calls.sort(), ['k1 second-in-env:', 'k1 second-in-env:', 'k2 second-in-env:', 'k2 second-in-env:']);
  assert.match(r.stdout, /READ-ANSWER/);
  assert.match(r.stdout, /reviewer key: second/);
  const change = runStep('Read the steps (proof v2)', {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1', CLAUDE_CODE_OAUTH_TOKEN_2: 'k2' },
    plan: { k1: CHANGE, k2: ANSWER },
    edit: readEdit,
  });
  assert.deepEqual(change.calls, ['k1 second-in-env:', 'k1 second-in-env:']);
  assert.match(change.stdout, /no proof read of this head: a reader call failed/);
  const none = runStep('Read the steps (proof v2)', { keys: { CLAUDE_CODE_OAUTH_TOKEN: 'k1' }, plan: { k1: LIMIT }, edit: readEdit });
  assert.deepEqual(none.calls, ['k1 second-in-env:', 'k1 second-in-env:']);
  assert.match(none.stdout, /no proof read of this head: a reader call failed/);
});

test("--key says `other` only for the key's own refusals", () => {
  const now = new Date('2026-11-11T16:00:00Z');
  assert.equal(otherKey(classify(JSON.stringify(LIMIT), 1, now)), true);
  assert.equal(otherKey(classify(JSON.stringify({ is_error: true, api_error_status: 401, result: 'Invalid bearer token' }), 1, now)), true);
  assert.equal(otherKey(classify(JSON.stringify({ is_error: true, api_error_status: 529, result: 'Overloaded' }), 1, now)), false);
  assert.equal(otherKey(classify(JSON.stringify(CHANGE), 1, now)), false);
  // The model's own text naming a limit is never the key's refusal.
  assert.equal(otherKey(classify(JSON.stringify({ is_error: true, result: "You've hit your weekly limit" }), 1, now)), false);
  assert.equal(otherKey(classify('', 1, now)), false);
});

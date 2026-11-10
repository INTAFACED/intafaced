import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explain, answerOf } from './reviewer-error.mjs';

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
  assert.equal(
    execFileSync('node', [script, f, '1'], { encoding: 'utf8' }),
    '::error::the reviewer CLI exited 1; is_error=true; result: overloaded\n',
  );
  assert.equal(
    execFileSync('node', [script, join(d, 'none.json'), '1'], { encoding: 'utf8' }),
    '::error::the reviewer CLI exited 1 and wrote no answer\n',
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

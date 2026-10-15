import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const path = new URL('../../.github/workflows/ci.yml', import.meta.url);
const present = existsSync(path);
const workflow = present ? readFileSync(path, 'utf8') : '';
test('normal CI test jobs use GitHub merge-result checkout, never raw PR-head pinning', { skip: !present }, () => {
  for (const scope of ['full', 'protocol', 'money', 'trade', 'paybank']) {
    const block = workflow.match(new RegExp('^  test-' + scope + ':\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:)', 'm'))?.[1];
    assert.ok(block, scope);
    const checkout = block.match(/- uses: actions\/checkout@[^\n]+\n((?: +[^\n]*\n)*?)(?= *- uses:| *- (?:run|name|id):|\n)/)?.[1] ?? '';
    assert.doesNotMatch(checkout, /ref:/, scope + ' must use the default pull_request merge ref');
  }
});
test('each selected shard runs the infrastructure execution backstop even after a test failure', { skip: !present }, () => {
  for (const scope of ['protocol', 'money', 'trade', 'paybank']) {
    const job = workflow.match(new RegExp('^  test-' + scope + ':\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:)', 'm'))?.[1];
    assert.ok(job, scope);
    assert.match(
      job,
      /name: Every infrastructure-backed suite actually ran\n        if: always\(\)\n        run: node tooling\/ci\/infra-verdict\.mjs/,
    );
  }
});

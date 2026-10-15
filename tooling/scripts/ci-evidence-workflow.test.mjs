import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const path = new URL('../../.github/workflows/ci.yml', import.meta.url);
const present = existsSync(path);
const workflow = present ? readFileSync(path, 'utf8') : '';
test('CI tests exact PR head instead of a synthetic merge at every checkout', { skip: !present }, () => {
  const checkouts = [...workflow.matchAll(/- uses: actions\/checkout@[^\n]+\n((?: +[^\n]*\n)*?)(?= *- uses:| *- (?:run|name|id):|\n)/g)];
  assert.ok(checkouts.length >= 9);
  for (const checkout of checkouts) assert.match(checkout[1], /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.doesNotMatch(workflow, /evidence_ref|CI_EVIDENCE_SCOPE/);
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

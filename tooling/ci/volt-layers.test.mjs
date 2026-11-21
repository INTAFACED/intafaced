// A pull request into a Volt layer branch (`volt/<template>`) runs CI's fast checks and nothing heavier; the layer's
// pull request into main is judged as any other (project-state, Volt layers, 22 Nov).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const wf = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const trigger = (text, event) => /^on:\n([\s\S]*?)\n(?=\S)/m.exec(text)?.[1].split(/\n(?=  \S)/).find((b) => b.startsWith(`  ${event}:`)) ?? '';

test('a pull request into volt/* runs no journeys and starts no seal', () => {
  assert.match(trigger(wf('real-app-journeys.yml'), 'pull_request'), /branches-ignore: \['volt\/\*\*'\]/);
  const start = /\n  seal-start:\n[\s\S]*?\n    if: (.*)\n/.exec(wf('ci.yml'))?.[1] ?? '';
  assert.match(start, /!startsWith\(github\.base_ref, 'volt\/'\)/);
});

test("a pull request into volt/* still runs CI's fast checks: CI runs on every base", () => {
  const ci = trigger(wf('ci.yml'), 'pull_request');
  assert.ok(ci, 'ci.yml runs on pull requests');
  assert.doesNotMatch(ci, /branches(-ignore)?:/);
});

test("the layer's pull request into main keeps main's judges: the CI review and the merge seal run on every pull request into main", () => {
  for (const name of ['ci-review.yml', 'merge-seal.yml']) {
    const t = trigger(wf(name), 'pull_request_target');
    assert.match(t, /branches: \[main\]/, name);
    assert.doesNotMatch(t, /volt/, name);
  }
  assert.doesNotMatch(trigger(wf('real-app-journeys.yml'), 'pull_request'), /branches: /, 'journeys run on pull requests into main');
});

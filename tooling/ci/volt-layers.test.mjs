// A pull request into a Volt layer branch (`volt/<template>`) runs CI's fast checks and nothing heavier; the layer's
// pull request into main is judged as any other (project-state, Volt layers, 22 Nov).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const wf = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const trigger = (text, event) =>
  /^on:\n([\s\S]*?)\n(?=\S)/m
    .exec(text)?.[1]
    .split(/\n(?=  \S)/)
    .find((b) => b.startsWith(`  ${event}:`)) ?? '';

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

// Doctrine gates' first step, run as CI runs it, in a scratch repository (project-state#2548).
test('a pull request into volt/* that carries main commits its layer lacks is refused; a batch on the layer and a pull request into main are judged', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const step = /\n      - name: Judge on main as it is now\n[\s\S]*?\n        run: \|\n([\s\S]*?)\n      - /.exec(wf('ci.yml'))?.[1];
  assert.ok(step, "ci.yml has the step 'Judge on main as it is now'");
  const script = step.replace(/^ {10}/gm, '');
  const dir = mkdtempSync(join(tmpdir(), 'volt-sync-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, work);
  const commit = (msg) => git(work, 'commit', '-q', '--allow-empty', '-m', msg);
  commit('main 1');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/volt/x');
  commit('main 2');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const main = git(work, 'rev-parse', 'HEAD');
  // The pull request's head, then GitHub's merge commit of it onto its base, which CI checks out.
  const judge = (headSha, base) => {
    git(work, 'checkout', '-q', '--detach', `origin/${base}`);
    git(work, 'merge', '-q', '--no-ff', '--no-edit', headSha);
    try {
      return { ok: true, out: execFileSync('bash', ['-e', '-c', script], { cwd: work, env: { ...env, GITHUB_BASE_REF: base }, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      return { ok: false, out: `${e.stdout}${e.stderr}` };
    }
  };
  git(work, 'fetch', '-q', 'origin');
  // A sync pull request into the layer: main merged into it, to be squashed.
  git(work, 'checkout', '-q', '-B', 'sync', 'origin/volt/x');
  git(work, 'merge', '-q', '--no-ff', '--no-edit', main);
  const sync = judge(git(work, 'rev-parse', 'sync'), 'volt/x');
  assert.equal(sync.ok, false, sync.out);
  assert.match(sync.out, /carries main commits volt\/x lacks.*push the merge of main to volt\/x directly/);
  // The layer synced by a merge pushed to it; a batch on it is judged.
  git(work, 'push', '-q', 'origin', 'sync:refs/heads/volt/x');
  git(work, 'fetch', '-q', 'origin');
  git(work, 'checkout', '-q', '-B', 'batch', 'origin/volt/x');
  commit('batch');
  const batch = judge(git(work, 'rev-parse', 'batch'), 'volt/x');
  assert.equal(batch.ok, true, batch.out);
  assert.match(batch.out, /judging .* merged onto main/);
  const intoMain = judge(git(work, 'rev-parse', 'batch'), 'main');
  assert.equal(intoMain.ok, true, intoMain.out);
});

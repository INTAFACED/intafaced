// Each Claude call ci-review.yml makes leaves one usage line, uploaded as `claude-usage-<job>-<attempt>`: a runner keeps
// no transcript, so project-state's cost read (tooling/board/cost.mjs CI_JOBS) had none of these calls (24 Nov 2026).
// The workflow's own usage() and ask() functions run here under bash -e, as Actions runs them, with a stand-in CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const wf = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');
function job(name) {
  const at = wf.indexOf(`\n  ${name}:\n`);
  const m = /\n {2}[a-z-]+:\n/g;
  m.lastIndex = at + 2;
  m.exec(wf);
  const n = m.exec(wf);
  return wf.slice(at, n ? n.index : wf.length);
}
/** Each `ask() {` function in a text, through its closing brace at the same indentation. */
const asks = (text) => [...text.matchAll(/^( *)ask\(\) \{\n[\s\S]*?\n\1\}\n/gm)].map((m) => m[0]);
const USAGE = /^ *usage\(\) \{.*\}$/m;

test('every reviewer call in both jobs appends its usage line and keeps its exit code; both jobs upload them by the name the cost read lists', () => {
  for (const [name, artifact] of [
    ['review', 'claude-usage-review-'],
    ['read', 'claude-usage-read-'],
  ]) {
    const j = job(name);
    assert.ok(j, name);
    const fns = asks(j);
    assert.ok(fns.length >= 1, `${name}: its ask() functions`);
    for (const f of fns) {
      assert.match(f, /node_modules\/\.bin\/claude" -p/);
      assert.match(
        f,
        / 2> "\$(?:dir|1|d)\/answer\.jsonl?\.stderr" \|\| rc=\$\?\n\s+usage "\$(?:dir|1|d)\/answer\.jsonl?"\n\s+return "\$rc"\n/,
        `${name}: ${f.slice(0, 200)}`,
      );
      assert.match(f, /local rc=0\n/);
    }
    assert.equal((j.match(/node_modules\/\.bin\/claude" -p/g) ?? []).length, fns.length, `${name}: no reviewer call outside an ask()`);
    assert.match(j, USAGE, `${name}: usage() is defined in the calling step`);
    assert.match(
      j,
      /USAGE_WORK: \$\{\{ github\.event\.pull_request\.head\.ref \}\} \$\{\{ github\.event\.pull_request\.title \}\}\n/,
      'the PR is named through env, never in the script',
    );
    const up = j.slice(j.indexOf("- name: Upload the calls' usage"));
    assert.match(
      up,
      new RegExp(
        `^- name: Upload the calls' usage\\n\\s+if: \\$\\{\\{ always\\(\\) \\}\\}\\n\\s+continue-on-error: true\\n\\s+uses: actions/upload-artifact@[0-9a-f]{40} # v[\\d.]+\\n\\s+with:\\n\\s+name: ${artifact}\\$\\{\\{ github\\.run_attempt \\}\\}\\n\\s+path: \\$\\{\\{ runner\\.temp \\}\\}/claude-usage\\.jsonl\\n`,
      ),
      `${name}'s upload step`,
    );
  }
});

const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage: { speed: 'standard' },
  modelUsage: {
    'claude-opus-5-5': {
      inputTokens: 2,
      outputTokens: 65,
      cacheReadInputTokens: 3474,
      cacheCreationInputTokens: 6151,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 6151,
      costUSD: 0.04,
    },
  },
};

test("the read job's ask(), run: a failed call still leaves its line, and its exit code reaches the caller, in the background too", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-usage-'));
  try {
    const runner = join(tmp, 'runner'),
      d = join(tmp, 'd');
    mkdirSync(join(runner, 'reviewer/node_modules/.bin'), { recursive: true });
    mkdirSync(d);
    writeFileSync(join(d, 'schema.json'), '{}');
    writeFileSync(join(d, 'prompt.txt'), 'x');
    const cli = join(runner, 'reviewer/node_modules/.bin/claude');
    writeFileSync(cli, `#!/usr/bin/env bash\necho '${JSON.stringify(RESULT)}'\nexit "$EXIT"\n`);
    chmodSync(cli, 0o755);
    const j = job('read');
    const script = `${USAGE.exec(j)[0]}\n${asks(j)[0]}\nask "${d}" && echo "fg=0" || echo "fg=$?"\nask "${d}" & wait "$!" && echo "bg=0" || echo "bg=$?"\n`;
    const run = (exit) =>
      spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: runner,
          GITHUB_WORKSPACE: tmp,
          EXIT: String(exit),
          USAGE_WORK: 'j/J-bank-06 bank: J-bank-06 #5',
        },
      });
    let r = run(3);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fg=3\nbg=3\n/);
    r = run(0);
    assert.match(r.stdout, /fg=0\nbg=0\n/);
    const lines = readFileSync(join(runner, 'claude-usage.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 4, 'one line a call, failed or answered');
    for (const l of lines) {
      assert.deepEqual(Object.keys(l), ['at', 'work', 'speed', 'models']);
      assert.match(l.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.equal(l.work, 'j/J-bank-06 bank: J-bank-06 #5');
      assert.deepEqual(l.models, RESULT.modelUsage);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('usage() on a stream-json answer keeps its one result line, and on a missing answer writes nothing and fails nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-usage-'));
  try {
    const f = join(tmp, 'answer.jsonl');
    writeFileSync(
      f,
      `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'assistant', message: {} })}\n${JSON.stringify(RESULT)}\n`,
    );
    const r = spawnSync('bash', ['-e', '-c', `${USAGE.exec(job('review'))[0]}\nusage "${f}"\nusage "${tmp}/none.json"\necho ok`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: tmp, USAGE_WORK: 'w' },
    });
    assert.match(r.stdout, /^ok\n$/, r.stderr);
    const lines = readFileSync(join(tmp, 'claude-usage.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).models['claude-opus-5-5'].cacheCreationEphemeral1hInputTokens, 6151);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

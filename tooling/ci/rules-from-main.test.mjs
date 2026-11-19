/**
 * A workflow step that runs main's copy of a script runs it from a worktree of main (`git worktree add --detach <dir>
 * origin/main`), never from single files copied out with `git show origin/main:<file> > ...`.
 *
 * Why (INTAFACED/project-state#2284): the Test-diff guard copied test-diff-guard.mjs and a hand-kept list of its imports
 * out of main. A run whose workflow file predates the merge that added an import (#8166 added exact-revert.mjs) still
 * copied the old list from the newer main, and the guard died with ERR_MODULE_NOT_FOUND: the most frequent first cause
 * of a lost push in the Doctrine gates job on 12 and 13 Nov 2026 (#8147, #8143 and more). A worktree takes the script
 * and every import from the same commit, so there is no list to keep. Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';
// `git show <ref>:<path to code>` written to a file: a script taken from another commit without its imports.
const COPY = /git\s+show\s+["']?[^\s"':]*:[^\s"']+\.(?:[cm]?js|ts)["']?\s*>/;
// A `git show` that names its file through a shell variable (`origin/main:tooling/ci/$f`) copies code the same way.
const COPY_VAR = /git\s+show\s+["']?[^\s"':]*:[^\s"']*\$[^\s"']*["']?\s*>/;

/** The lines of a workflow's text that copy a script out of another commit. */
export function copiesOutOfMain(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((l) => !l.text.startsWith('#') && (COPY.test(l.text) || COPY_VAR.test(l.text)));
}

test("no workflow copies a script out of main one file at a time; main's rules run from a worktree of main", () => {
  const found = [];
  for (const name of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    for (const l of copiesOutOfMain(readFileSync(join(DIR, name), 'utf8'))) found.push(`${DIR}/${name}:${l.line}: ${l.text}`);
  }
  assert.deepEqual(
    found,
    [],
    `run main's copy from \`git worktree add --detach "$RUNNER_TEMP/<dir>" origin/main\` instead:\n${found.join('\n')}`,
  );
});

test("the Test-diff guard and Look drift take main's copy from a worktree of main", () => {
  const ci = readFileSync(join(DIR, 'ci.yml'), 'utf8');
  for (const step of ['Test-diff guard (rules from main)', 'Look drift (rules from main)']) {
    const at = ci.indexOf(`name: ${step}`);
    assert.ok(at > 0, `ci.yml has no step "${step}"`);
    const body = ci.slice(at, ci.indexOf('\n      - ', at + 1));
    assert.match(
      body,
      /git worktree add --detach "\$RUNNER_TEMP\/[\w-]+" origin\/main/,
      `${step} runs main's copy from a worktree of main`,
    );
  }
});

test('fails (planted): the step that lost pushes on 12 and 13 Nov 2026, and its look-drift twin', () => {
  const lost = [
    'for f in test-diff-guard.mjs look-baselines.mjs judged-paths.mjs; do',
    '  if git cat-file -e "origin/main:tooling/ci/$f" 2>/dev/null; then',
    '    git show "origin/main:tooling/ci/$f" > "$RUNNER_TEMP/$f"',
    '  fi',
    'done',
  ].join('\n');
  assert.equal(copiesOutOfMain(lost).length, 1);
  assert.equal(copiesOutOfMain('git show origin/main:tooling/ci/look-drift.mjs > "$RUNNER_TEMP/look-drift.mjs"').length, 1);
  assert.equal(copiesOutOfMain("git show 'origin/main:tooling/ci/x.ts' >out.ts").length, 1);
});

test('passes: a worktree of main, a comment, and a data file read from main', () => {
  assert.deepEqual(copiesOutOfMain('git worktree add --detach "$RUNNER_TEMP/diff-rules" origin/main'), []);
  assert.deepEqual(copiesOutOfMain('# git show origin/main:tooling/ci/x.mjs > y.mjs was the old way'), []);
  assert.deepEqual(copiesOutOfMain('git show origin/main:docs/roadmap/journeys.json > "$RUNNER_TEMP/journeys.json"'), []);
});

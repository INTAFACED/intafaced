// Every INTAFACED thread runs Opus (owner decision 56), subagents included. A subagent definition under
// .claude/agents/ that names another model would run on it whenever a builder starts it without a model:
// on 6 Nov 2026 an Explore subagent ran on Haiku this way. This keeps every definition on Opus, or inheriting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, '.claude/agents');

/** The `model:` value in a definition's front matter, or null when it has none (it then inherits the caller's). */
export function frontMatterModel(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => /^model:/.test(l));
  return line ? line.slice('model:'.length).trim() : null;
}

/** True when a model setting keeps the subagent on Opus: the alias, a full Opus model id, or no setting at all. */
export const isOpus = (model) => model === null || model === 'inherit' || /(^|-)opus(-|$)/.test(model);

test('every subagent definition runs Opus or inherits', () => {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.md')) : [];
  for (const f of files) {
    const model = frontMatterModel(readFileSync(join(DIR, f), 'utf8'));
    assert.ok(isOpus(model), `.claude/agents/${f} names model "${model}"; INTAFACED threads run Opus (owner decision 56)`);
  }
});

test('the check refuses a planted non-Opus model and accepts Opus or none', () => {
  assert.equal(isOpus(frontMatterModel('---\nname: X\nmodel: haiku\n---\nbody')), false);
  assert.equal(isOpus(frontMatterModel('---\nname: X\nmodel: sonnet\n---\nbody')), false);
  assert.equal(isOpus(frontMatterModel('---\nname: X\nmodel: opus\n---\nbody')), true);
  assert.equal(isOpus(frontMatterModel('---\nname: X\nmodel: opus-5-5\n---\nbody')), true);
  assert.equal(isOpus(frontMatterModel('---\nname: X\nmodel: opusx\n---\nbody')), false);
  assert.equal(isOpus(frontMatterModel('---\nname: X\n---\nbody')), true);
});

#!/usr/bin/env node
/**
 * Local agent-rule drift check. Called from .githooks/pre-push.
 * Not a GitHub workflow. Exit 1 with a plain message. No dependencies.
 *
 *   node tooling/scripts/truth-check.mjs [--root dir]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENTRY = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'tooling/agent-protocol/AGENT_PROTOCOL.md'];
const EXACT_STALE = ['Merge when done', 'may merge their own'];
const INSTRUCTED = ['worktree remove --force', 'pnpm wt:rm', 'wt:gc:apply'];
const CORE = ['packages/ledger-client', '403 or 429', 'Never bypass', 'git worktree remove'];
const PROHIBIT = /\b(never|do not|don't|must not|cannot|can't)\b/i;

function read(root, rel) {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function entryFiles(root) {
  const files = ENTRY.filter((rel) => existsSync(join(root, rel)));
  const dir = join(root, '.cursor/rules');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) if (name.endsWith('.mdc')) files.push(`.cursor/rules/${name}`);
  }
  return files;
}

/** Vue on a line is history when that line says so. Otherwise it is the current front end. */
function vueIsCurrent(text) {
  return text.split('\n').some((line) => /\bvue\b/i.test(line) && !/history/i.test(line));
}

function instructed(line, phrase) {
  return line.includes(phrase) && !PROHIBIT.test(line);
}

function staleHits(text) {
  const hits = [];
  for (const phrase of EXACT_STALE) if (text.includes(phrase)) hits.push(phrase);
  for (const line of text.split('\n')) {
    for (const phrase of INSTRUCTED) if (instructed(line, phrase)) hits.push(phrase);
    if (vueIsCurrent(line)) hits.push('Vue as the current front end');
  }
  return hits;
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
}

function addedPaths(root) {
  const base = git(root, ['merge-base', 'HEAD', 'origin/main']);
  if (base.status !== 0) return [];
  const diff = git(root, ['diff', '--name-only', '--diff-filter=A', `${base.stdout.trim()}`, 'HEAD']);
  if (diff.status !== 0) return [];
  return diff.stdout.split('\n').filter(Boolean);
}

function evaluate(root) {
  const messages = [];
  for (const rel of entryFiles(root)) {
    for (const hit of staleHits(read(root, rel) ?? '')) messages.push(`stale agent rule in ${rel}: ${hit}`);
  }
  const agents = read(root, 'AGENTS.md');
  if (agents == null) messages.push('AGENTS.md lost a core rule: file missing');
  else for (const phrase of CORE) if (!agents.includes(phrase)) messages.push(`AGENTS.md lost a core rule: ${phrase}`);
  const readme = read(root, 'docs/README.md') ?? '';
  for (const rel of addedPaths(root)) {
    if (rel.startsWith('docs/archive/')) {
      messages.push(`archive only receives moves: ${rel} was added`);
      continue;
    }
    const atRoot = /^[^/]+\.md$/.test(rel);
    const inDocs = /^docs\/[^/]+\.md$/.test(rel);
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if ((atRoot || inDocs) && !readme.includes(base)) messages.push(`new markdown is not listed in docs/README.md: ${rel}`);
  }
  return [...new Set(messages)];
}

const rootFlag = process.argv.indexOf('--root');
const root = rootFlag === -1 ? process.cwd() : process.argv[rootFlag + 1];
if (!root) {
  console.error('truth-check: --root needs a directory');
  process.exit(1);
}
const messages = evaluate(root);
if (messages.length) {
  for (const message of messages) console.error(message);
  process.exit(1);
}

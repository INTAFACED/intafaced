#!/usr/bin/env node
/**
 * Local agent-rule drift check. Called from .githooks/pre-push.
 * Not a GitHub workflow. Exit 1 with a plain message. No dependencies.
 *
 *   node tooling/scripts/truth-check.mjs [--root dir]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ENTRY = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'tooling/agent-protocol/AGENT_PROTOCOL.md'];
const EXACT_STALE = ['Merge when done', 'may merge their own'];
const INSTRUCTED = ['worktree remove --force', 'pnpm wt:rm', 'wt:gc:apply'];
/** Paraphrases of "agents merge their own work". Excused only by a negation just before them in the same sentence, like INSTRUCTED. */
const SELF_MERGE = [
  [/\bmerge (?:your|their|my|his|her|its|our) own\b/i, 'merge your own PR'],
  [/\bmay merge\b/i, 'may merge'],
  [/\bmerge it yourself\b/i, 'merge it yourself'],
  [/\bmerge on green\b/i, 'merge on green'],
  [/\bself-merge\b/i, 'self-merge'],
];
const CORE = ['packages/ledger-client', '403 or 429', 'Never bypass', 'git worktree remove'];
const NEGATION = /\b(never|don't|do not|not|forbidden|no)\b/i;
const VUE_HISTORY = /histor(y|ical)|retired|legacy|archived|\bnot\b|\bnever\b|\bno\b/i;
/** The words that can excuse a phrase: the same sentence, after any colon that is not a Never/Forbidden lead-in, at most 6 words back. */
function excusingWords(line, found) {
  let clause = line
    .slice(0, found)
    .split(/[.;?!]\s/)
    .pop();
  const colon = clause.search(/:\s(?!.*:\s)/);
  if (colon !== -1 && !/\b(never|forbidden)\b\W*$/i.test(clause.slice(0, colon))) clause = clause.slice(colon + 1);
  return clause.split(/\s+/).filter(Boolean).slice(-6).join(' ');
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
/** Files whose markdown links must resolve. */
const LINK_FILES = ['AGENTS.md', 'docs/ARCHITECTURE.md'];
/** Under docs/, current truth: ARCHITECTURE.md and these folders. Everything else is history and must carry a banner. */
const DOCS_CURRENT_DIRS = ['docs/archive/', 'docs/adr/', 'docs/runbooks/', 'docs/refs/'];
/** A banner is a blockquote line in the first 15 lines whose first words say the file is not current. */
const BANNER = /^>\s*(\*\*)?\s*(not current|superseded|historical|stale snapshot|retired)/i;

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

/** A forbidden command is excused only by a negation before it on its line, or a Forbidden/Never heading or lead-in above it. */
function staleHits(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const phrase of EXACT_STALE) if (lower.includes(phrase.toLowerCase())) hits.push([phrase, 0]);
  let forbiddenContext = false;
  text.split('\n').forEach((line, index) => {
    const at = index + 1;
    const lowerLine = line.toLowerCase();
    for (const phrase of INSTRUCTED) {
      const found = lowerLine.indexOf(phrase.toLowerCase());
      if (found !== -1 && !forbiddenContext && !NEGATION.test(excusingWords(line, found))) hits.push([phrase, at]);
    }
    for (const [pattern, label] of SELF_MERGE) {
      const found = line.search(pattern);
      if (found !== -1 && !forbiddenContext && !NEGATION.test(excusingWords(line, found))) hits.push([label, at]);
    }
    if (/\bvue\b/i.test(line) && !VUE_HISTORY.test(line)) hits.push(['Vue as the current front end', at]);
    const leadIn = /^\s*#/.test(line) || line.trimEnd().endsWith(':');
    if (leadIn) forbiddenContext = /forbidden|never/i.test(line);
    else if (line.trim() && !LIST_ITEM.test(line)) forbiddenContext = false;
  });
  return hits.map(([phrase, at]) => (at ? `${phrase} (line ${at})` : phrase));
}

/** Relative targets of [text](target) links, with anchors and queries removed. Fenced code and inline code are skipped. */
function localLinks(text) {
  const found = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const plain = line.replace(/`[^`]*`/g, '');
    for (const match of plain.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
      const target = match[1].split('#')[0].split('?')[0];
      if (target && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) found.push([target, index + 1]);
    }
  });
  return found;
}

function deadLinks(root, rel) {
  const text = read(root, rel);
  if (text == null) return [];
  return localLinks(text)
    .filter(([target]) => !existsSync(join(root, dirname(rel), decodeURI(target))))
    .map(([target, at]) => `dead link in ${rel} (line ${at}): ${target}`);
}

/** Markdown under docs/ that is neither current truth nor archived. */
function docsFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!DOCS_CURRENT_DIRS.includes(`${rel}/`)) walk(rel);
      } else if (entry.name.endsWith('.md') && rel !== 'docs/ARCHITECTURE.md') out.push(rel);
    }
  };
  if (existsSync(join(root, 'docs'))) walk('docs');
  return out;
}

function hasBanner(text) {
  return text.split('\n', 15).some((line) => BANNER.test(line.trim()));
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
}

function lines(result) {
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

/** Files changed in this push (committed since the merge-base, plus uncommitted). null = no merge-base: check everything. */
function changedPaths(root, base) {
  if (!base) return null;
  return new Set([
    ...lines(git(root, ['diff', '--name-only', '-M', base, 'HEAD'])),
    ...lines(git(root, ['diff', '--name-only', '-M', 'HEAD'])),
    ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
  ]);
}

function addedPaths(root, base) {
  return base ? lines(git(root, ['diff', '--name-only', '-M', '--diff-filter=A', base, 'HEAD'])) : [];
}

function listed(readme, rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\]\\((?:[^)\\s]*/)?${name}[)#]|\`(?:[^\`\\s]*/)?${name}\``).test(readme);
}

function evaluate(root) {
  const messages = [];
  const merge = git(root, ['merge-base', 'HEAD', 'origin/main']);
  const base = merge.status === 0 ? merge.stdout.trim() : '';
  const changed = changedPaths(root, base);
  const touched = (rel) => changed === null || changed.has(rel);
  for (const rel of entryFiles(root).filter(touched)) {
    for (const hit of staleHits(read(root, rel) ?? '')) messages.push(`stale agent rule in ${rel}: ${hit}`);
  }
  if (touched('AGENTS.md')) {
    const agents = read(root, 'AGENTS.md');
    if (agents == null) messages.push('AGENTS.md lost a core rule: file missing');
    else for (const phrase of CORE) if (!agents.includes(phrase)) messages.push(`AGENTS.md lost a core rule: ${phrase}`);
  }
  for (const rel of LINK_FILES) messages.push(...deadLinks(root, rel));
  for (const rel of docsFiles(root)) {
    const text = read(root, rel) ?? '';
    if (hasBanner(text)) continue;
    for (const hit of staleHits(text)) messages.push(`stale rule in unbannered doc ${rel}: ${hit}`);
  }
  for (const hit of staleHits(read(root, 'docs/ARCHITECTURE.md') ?? '')) messages.push(`stale rule in docs/ARCHITECTURE.md: ${hit}`);
  const readme = read(root, 'docs/README.md') ?? '';
  for (const rel of addedPaths(root, base)) {
    if (rel === 'docs/archive/README.md') continue;
    if (rel.startsWith('docs/archive/')) {
      messages.push(`archive only receives moves: ${rel} was added`);
      continue;
    }
    const atRoot = /^[^/]+\.md$/.test(rel);
    const inDocs = /^docs\/[^/]+\.md$/.test(rel);
    if ((atRoot || inDocs) && !listed(readme, rel)) messages.push(`new markdown is not listed in docs/README.md: ${rel}`);
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

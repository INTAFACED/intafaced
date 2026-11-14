#!/usr/bin/env node
/**
 * LINT RATCHET: a pull request may not add lint findings, rule by rule, in the files it touches.
 *
 * For the files the change touches (added, modified, renamed, deleted; lintable extensions), it lints each file as it was
 * at the merge base and as it is at the head, with MAIN's `.oxlintrc.json`, main's garden plugin (tooling/lint/**) and
 * main's start dates (tooling/lint/ratchet.json), read with `git show`, so a change cannot loosen the rules it is judged
 * by. It counts findings per rule over those files on each side, prints the table (into the job summary on CI), and fails
 * only when an enforcing rule's count is higher at the head than at the base.
 *
 * There is no baseline file: main's own code is the baseline, so the count tightens by itself and a function moved from
 * one touched file to another does not fail (its finding leaves one file and arrives in the other).
 *
 * A rule enforces 7 days after its start date and only prints before that, so a pull request opened before a rule
 * started is told the date. The start date is the rule's entry in ratchet.json `started`, else the day ratchet.json first
 * reached main. Rules in `enforceFromStart` enforce at once: they replaced checks that already failed a change (deleted
 * source-reading unit tests, the regex duplicate ratchet), so their guard never lapses. Rules in `enforceAddedFromStart`
 * replaced tests that judged only the files a change ADDS: any finding in an added file fails at once, as the test did,
 * and a rise in an existing file follows the dates like any other rule.
 *
 * Usage:
 *   node tooling/ci/lint-ratchet.mjs                    merge base with main .. HEAD
 *   node tooling/ci/lint-ratchet.mjs --base <ref> --head <ref> [--rules-ref <ref>] [--json]
 * On GitHub Actions main is fetched fresh from the repository's URL into refs/lint-ratchet/main, never read from
 * origin/main, which code the change ran earlier in the job could move.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
export const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;
export const CONFIG = '.oxlintrc.json';
export const PLUGIN_DIR = 'tooling/lint';
export const STARTS = 'tooling/lint/ratchet.json';
const DAY = 24 * 60 * 60 * 1000;

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: opts.cwd ?? ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const gitOr = (args, fallback = null) => {
  try {
    return git(args);
  } catch {
    return fallback;
  }
};
const show = (ref, path) => gitOr(['show', `${ref}:${path}`]);

/** The touched files between two commits: [{ base: path|null, head: path|null }], renames paired. */
export function changedFiles(base, head) {
  const out = git(['diff', '--name-status', '-M', base, head]);
  const files = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [status, a, b] = line.split('\t');
    const s = status[0];
    if (s === 'R') files.push({ base: a, head: b });
    else if (s === 'A') files.push({ base: null, head: a });
    else if (s === 'D') files.push({ base: a, head: null });
    else files.push({ base: a, head: a });
  }
  return files.filter((f) => LINTABLE.test(f.head ?? f.base));
}

/** `garden(no-double-cast)` → `garden/no-double-cast`; a diagnostic with no code is an unused suppression. */
export const ruleOf = (d) => {
  if (!d.code) return /^Unused .*directive/u.test(d.message ?? '') ? 'unused-suppression' : 'unknown';
  const m = /^([\w-]+)\((.+)\)$/u.exec(d.code);
  return m ? `${m[1]}/${m[2]}` : d.code;
};

/** Writes main's config and plugin into dir/rules and returns the config text with the plugin path made absolute. */
function rulesFrom(ref, dir) {
  const configText = show(ref, CONFIG);
  if (!configText) return null;
  const listing = gitOr(['ls-tree', '-r', '--name-only', ref, '--', PLUGIN_DIR], '');
  for (const path of listing.split('\n').filter(Boolean)) {
    const text = show(ref, path);
    if (text === null) continue;
    mkdirSync(dirname(join(dir, 'rules', path)), { recursive: true });
    writeFileSync(join(dir, 'rules', path), text);
  }
  const config = JSON.parse(configText);
  delete config.$schema;
  config.jsPlugins = (config.jsPlugins ?? []).map((p) => join(dir, 'rules', p));
  const starts = show(ref, STARTS);
  return { config, starts: starts ? JSON.parse(starts) : { printOnlyDays: 7, enforceFromStart: [], started: {} } };
}

/** Lints one side's files (path → text) with the config, from a tree of their own; returns { rule: { file: count } }. */
export function lintSide(files, config, dir, oxlint) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CONFIG), JSON.stringify(config));
  const paths = [];
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    paths.push(path);
  }
  const counts = {};
  if (!paths.length) return counts;
  const run = spawnSync(oxlint, ['-c', CONFIG, '--format', 'json', '--report-unused-disable-directives', ...paths], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout || '').slice(0, 800)}`);
  }
  for (const d of parsed.diagnostics ?? []) {
    const rule = ruleOf(d);
    const file = String(d.filename).split('\\').join('/');
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] ?? 0) + 1;
  }
  return counts;
}

const sum = (byFile) => Object.values(byFile ?? {}).reduce((a, b) => a + b, 0);

/** When a rule starts failing: null (enforces now) or the ISO day it starts. */
export function enforcesFrom(rule, starts, defaultStart) {
  if ((starts.enforceFromStart ?? []).includes(rule)) return null;
  const start = starts.started?.[rule] ?? defaultStart;
  return start ? new Date(Date.parse(start) + (starts.printOnlyDays ?? 7) * DAY).toISOString().slice(0, 10) : 'never';
}

/** The verdict: one row per rule seen on either side, and the rules that rose while enforcing. */
export function compare(base, head, starts, defaultStart, today = new Date().toISOString().slice(0, 10), added = new Set()) {
  const rows = [];
  for (const rule of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const was = sum(base[rule]);
    const now = sum(head[rule]);
    const from = enforcesFrom(rule, starts, defaultStart);
    const enforcing = from === null || (from !== 'never' && from <= today);
    const rose = now > was;
    const inFiles = (keep) =>
      Object.keys(head[rule] ?? {})
        .filter((f) => (head[rule][f] ?? 0) > 0 && keep(f))
        .sort();
    // A rule that replaced a test of ADDED files only enforces on added files at once; elsewhere it follows its dates.
    const newFiles = (starts.enforceAddedFromStart ?? []).includes(rule) ? inFiles((f) => added.has(f)) : [];
    const fails = (rose && enforcing) || newFiles.length > 0;
    rows.push({ rule, was, now, enforcing, from, fails, newFiles, files: rose || newFiles.length ? inFiles(() => true) : [] });
  }
  return { rows, failing: rows.filter((r) => r.fails) };
}

export function table({ rows }, nFiles) {
  const lines = [
    `Lint ratchet: ${nFiles} touched file(s), linted at the merge base and at the head with main's rules.`,
    '',
    '| rule | base | head | status |',
    '|---|---:|---:|---|',
  ];
  for (const r of rows) {
    const status = r.newFiles?.length
      ? `**FAILS: in file(s) this change adds**: ${r.newFiles.join(', ')}`
      : r.now > r.was
        ? r.enforcing
          ? `**FAILS: +${r.now - r.was}** in ${r.files.join(', ')}`
          : `rose +${r.now - r.was}; prints only, fails from ${r.from}`
        : r.enforcing
          ? r.now < r.was
            ? `fell ${r.now - r.was}`
            : 'held'
          : `held; fails from ${r.from}`;
    lines.push(`| ${r.rule} | ${r.was} | ${r.now} | ${status} |`);
  }
  if (!rows.length) lines.push('| (no findings on either side) | 0 | 0 | held |');
  return lines.join('\n');
}

function mainRef() {
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_REPOSITORY) {
    const url = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`;
    if (gitOr(['fetch', '--no-tags', '--quiet', url, '+refs/heads/main:refs/lint-ratchet/main']) === null) return null;
    return 'refs/lint-ratchet/main';
  }
  return 'origin/main';
}

export function run(argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const main = arg('--rules-ref') ?? mainRef();
  if (!main) {
    console.error("✖ lint-ratchet: cannot fetch main from the repository; main's rules are what a change is judged by");
    return 1;
  }
  const head = arg('--head') ?? 'HEAD';
  const base = arg('--base') ?? gitOr(['merge-base', head, main])?.trim();
  if (!base) {
    console.error(`✖ lint-ratchet: no merge base between ${head} and ${main}; fetch main and run again`);
    return 1;
  }
  const oxlint = join(ROOT, 'node_modules', '.bin', 'oxlint');
  if (!existsSync(oxlint)) {
    console.error('✖ lint-ratchet: node_modules/.bin/oxlint is missing; run pnpm install');
    return 1;
  }
  const files = changedFiles(base, head);
  const dir = mkdtempSync(join(tmpdir(), 'lint-ratchet-'));
  try {
    const rules = rulesFrom(main, dir);
    if (!rules) {
      console.log(`lint-ratchet: ${main} has no ${CONFIG} yet, nothing to judge with`);
      return 0;
    }
    const read = (ref, key) =>
      Object.fromEntries(
        files
          .filter((f) => f[key])
          .flatMap((f) => {
            const text = show(ref, f[key]);
            return text === null ? [] : [[f[key], text]];
          }),
      );
    const started = Date.now();
    const baseCounts = lintSide(read(base, 'base'), rules.config, join(dir, 'base'), oxlint);
    const headCounts = lintSide(read(head, 'head'), rules.config, join(dir, 'head'), oxlint);
    const landed = gitOr(['log', '--diff-filter=A', '--format=%cI', main, '--', STARTS], '').trim().split('\n').filter(Boolean).pop();
    const added = new Set(files.filter((f) => !f.base).map((f) => f.head));
    const verdict = compare(baseCounts, headCounts, rules.starts, landed ?? new Date().toISOString(), undefined, added);
    const text = table(verdict, files.length) + `\n\n(${Date.now() - started} ms)`;
    if (argv.includes('--json')) console.log(JSON.stringify({ files: files.length, ...verdict, ms: Date.now() - started }));
    else console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    if (verdict.failing.length) {
      for (const r of verdict.failing)
        console.error(
          (r.newFiles.length
            ? `✖ lint-ratchet: ${r.rule} fires in file(s) this change adds (${r.newFiles.join(', ')}). `
            : `✖ lint-ratchet: ${r.rule} rose from ${r.was} to ${r.now} in the touched files (${r.files.join(', ')}). `) +
            'Run `pnpm lint <file>` for the lines and the fix; a finding removed elsewhere in a touched file pays for one added.',
        );
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run());

#!/usr/bin/env node
/**
 * LINT RATCHET: a pull request may not add lint findings, rule by rule, in the files it touches.
 *
 * For the files the change touches (added, modified, renamed, deleted; lintable extensions), it lints each file as it was
 * at the merge base and as it is at the head, with MAIN's `.oxlintrc.json`, main's garden plugin (tooling/lint/**) and
 * main's tooling/lint/ratchet.json, read with `git show`, so a change cannot loosen the rules it is judged by. It counts
 * findings per rule over those files on each side, prints the table (into the job summary on CI), and fails when a rule's
 * count is higher at the head than at the base, printing each new finding's line, message and fix.
 *
 * There is no baseline file: main's own code is the baseline, so the count tightens by itself and a function moved from
 * one touched file to another does not fail (its finding leaves one file and arrives in the other).
 *
 * Every rule enforces: a copy or a pattern kept on purpose carries a suppression with its reason on that line. Rules in
 * ratchet.json `failInAddedFiles` replaced tests that judged the files a change ADDS: any finding in an added file
 * fails, even when a removal elsewhere pays for it, as the test did.
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
  return { config, starts: starts ? JSON.parse(starts) : {} };
}

/** Lints one side's files (path → text) with the config, from a tree of their own; returns { rule: { file: count } },
 * with each finding's line and text in `found` (rule → file → [{ line, text }]). */
export function lintSide(files, config, dir, oxlint, found = {}) {
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
    ((found[rule] ??= {})[file] ??= []).push({ line: d.labels?.[0]?.span?.line, text: [d.message, d.help].filter(Boolean).join(' ') });
  }
  return counts;
}

const sum = (byFile) => Object.values(byFile ?? {}).reduce((a, b) => a + b, 0);

/** The verdict: one row per rule seen on either side, and the rules that rose. */
export function compare(base, head, starts, added = new Set()) {
  const rows = [];
  for (const rule of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const was = sum(base[rule]);
    const now = sum(head[rule]);
    const rose = now > was;
    const inFiles = (keep) =>
      Object.keys(head[rule] ?? {})
        .filter((f) => (head[rule][f] ?? 0) > 0 && keep(f))
        .sort();
    const newFiles = (starts.failInAddedFiles ?? []).includes(rule) ? inFiles((f) => added.has(f)) : [];
    const fails = rose || newFiles.length > 0;
    const files = rose || newFiles.length ? inFiles((f) => newFiles.includes(f) || (head[rule][f] ?? 0) > (base[rule]?.[f] ?? 0)) : [];
    rows.push({ rule, was, now, fails, newFiles, files });
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
        ? `**FAILS: +${r.now - r.was}** in ${r.files.join(', ')}`
        : r.now < r.was
          ? `fell ${r.now - r.was}`
          : 'held';
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
    const found = {};
    const baseCounts = lintSide(read(base, 'base'), rules.config, join(dir, 'base'), oxlint);
    const headCounts = lintSide(read(head, 'head'), rules.config, join(dir, 'head'), oxlint, found);
    const added = new Set(files.filter((f) => !f.base).map((f) => f.head));
    const verdict = compare(baseCounts, headCounts, rules.starts, added);
    const text = table(verdict, files.length) + `\n\n(${Date.now() - started} ms)`;
    if (argv.includes('--json')) console.log(JSON.stringify({ files: files.length, ...verdict, ms: Date.now() - started }));
    else console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    if (verdict.failing.length) {
      for (const r of verdict.failing) {
        console.error(
          r.newFiles.length
            ? `✖ lint-ratchet: ${r.rule} fires in file(s) this change adds (${r.newFiles.join(', ')}).`
            : `✖ lint-ratchet: ${r.rule} rose from ${r.was} to ${r.now} in the touched files (${r.files.join(', ')}); a finding removed elsewhere in them pays for one added.`,
        );
        for (const f of r.files) for (const d of (found[r.rule]?.[f] ?? []).slice(0, 10)) console.error(`  ${f}:${d.line}  ${d.text}`);
      }
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run());

#!/usr/bin/env node
/**
 * Codemod for eslint(no-unused-vars): removes the unused code whose removal cannot change what the program does.
 *
 *   node tooling/lint/unused-vars-codemod.mjs <path>...            dry run: what it would remove
 *   node tooling/lint/unused-vars-codemod.mjs <path>... --write    removes it, then formats the files with prettier
 *
 * The rule's own fixer (oxlint --fix-suggestions) also deletes a whole value import such as `import d from './side'`,
 * which skips that module's top-level code, and a variable whose initialiser has side effects. So this takes the
 * rule's findings from the root .oxlintrc.json and fixes only four kinds, through the one-rule plugin beside it
 * (unused-vars-codemod-plugin.js, which says why each keeps behaviour): an unused name in an import that keeps another
 * name, or a whole `import type` or import of a Node builtin; an unused catch binding; an unused function
 * declaration; an unused type alias. Everything else (unused variables, parameters, and whole value imports of other
 * modules) needs a judgement and is listed in #8649.
 *
 * Removing a function can leave a helper only it used unused; run it again until it removes nothing more.
 * Deleted once eslint(no-unused-vars) is at zero on main (#8649).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = (name) => join(ROOT, 'node_modules', '.bin', name);
const RULE = 'eslint(no-unused-vars)';

/** The kind and name a finding's message names, or null when it is not one this codemod fixes. */
export function kindOf(message) {
  const m = /^(Identifier|Type|Catch parameter|Function|Type alias) '([^']+)' (?:is imported|is caught|is declared)/u.exec(message);
  if (!m) return null;
  if (/is imported/u.test(message)) return { kind: 'import', name: m[2] };
  if (m[1] === 'Catch parameter') return { kind: 'catch', name: m[2] };
  if (m[1] === 'Function') return { kind: 'function', name: m[2] };
  if (m[1] === 'Type alias') return { kind: 'type', name: m[2] };
  return null;
}

function lint(config, paths, extra = [], env = process.env) {
  const run = spawnSync(BIN('oxlint'), ['-c', config, '--format', 'json', ...extra, ...paths], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  try {
    return JSON.parse(run.stdout).diagnostics;
  } catch {
    throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 800)}`);
  }
}

/** The findings this codemod fixes, as { "<abs file>": [{ kind, name, line }] }, and how many of the rule's it leaves. */
export function targetsOf(diagnostics) {
  const targets = {};
  let left = 0;
  for (const d of diagnostics) {
    if (d.code !== RULE) continue;
    const k = kindOf(d.message);
    if (!k) {
      left++;
      continue;
    }
    (targets[resolve(ROOT, d.filename)] ??= []).push({ ...k, line: d.labels?.[0]?.span?.line });
  }
  return { targets, left };
}

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  // Absolute: oxlint refuses a path with `..` in it.
  const paths = argv.filter((a) => !a.startsWith('--')).map((p) => resolve(p));
  if (!paths.length) {
    console.error('usage: unused-vars-codemod.mjs <path>... [--write]');
    return 2;
  }
  const findings = () => lint(join(ROOT, '.oxlintrc.json'), paths).filter((d) => d.code === RULE);
  const before = findings();
  const dir = mkdtempSync(join(tmpdir(), 'unused-codemod-'));
  try {
    const config = join(dir, 'oxlintrc.json');
    // Only the codemod's rule: no built-in plugin or category, so --fix applies no other rule's fix.
    writeFileSync(
      config,
      JSON.stringify({
        plugins: [],
        categories: { correctness: 'off' },
        jsPlugins: [join(ROOT, 'tooling/lint/unused-vars-codemod-plugin.js')],
        rules: { 'unused-codemod/safe': 'error' },
      }),
    );
    const env = { ...process.env, UNUSED_CODEMOD_TARGETS: join(dir, 'targets.json') };
    const plan = (diagnostics) => {
      const { targets } = targetsOf(diagnostics);
      writeFileSync(join(dir, 'targets.json'), JSON.stringify(targets));
      const files = Object.keys(targets);
      return { files, planned: files.length ? lint(config, files, [], env) : [] };
    };
    let { files, planned } = plan(before);
    if (!write) {
      const byKind = {};
      for (const d of planned) byKind[d.message] = (byKind[d.message] ?? 0) + 1;
      console.log(
        `${RULE}: ${before.length} finding(s); would fix ${planned.length} in ${new Set(planned.map((d) => d.filename)).size} file(s)`,
        byKind,
      );
      return 0;
    }
    // oxlint skips a fix whose range touches one it already applied (two imports on adjacent lines), so it runs again
    // on the findings that are left, with their new line numbers, until a pass fixes nothing.
    const changed = new Set();
    for (let pass = 1; planned.length && pass <= 10; pass++) {
      for (const f of files) changed.add(f);
      lint(config, files, ['--fix'], env);
      ({ files, planned } = plan(findings()));
    }
    if (changed.size)
      spawnSync(BIN('prettier'), ['--write', '--log-level', 'warn', ...changed], {
        cwd: ROOT,
        stdio: 'inherit',
      });
    const after = findings();
    console.log(
      `${RULE} in ${paths.map((p) => relative(ROOT, p) || '.').join(' ')}: ${before.length} → ${after.length} (${changed.size} file(s) changed)`,
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

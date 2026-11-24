#!/usr/bin/env node
// Gives each Rust crate one integration-test binary, `it`, instead of one per `tests/*.rs` file. Each file Cargo finds in
// `tests/` is linked into its own 55 to 126 MB binary, so a workspace test build linked about 220 of them and wrote
// about 10 GB per worktree, which wore out the build machine's disk (intafaced#9589). One root per crate,
// `tests/it.rs`, holds each file as a module; the files keep their paths.
//
// This writes, for every crate under crates/ (not crates/vendor) with a `tests/*.rs` file:
// - `tests/it.rs`, listing every other `tests/*.rs` file and every `tests/<dir>/main.rs` (Cargo's other test layout),
//   and a test that fails when one is not listed (with `autotests = false` an unlisted file would never run); and once,
//   each shared helper `tests/<dir>/mod.rs`, which the files reach by `use crate::<dir>;`;
// - `autotests = false` and the one `[[test]]` entry in the crate's Cargo.toml.
//
//   node tooling/scripts/rust-test-roots.mjs           writes them
//   node tooling/scripts/rust-test-roots.mjs --check   exits 1 naming each stale file
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT_FILE = 'it.rs';
const MODULE = /^[a-z_][a-z0-9_]*$/;

/**
 * The test files of one crate's tests folder, as Cargo finds them without `autotests = false`: each `tests/<name>.rs`
 * but the root, and each `tests/<name>/main.rs`. Sorted [module, path] pairs, the path relative to tests/.
 */
export function testFiles(testsDir) {
  if (!existsSync(testsDir)) return [];
  const found = [];
  for (const e of readdirSync(testsDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.rs') && e.name !== ROOT_FILE) found.push([e.name.slice(0, -'.rs'.length), e.name]);
    else if (e.isDirectory() && existsSync(join(testsDir, e.name, 'main.rs'))) found.push([e.name, `${e.name}/main.rs`]);
  }
  return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The helpers a crate's test files share: each `tests/<name>/mod.rs`, declared once in the root. Sorted names. */
export function helperDirs(testsDir) {
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(testsDir, e.name, 'mod.rs')) && !existsSync(join(testsDir, e.name, 'main.rs')))
    .map((e) => e.name)
    .sort();
}

/** The text of a crate's `tests/it.rs` for these [module, path] pairs and helper names. */
export function rootSource(files, helpers = []) {
  const bad = files.filter(([m]) => !MODULE.test(m));
  if (bad.length > 0) throw new Error(`not a Rust module name, rename it: ${bad.map(([, p]) => p).join(', ')}`);
  return [
    "//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a",
    '//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by',
    "//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.",
    '',
    // #[path] makes each file a directory owner, as it was as its own crate root: its `mod support;` still reads
    // tests/support/mod.rs.
    ...files.flatMap(([m, p]) => [`#[path = "${p}"]`, `mod ${m};`]),
    '',
    // A helper is compiled once, here, and a file reaches it by `use crate::<helper>;`: a second `mod` of the same file
    // in one binary is refused by clippy's duplicate_mod, whose help says the same.
    ...(helpers.length > 0 ? ['// The helpers the files share: `use crate::<helper>;`, never a `mod` of their own.'] : []),
    ...helpers.map((h) => `mod ${h};`),
    ...(helpers.length > 0 ? [''] : []),
    '/// A `tests/*.rs` or `tests/*/main.rs` file this root does not list would never run.',
    '#[test]',
    'fn every_test_file_is_listed() {',
    '    let root = include_str!("it.rs");',
    '    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");',
    '    let mut unlisted = Vec::new();',
    '    for entry in std::fs::read_dir(dir).unwrap() {',
    '        let entry = entry.unwrap();',
    '        let name = entry.file_name().into_string().unwrap();',
    '        let module = if entry.path().join("main.rs").is_file() {',
    '            Some(name.as_str())',
    '        } else {',
    '            name.strip_suffix(".rs").filter(|stem| *stem != "it")',
    '        };',
    '        if let Some(module) = module',
    '            && !root.contains(&format!("\\nmod {module};\\n"))',
    '        {',
    '            unlisted.push(name);',
    '        }',
    '    }',
    '    assert!(',
    '        unlisted.is_empty(),',
    '        "tests/it.rs does not list {unlisted:?}, so they never run: run `node tooling/scripts/rust-test-roots.mjs`"',
    '    );',
    '}',
    '',
  ].join('\n');
}

const TEST_ENTRY = '[[test]]\nname = "it"\npath = "tests/it.rs"\n';

/** The crate's Cargo.toml with `autotests = false` in [package] and the one [[test]] entry. */
export function manifestSource(text) {
  let out = text;
  if (!/^autotests = false$/m.test(out)) {
    const pkg = out.indexOf('[package]\n');
    if (pkg < 0) throw new Error('no [package] section');
    // The end of the [package] section: the next section header, or the end of the file.
    const next = out.slice(pkg + 1).search(/^\[/m);
    const end = next < 0 ? out.length : pkg + 1 + next;
    const head = out.slice(0, end).replace(/\n*$/, '\n');
    out = `${head}autotests = false\n\n${out.slice(end)}`;
  }
  if (!out.includes(TEST_ENTRY)) out = `${out.replace(/\n*$/, '\n')}\n${TEST_ENTRY}`;
  return out;
}

/** Every file this writes, with its wanted text: [path, text][]. */
export function plan(repo) {
  const crates = join(repo, 'crates');
  const out = [];
  for (const entry of readdirSync(crates, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'vendor') continue;
    const dir = join(crates, entry.name);
    const files = testFiles(join(dir, 'tests'));
    if (files.length === 0) continue;
    out.push([join(dir, 'tests', ROOT_FILE), rootSource(files, helperDirs(join(dir, 'tests')))]);
    const manifest = join(dir, 'Cargo.toml');
    out.push([manifest, manifestSource(readFileSync(manifest, 'utf8'))]);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [path, want] of plan(process.cwd())) {
    const have = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (have === want) continue;
    if (check) stale.push(path);
    else writeFileSync(path, want);
  }
  if (stale.length > 0) {
    console.error(`stale: ${stale.join(', ')}\nrun \`node tooling/scripts/rust-test-roots.mjs\``);
    process.exit(1);
  }
}

#!/usr/bin/env node
// Moves the Rust crates onto service-kit's `Amount` newtype (INTAFACED/project-state#3851). `Amount` was
// `pub type Amount = i128`, so every integer literal written where money is expected compiled; as a newtype each one is
// a compile error. This script reads those errors from `cargo check --message-format=json` and rewrites each literal
// the compiler points at, then checks again, until no literal is left:
//
//   0                          -> Amount::ZERO
//   5_000_000_000_000_000_000  -> Amount::whole(5)       (a whole number of units at 18 places)
//   1_500                      -> Amount::from_scaled(1_500)
//
// Only a span that is an integer literal is rewritten. Every other error (an i128 or i64 variable passed as money, money
// passed where a count or basis points are meant, a product of two amounts) is a judgement the compiler hands back to
// the author: the type now refuses it, and the fix is a named conversion or the right type for the value.
//
// Run: node tooling/codemod/amount-newtype/rewrite.mjs [--check]
// `--check` rewrites nothing; it prints the literals it would rewrite and exits 1 if there are any.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCALE = 10n ** 18n;
const LITERAL = /^(-?)([0-9][0-9_]*)(?:i128|i64|i32|u64|u128)?$/;
// The compiler's words for "money expected, an integer given": a plain mismatch, an if/else or match arm, a `Some(..)`.
const EXPECTS_AMOUNT =
  /expected `(?:[A-Za-z_:]*::)?Amount`, found integer|expected `Option<(?:[A-Za-z_:]*::)?Amount>`, found `Option<\{integer\}>`|expected `Result<(?:[A-Za-z_:]*::)?Amount, [^`]*`, found `Result<\{integer\}, [^`]*`/;

/** The money expression for an integer literal's text, or null when the text is not one literal. */
export function amountFor(text) {
  const m = LITERAL.exec(text.trim());
  if (!m) return null;
  const [, sign, digits] = m;
  const value = BigInt(digits.replaceAll('_', ''));
  if (value === 0n) return 'Amount::ZERO';
  if (value % SCALE === 0n) return `${sign}Amount::whole(${groupDigits(value / SCALE)})`;
  return `${sign}Amount::from_scaled(${digits})`;
}

function groupDigits(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/** `Some(5)` or `Ok(5)` -> `Some(Amount::whole(..))`; any other wrapped span is left to the author. */
function rewriteSpan(text) {
  const some = /^(?:Some|Ok)\((.*)\)$/s.exec(text.trim());
  if (some) {
    const inner = amountFor(some[1]);
    return inner ? `${text.trim().startsWith('Ok') ? 'Ok' : 'Some'}(${inner})` : null;
  }
  return amountFor(text);
}

/** Each literal the compiler says should be money: { file, start, end, text, to }, deduplicated. */
export function literalSites(jsonLines) {
  const seen = new Map();
  for (const line of jsonLines.split('\n')) {
    if (!line.startsWith('{')) continue;
    const msg = JSON.parse(line);
    if (msg.reason !== 'compiler-message' || msg.message.level !== 'error') continue;
    for (const span of msg.message.spans) {
      // The primary span of a mismatch, or one argument's span under "arguments to this function are incorrect".
      if (!EXPECTS_AMOUNT.test(span.label ?? '')) continue;
      if (span.line_start !== span.line_end) continue;
      const first = span.text[0];
      if (!first) continue;
      const text = first.text.slice(first.highlight_start - 1, first.highlight_end - 1);
      const to = rewriteSpan(text);
      if (!to) continue;
      const key = `${span.file_name}:${span.byte_start}`;
      seen.set(key, { file: span.file_name, start: span.byte_start, end: span.byte_end, text, to });
    }
  }
  return [...seen.values()];
}

/** Files where a rewritten literal names `Amount` but nothing imports it. */
export function filesMissingImport(jsonLines) {
  const files = new Set();
  for (const line of jsonLines.split('\n')) {
    if (!line.startsWith('{')) continue;
    const msg = JSON.parse(line);
    if (msg.reason !== 'compiler-message' || msg.message.level !== 'error') continue;
    const undeclared = msg.message.spans.some((s) => s.is_primary && /undeclared type `Amount`/.test(s.label ?? ''));
    if (undeclared) files.add(msg.message.spans.find((s) => s.is_primary).file_name);
  }
  return [...files];
}

/** Adds `use <crate path>::money::Amount;` after the file's first top-level `use`, or at its first line of code. */
export function withImport(text, file) {
  const path = file.startsWith('crates/service-kit/') ? 'crate::money::Amount' : 'service_kit::money::Amount';
  const line = `use ${path};\n`;
  const lines = text.split(/(?<=\n)/);
  const firstUse = lines.findIndex((l) => l.startsWith('use '));
  const at = firstUse >= 0 ? firstUse : lines.findIndex((l) => !l.startsWith('//') && l.trim() !== '');
  lines.splice(at, 0, line);
  return lines.join('');
}

function check() {
  const out = spawnSync('cargo', ['check', '--workspace', '--all-targets', '--keep-going', '--message-format=json'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  return out.stdout;
}

function apply(sites) {
  const byFile = Map.groupBy(sites, (s) => s.file);
  for (const [file, list] of byFile) {
    const path = join(REPO, file);
    let buf = readFileSync(path);
    for (const s of list.sort((a, b) => b.start - a.start)) {
      if (buf.subarray(s.start, s.end).toString('utf8') !== s.text) continue;
      buf = Buffer.concat([buf.subarray(0, s.start), Buffer.from(s.to), buf.subarray(s.end)]);
    }
    writeFileSync(path, buf);
  }
  return byFile.size;
}

function main() {
  const dry = process.argv.includes('--check');
  let total = 0;
  for (let round = 1; round <= 20; round++) {
    const json = check();
    const sites = literalSites(json);
    const unimported = filesMissingImport(json);
    if (sites.length === 0 && unimported.length === 0) break;
    if (dry) {
      for (const s of sites) console.log(`${s.file}:${s.start} ${s.text} -> ${s.to}`);
      for (const f of unimported) console.log(`${f}: imports Amount`);
      process.exit(1);
    }
    for (const file of unimported) {
      const path = join(REPO, file);
      writeFileSync(path, withImport(readFileSync(path, 'utf8'), file));
    }
    if (unimported.length) console.log(`round ${round}: Amount imported in ${unimported.length} files`);
    const files = apply(sites);
    total += sites.length;
    console.log(`round ${round}: ${sites.length} literals in ${files} files`);
  }
  console.log(`${total} literals now name their money`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

#!/usr/bin/env node
/**
 * ADR REGISTER CHECK
 *
 * docs/POLICY-REGISTER.md lists the rules in force; docs/adr/ says why. Two things
 * must stay true for that to be believable:
 *
 *   1. every register row links an ADR that exists and whose status is `accepted`
 *      (a proposed or superseded record cannot back a rule in force), and
 *   2. docs/adr/README.md is current: regenerated from the ADR files, it must match
 *      byte for byte (`node tooling/scripts/adr-index.mjs` fixes it).
 *
 * Empty-denominator note: an EMPTY register is legitimate (no rule has been
 * recorded yet), so zero rows passes. What must never pass is checking against
 * nothing: no ADR files, no register file, or a register whose header cannot be
 * read all refuse. The tree is read from process.cwd(), like the other doctrine
 * scans.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdrs, renderIndex } from '../scripts/adr-index.mjs';

export const REGISTER_COLUMNS = ['Rule', 'Current value', 'Hard/soft', 'Owner chat', 'ADR', 'Effective', 'Review by'];

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** Returns { problems, adrs, rows } for the tree rooted at `root`. */
export function checkRegister(root) {
  const problems = [];
  const adrDir = join(root, 'docs', 'adr');
  let adrs = [];
  try {
    adrs = readAdrs(adrDir);
  } catch (e) {
    problems.push(`unreadable ADR status:\n      ${e.message.split('\n').join('\n      ')}`);
  }
  if (adrs.length === 0 && problems.length === 0)
    problems.push('docs/adr has no ADR files, so there is nothing to check a register against.');

  // 2. the index is current
  if (adrs.length > 0) {
    const readme = join(adrDir, 'README.md');
    if (!existsSync(readme) || readFileSync(readme, 'utf8') !== renderIndex(adrs))
      problems.push('docs/adr/README.md is missing or stale. Fix: node tooling/scripts/adr-index.mjs');
  }

  // 1. every register row links an existing, accepted ADR
  const rows = [];
  const registerPath = join(root, 'docs', 'POLICY-REGISTER.md');
  if (!existsSync(registerPath)) {
    problems.push('docs/POLICY-REGISTER.md does not exist.');
  } else {
    const lines = readFileSync(registerPath, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.startsWith('|') && cells(l)[0] === 'Rule');
    if (at < 0 || cells(lines[at]).join('|') !== REGISTER_COLUMNS.join('|')) {
      problems.push(`docs/POLICY-REGISTER.md: header row must be exactly: | ${REGISTER_COLUMNS.join(' | ')} |`);
    } else {
      const status = new Map(adrs.map((a) => [a.file, a.status]));
      for (let i = at + 1; i < lines.length && lines[i].startsWith('|'); i++) {
        if (/^\|[\s:|-]+\|?\s*$/.test(lines[i])) continue; // the --- separator
        const c = cells(lines[i]);
        const label = `register row "${c[0] || lines[i].slice(0, 40)}"`;
        rows.push(c);
        if (c.length !== REGISTER_COLUMNS.length) {
          problems.push(`${label}: ${c.length} columns, expected ${REGISTER_COLUMNS.length}.`);
          continue;
        }
        const link = /\(([^)\s#]+\.md)(?:#[^)]*)?\)/.exec(c[4]) ?? /([^\s()[\]]+\.md)/.exec(c[4]);
        if (!link) {
          problems.push(`${label}: ADR column has no link to a .md file.`);
          continue;
        }
        const target = resolve(dirname(registerPath), link[1]);
        const file = basename(target);
        if (relative(adrDir, target) !== file || !status.has(file))
          problems.push(`${label}: links ${link[1]}, which is not an ADR in docs/adr.`);
        else if (status.get(file) !== 'accepted')
          problems.push(`${label}: ${file} is ${status.get(file)}. Only accepted ADRs back a rule in force.`);
      }
    }
  }
  return { problems, adrs, rows };
}

const RUN_AS_SCRIPT = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (RUN_AS_SCRIPT) {
  const { problems, adrs, rows } = checkRegister(process.cwd());
  if (problems.length > 0) {
    console.error(`ADR REGISTER CHECK FAILED — ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(
    `✓ adr-register — ${adrs.length} ADRs, README current, ${rows.length} register row(s) all link accepted ADRs` +
      (rows.length === 0 ? ' (empty register is valid until the first rule is recorded)' : ''),
  );
}

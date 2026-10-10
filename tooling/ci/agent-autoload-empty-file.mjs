#!/usr/bin/env node
/**
 * A zero-byte required law file must fail agent-autoload-scan.
 * read() records a miss only when the file is absent; an empty read used to
 * skip every needle and still print the intact line.
 *
 * Copies the real law files. Does not invent their text. Empties one.
 * Run: node tooling/ci/agent-autoload-empty-file.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_REL = join('tooling', 'ci', 'agent-autoload-scan.mjs');
const INTACT = '✓ agent-autoload-scan: full-access + money/chain/leverage intact';

function required() {
  const src = readFileSync(join(REPO, SCAN_REL), 'utf8');
  const byFile = new Map();
  for (const m of src.matchAll(/^mustInclude\('([^']+)', '([^']+)',/gm)) {
    const rel = m[1];
    const needle = m[2];
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(needle);
  }
  return { src, byFile };
}

function stage(src, byFile, emptyRel) {
  const root = mkdtempSync(join(tmpdir(), 'autoload-empty-'));
  mkdirSync(join(root, 'tooling', 'ci'), { recursive: true });
  writeFileSync(join(root, SCAN_REL), src);
  for (const rel of byFile.keys()) {
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, rel === emptyRel ? '' : readFileSync(join(REPO, rel)));
  }
  return root;
}

function runScan(root) {
  const r = spawnSync(process.execPath, [join(root, SCAN_REL)], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const fails = [];
const { src, byFile } = required();
if (byFile.size === 0) {
  console.error('FAIL: parsed no mustInclude calls');
  process.exit(1);
}

{
  const root = stage(src, byFile, null);
  try {
    const { status, out } = runScan(root);
    if (status !== 0 || !out.includes(INTACT)) {
      fails.push(`intact law files should pass, status ${status}\n${out}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [rel, needles] of byFile) {
  const root = stage(src, byFile, rel);
  try {
    const emptied = join(root, rel);
    if (!existsSync(emptied) || statSync(emptied).size !== 0) {
      fails.push(`${rel}: fixture was not a zero-byte file`);
      continue;
    }
    const { status, out } = runScan(root);
    if (status === 0 || out.includes(INTACT)) {
      fails.push(`${rel}: zero-byte read was a pass (status ${status})`);
      continue;
    }
    if (!out.includes(`- ${rel}:`)) {
      fails.push(`${rel}: failure did not name the empty file\n${out}`);
    }
    if (rel === 'AGENTS.md') {
      for (const needle of ['ledger-client', 'number']) {
        if (!needles.includes(needle)) {
          fails.push(`AGENTS.md: scan no longer requires ${JSON.stringify(needle)}`);
        } else if (!out.includes(`missing ${JSON.stringify(needle)}`)) {
          fails.push(`AGENTS.md: empty file skipped ${JSON.stringify(needle)}`);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (fails.length) {
  console.error('FAIL: empty required law file was not a problem');
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`ok: empty read is a problem for ${byFile.size} required law files`);

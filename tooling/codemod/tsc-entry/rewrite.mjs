#!/usr/bin/env node
// Rewrites every package.json script that runs tsc itself (`tsc -p tsconfig.json`, `tsc --noEmit && vite build`) to run
// tooling/scripts/tsc.mjs instead, which runs tsrs off CI and tsc in CI (INTAFACED/project-state#3609). Only the script
// strings change; the rest of each file is kept byte for byte. `--check` prints the scripts it would change and exits 1
// if there are any. tooling/scripts/tsc.test.mjs fails on a new one.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BARE = /(^|[\s&|;(])(?:npx |pnpm exec )?tsc(?=\s|$)/g;

/** The script with each bare tsc replaced by the one entry, reached from `dir` (the package's folder, repo-relative). */
export function rewrite(script, dir) {
  const entry = relative(join(REPO, dir), join(REPO, 'tooling', 'scripts', 'tsc.mjs'));
  return script.replace(BARE, `$1node ${entry}`);
}

const files = execFileSync('git', ['ls-files', '*package.json', 'package.json'], { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const changed = [];
for (const file of files) {
  const text = readFileSync(join(REPO, file), 'utf8');
  let next = text;
  for (const [name, script] of Object.entries(JSON.parse(text).scripts ?? {})) {
    const to = rewrite(script, dirname(file));
    if (to === script) continue;
    changed.push(`${file} ${name}`);
    next = next.replace(`${JSON.stringify(name)}: ${JSON.stringify(script)}`, `${JSON.stringify(name)}: ${JSON.stringify(to)}`);
  }
  if (next !== text && !process.argv.includes('--check')) writeFileSync(join(REPO, file), next);
}
if (changed.length) console.log(changed.join('\n'));
if (process.argv.includes('--check') && changed.length) process.exitCode = 1;

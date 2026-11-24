#!/usr/bin/env node
// The refusals step of the call-records codemod: runs the service's own tests through the newly mounted records and lists,
// on each record still at `refusals: {}`, every named refusal its handler was seen to send, with the status it was sent
// with (`PROCEDURE_REFUSALS_SEEN`, procedure-mount.ts). A refusal no test produces is not listed: outside tests an unlisted
// refusal leaves as it was thrown, so the wire is the same either way, and the list never claims what no test showed.
//
//   node tooling/codemod/call-records/refusals.mjs --service svc-bank <record file.ts> ...
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--service');
  const service = argv[at + 1];
  const files = argv.filter((_, i) => i !== at && i !== at + 1);
  const dir = mkdtempSync(join(tmpdir(), 'refusals-seen-'));
  const run = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
    cwd: join(REPO, 'services', service),
    env: { ...process.env, PROCEDURE_REFUSALS_SEEN: dir, PROCEDURE_REFUSALS_CHECK: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const seen = new Map();
  for (const f of readdirSync(dir))
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const [record, code, status] = line.split('\t');
      if (!seen.has(record)) seen.set(record, new Map());
      seen.get(record).set(code, status);
    }
  rmSync(dir, { recursive: true, force: true });
  console.log(`${service} tests exited ${run.status}; refusals seen on ${seen.size} records`);
  for (const file of files) {
    let src = readFileSync(file, 'utf8');
    let n = 0;
    // One record at a time: from its `export const` to the next one.
    const blocks = src.split(/(?=^export const [A-Z0-9_]+ = defineProcedure\()/m);
    src = blocks
      .map((block) => {
        const name = /^export const [A-Z0-9_]+ = defineProcedure\(\{[\s\S]*?name: '([^']+)'/.exec(block)?.[1];
        const codes = name ? seen.get(name) : undefined;
        if (!codes?.size || !/refusals: \{\},/.test(block)) return block;
        n++;
        const list = [...codes].sort(([a], [b]) => a.localeCompare(b)).map(([c, st]) => `'${c}': '${st}'`);
        return block.replace(/refusals: \{\},/, `refusals: { ${list.join(', ')} },`);
      })
      .join('');
    writeFileSync(file, src);
    console.log(`${basename(file)}: refusals listed on ${n} records`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

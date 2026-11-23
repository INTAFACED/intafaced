#!/usr/bin/env node
/**
 * Every vitest run of a package, each in turn, all of them, failing when any failed: a package whose tests take more
 * than one config (apps/customer: its app config, then the rendered-output recording).
 *
 *   node ../../tooling/vitest/run-all.mjs <config> [<config> ...] [<other vitest arguments>]
 *
 * Each argument naming a config file (`*config.ts`, `.mts`, `.js`, `.mjs`) is one `vitest run --config <it>`; every
 * other argument goes to each run. `a && b` stopped at the first red run, so a failure in one left the next one's tests
 * unrun on that commit, and the Tests job could not tell what else was red (tooling/ci/base-failures.mjs counts a
 * package's runs, and reads one this way as all of them run).
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONFIG = /config\.[cm]?[jt]s$/;

/** The runs one command line asks for: [{ config, args }], and the arguments every run takes. */
export function plan(argv) {
  const configs = argv.filter((a) => CONFIG.test(a));
  const rest = argv.filter((a) => !CONFIG.test(a));
  if (!configs.length) throw new Error('run-all.mjs: name at least one vitest config');
  return configs.map((config) => ['run', '--config', config, ...rest]);
}

function main() {
  const runs = plan(process.argv.slice(2));
  const red = [];
  for (const args of runs) {
    const r = spawnSync('vitest', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) red.push(`vitest ${args.join(' ')} (${r.error ? r.error.message : `exit ${r.status ?? r.signal}`})`);
  }
  if (red.length) {
    console.error(`run-all.mjs: ${red.length} of ${runs.length} vitest runs failed:\n  ${red.join('\n  ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();

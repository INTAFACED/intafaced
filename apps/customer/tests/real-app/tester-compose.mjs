// The tester profile's compose wiring as J-home-ia-11's files read it: the compose files, the seed service's block and
// the steps its command names, and a seed script run as the seed service runs it. Shared by J-home-ia-11.pw.mjs and
// J-home-ia-11-compose.pw.mjs (the fresh compose up, split out so no one file holds the journey's whole time).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './stack.mjs';

export const COMPOSE = ['docker-compose.yml', 'docker-compose.apps.yml'];

/** The `seed` service's block in the compose files, as text (no YAML parser in the tree), or null when there is none. */
export function seedService() {
  for (const name of COMPOSE) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    const match = /^ {2}seed:\n((?: {4}.*\n|\s*\n)+)/m.exec(readFileSync(file, 'utf8'));
    if (match) return { file: name, block: match[1] };
  }
  return null;
}

/**
 * A seed script run as the seed service runs it: { status, out }, with out holding both streams, instead of throwing on a
 * refusal. `timeout` caps the run (2 minutes by default); a killed run has no status and counts as failed.
 */
export function run(script, args, env, { timeout = 120_000 } = {}) {
  const base = { ...process.env };
  delete base.APP_ENV;
  delete base.NODE_ENV;
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  return { status: res.status ?? 1, out };
}

/** The steps the seed service's command names (its compose `command` list), in order. */
export const composeSteps = (block) => [...block.matchAll(/'(local-[a-z-]+\.mjs [a-z]+)'/g)].map((m) => m[1]);

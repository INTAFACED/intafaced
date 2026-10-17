import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Workspace packages expose types from dist/, which a fresh install does not
 * contain. `tsc` then reports TS2307 for every `@intafaced/*` import, and the
 * missing types cascade into implicit-any errors. Turbo's typecheck task
 * builds dependencies first; `pnpm run typecheck` in this package does not,
 * so build them when the declaration files are absent.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const declarations = ['packages/config/dist/index.d.ts', 'packages/db/dist/index.d.ts', 'packages/safe-regex/dist/index.d.ts'];

if (declarations.every((rel) => existsSync(join(root, rel)))) {
  process.exit(0);
}

const built = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@intafaced/events^...'], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(built.status === null ? 1 : built.status);

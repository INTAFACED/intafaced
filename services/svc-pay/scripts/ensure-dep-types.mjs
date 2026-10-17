import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Workspace packages expose types from dist/, which a fresh install does not
 * contain. `tsc` then reports TS2307 for every `@intafaced/*` import. Turbo's
 * typecheck task builds dependencies first; `pnpm run typecheck` in this
 * package does not, so build them when the declaration files are absent.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const declarations = [
  'packages/auth/dist/index.d.ts',
  'packages/config/dist/index.d.ts',
  'packages/config/dist/screening.d.ts',
  'packages/contracts/dist/index.d.ts',
  'packages/contracts/dist/founder-change-hash.d.ts',
  'packages/db/dist/index.d.ts',
  'packages/events/dist/index.d.ts',
  'packages/i18n/dist/index.d.ts',
  'packages/ledger-client/dist/index.d.ts',
  'packages/telemetry/dist/index.d.ts',
];

if (declarations.every((rel) => existsSync(join(root, rel)))) {
  process.exit(0);
}

const built = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@intafaced/svc-pay^...'], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(built.status === null ? 1 : built.status);

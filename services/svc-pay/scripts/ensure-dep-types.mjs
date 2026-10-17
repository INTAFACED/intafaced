/**
 * Workspace packages publish types from dist/. `tsc` cannot see them until
 * those packages have been built. A partial list used to treat the build as
 * done once `@intafaced/ledger-client` and its neighbours existed, so
 * `@intafaced/venue-contracts` and `@intafaced/venue-adapter` stayed missing.
 * `tsc` then reported TS2307, and `instanceof` on those imports could not
 * narrow `error` (TS18046).
 *
 * Every direct `@intafaced/*` dependency is checked. When a declaration file
 * is already on disk, this does nothing. Turbo's typecheck task already
 * builds dependencies first; `pnpm run build` and `pnpm run typecheck` here
 * do not.
 *
 * Run with cwd = the service directory (pnpm does that).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const serviceDir = process.cwd();
const root = resolve(serviceDir, '../..');
const pkg = JSON.parse(readFileSync(join(serviceDir, 'package.json'), 'utf8'));

function declarationFile(name) {
  const pkgPath = join(serviceDir, 'node_modules', name, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const dep = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const types = typeof dep.types === 'string' ? dep.types : typeof dep.exports?.['.']?.types === 'string' ? dep.exports['.'].types : null;
  if (!types) return null;
  return resolve(pkgPath, '..', types);
}

const workspaceDeps = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@intafaced/'));
const missing = workspaceDeps.some((name) => {
  const file = declarationFile(name);
  return file == null || !existsSync(file);
});

if (!missing) {
  process.exit(0);
}

// Name selector, not a directory selector: `./services/svc-pay^...` drops the
// dependency walk and builds this package alone. `@intafaced/svc-pay^...`
// builds dependencies and not this package, so this script cannot recurse.
const result = spawnSync(
  'pnpm',
  ['--dir', root, '--filter', `${pkg.name}^...`, '--workspace-concurrency=1', '--if-present', 'run', 'build'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

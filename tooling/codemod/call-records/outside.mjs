// A schema's name that is not the service's own: a generic helper's type parameter, or an import from a package.
// closure.mjs asks here whether the record file may read it and, when it may not, what the run names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from './ast.mjs';

/** The type parameters a node declares anywhere inside it (`function f<T>`, `type A<T> = ...`): names it binds itself. */
export function typeParametersIn(node) {
  const names = new Set();
  walk(node, (n) => {
    for (const tp of n.typeParameters?.params ?? []) if (tp.name?.name) names.add(tp.name.name);
  });
  return names;
}

const manifests = new Map();
function manifest(file) {
  if (!manifests.has(file)) {
    let json = null;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
    manifests.set(file, json);
  }
  return manifests.get(file);
}
const depsOf = (m) => ({ ...m?.dependencies, ...m?.peerDependencies });

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
const packageOf = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * Whether a record in @intafaced/contracts may import `spec`: null when contracts depends on its package (its
 * package.json), else the reason it stays: the package depends on contracts itself (a cycle), or contracts does not list it.
 */
export function packageRefusal(repo, spec) {
  const pkg = packageOf(spec);
  if (pkg in depsOf(manifest(join(repo, 'packages/contracts/package.json')))) return null;
  const local = pkg.startsWith('@intafaced/') ? manifest(join(repo, 'packages', pkg.slice('@intafaced/'.length), 'package.json')) : null;
  if (local && '@intafaced/contracts' in depsOf(local)) return "which depends on @intafaced/contracts, so contracts can't import it";
  return 'which contracts does not depend on';
}

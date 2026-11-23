// An import loop between a service's shared schema file and one of its record files. A group's new helpers land in the
// shared file, which imports whatever they read from a record file (a helper an earlier run or a name clash kept beside
// its record). When that record file imports the shared file, each needs the other's const while it is still loading:
// svc-bank's `figures` (new, sent to bank-call-schemas) read `signed` (already in bank-ops-procedures), whose new record
// read `figures`, and loading either file threw "Cannot access 'figures' before initialization". Such a group's new
// helpers land beside its records instead, so the shared file never imports a file that imports it.
import { basename } from 'node:path';

const specOf = (file) => `./${basename(file).replace(/\.ts$/, '.js')}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Does this text import from `file`, by its sibling specifier (`./bank-call-schemas.js`)? */
export const importsSibling = (src, file) => new RegExp(`from ['"]${esc(specOf(file))}['"]`, 'u').test(src ?? '');

/**
 * The first helper whose home would close a loop if this group's new helpers went to the shared file, or undefined.
 * `homes` are the record files that hold a helper the group reads and does not add; `file` is the group's own record
 * file, which imports the shared file as soon as its records read a helper sent there; `textOf` reads a file as the run
 * has written it so far.
 */
export function sharedLoop({ fresh, homes, file, shared, textOf }) {
  if (!fresh.length) return undefined;
  for (const [name, home] of homes) {
    if (home === shared) continue;
    if (home === file || importsSibling(textOf(home), shared)) return name;
  }
  return undefined;
}

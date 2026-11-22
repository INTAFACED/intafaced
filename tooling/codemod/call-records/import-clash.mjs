// A record file the codemod appends to may already bind a name the new records read from somewhere else: svc-pay's
// `assetIdSchema` (`z.string().min(1).max(16)`, pay-call-schemas) beside the branded `assetIdSchema` the file
// imported from asset-id. Imports merge by name, so the new record would read the old one and lose its checks. Such a
// record stays where it is, named, and the others go on.
import { basename } from 'node:path';

/** What each name a file's text binds stands for: `<spec>#<imported>` for an import, `''` for its own declaration. */
export function boundNames(src) {
  const out = new Map();
  for (const m of src.matchAll(/^import (?:type )?\{([^}]*)\} from '([^']+)';/gm))
    for (const part of m[1]
      .split(',')
      .map((x) => x.trim().replace(/^type /, ''))
      .filter(Boolean)) {
      const [imported, local = imported] = part.split(/\s+as\s+/);
      out.set(local, `${m[2]}#${imported}`);
    }
  for (const m of src.matchAll(/^(?:export )?(?:const|let|function|type|interface|enum) (\w+)/gm)) out.set(m[1], '');
  return out;
}

/** What a record's closure reads each name as, in a record file of contracts: `<spec>#<imported>`. */
export function wantedNames(closure, shared) {
  const out = new Map();
  const local = (file) => `./${basename(file).replace(/\.ts$/, '.js')}`;
  for (const [name, c] of closure.fromContracts) out.set(name, `${local(c.file)}#${c.imported}`);
  for (const [spec, names] of closure.fromPackages)
    for (const n of names) {
      const [imported, as = imported] = n.replace(/^type /, '').split(/\s+as\s+/);
      if (!(spec === 'zod' && as === 'z')) out.set(as, `${spec}#${imported}`);
    }
  for (const m of closure.moved) out.set(m.name, `${local(shared)}#${m.name}`);
  return out;
}

/** The first name `src` binds to something other than what `wanted` reads it as: `{ name, has, wants }`, or undefined. */
export function importClash(src, wanted, file) {
  const bound = boundNames(src);
  for (const [name, wants] of wanted) {
    const has = bound.get(name);
    if (has === undefined || has === wants) continue;
    // A helper the codemod moved here before, read again by a later record, is the same declaration.
    if (has === '' && wants.endsWith(`/${basename(file).replace(/\.ts$/, '.js')}#${name}`)) continue;
    return { name, has: has || 'its own declaration', wants };
  }
  return undefined;
}

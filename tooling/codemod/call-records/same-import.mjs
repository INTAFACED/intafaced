// A helper a record file already imports from another contracts file, declared there as the router writes it. svc-bank's
// routers share one `amountString` (router/shared.ts), which an earlier run copied into bank-earn-procedures and, later,
// into the shared file; bank-loans-procedures imports the first copy. A new record there that reads the router's
// `amountString` reads that import: taking the shared file's copy beside it would bind the name twice, and the codemod
// left `loans.open`, `loans.repay` and four more by name for a clash between two copies of one text.
import { dirname, join } from 'node:path';
import { parseSync } from 'oxc-parser';

/** `name -> file` for each name `src` imports, under its own name, from a sibling file (`./x.js`). */
function siblingImports(file, src) {
  const out = new Map();
  for (const stmt of parseSync('imports.ts', src).program.body) {
    if (stmt.type !== 'ImportDeclaration' || !stmt.source.value.startsWith('./')) continue;
    for (const sp of stmt.specifiers ?? []) {
      const imported = sp.imported?.name ?? sp.imported?.value;
      if (sp.type === 'ImportSpecifier' && imported === sp.local.name)
        out.set(imported, join(dirname(file), stmt.source.value.slice(2).replace(/\.js$/, '.ts')));
    }
  }
  return out;
}

/**
 * For each helper of `moved` the record file (`src`, its text so far) imports from a sibling that declares it with the
 * same text: its key to that sibling. A helper the run already placed in that same sibling is left to `movedTo`.
 */
export function sameImports(file, src, moved, movedTo, keyOf, declaresSame) {
  const out = new Map();
  if (src === undefined) return out;
  const imports = siblingImports(file, src);
  for (const m of moved) {
    const home = m.q ? imports.get(m.name) : undefined;
    if (!home || home === movedTo.get(keyOf(m)) || !declaresSame(home, m.name, m.text)) continue;
    out.set(keyOf(m), home);
  }
  return out;
}

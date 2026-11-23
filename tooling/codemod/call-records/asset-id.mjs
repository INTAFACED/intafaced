// An `assetId` field the codemod writes into contracts starts from `assetIdSchema` (packages/contracts/src/asset-id.ts),
// as `garden/asset-id-schema` asks of every contract: a router's `assetId: z.string().min(1)` lands as
// `assetId: assetIdSchema.min(1)`. The brand is type-only and accepts exactly what `z.string()` accepts, so the wire and
// the record's samples are unchanged.
import { parseSync } from 'oxc-parser';
import { walk } from './ast.mjs';

const SPEC = './asset-id.js';

/** The `z.string()` call an `assetId` field's value is chained from, or undefined when it starts elsewhere. */
function zStringRoot(node) {
  let n = node;
  while (n) {
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (
        c?.type === 'MemberExpression' &&
        !c.computed &&
        c.object?.type === 'Identifier' &&
        c.object.name === 'z' &&
        c.property?.name === 'string'
      )
        return n.arguments.length === 0 ? n : undefined;
      n = c?.type === 'MemberExpression' ? c.object : null;
    } else if (n.type === 'MemberExpression') n = n.object;
    else return undefined;
  }
  return undefined;
}

/** Each `assetId` field of `src` written from `z.string()`: the `z.string()` call to replace, in source order. */
export function unbranded(src) {
  const out = [];
  walk(parseSync('contract.ts', src).program, (n) => {
    if (n.type !== 'Property') return;
    const k = n.key;
    const name = k?.type === 'Identifier' ? k.name : k?.type === 'Literal' ? k.value : undefined;
    const root = name === 'assetId' ? zStringRoot(n.value) : undefined;
    if (root) out.push(root);
  });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * `src` with every unbranded `assetId` field after the first `keep` (the ones the file already had: the codemod only
 * appends) started from `assetIdSchema`, imported from './asset-id.js'. A file that binds `assetIdSchema` to something
 * else keeps its fields as they are.
 */
export function brandAssetIds(src, keep = 0) {
  const todo = unbranded(src).slice(keep);
  if (!todo.length) return src;
  const { program } = parseSync('contract.ts', src);
  let bound;
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') {
      for (const sp of st.specifiers ?? []) if (sp.local.name === 'assetIdSchema') bound = st.source.value === SPEC ? 'ours' : 'other';
      continue;
    }
    const decl = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (decl.type === 'VariableDeclaration' && decl.declarations.some((d) => d.id?.name === 'assetIdSchema')) bound = 'other';
  }
  if (bound === 'other') return src;
  let out = src;
  for (const call of [...todo].reverse()) out = `${out.slice(0, call.start)}assetIdSchema${out.slice(call.end)}`;
  if (bound !== 'ours') {
    const imports = [...out.matchAll(/^import [^;]+;\n/gm)];
    const at = imports.length ? imports.at(-1).index + imports.at(-1)[0].length : 0;
    out = `${out.slice(0, at)}import { assetIdSchema } from '${SPEC}';\n${out.slice(at)}`;
  }
  return out;
}

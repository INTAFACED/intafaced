// The oxlint plugin tooling/lint/unused-vars-codemod.mjs runs with --fix. It fixes only the eslint(no-unused-vars)
// findings named in the file UNUSED_CODEMOD_TARGETS points at ({ "<abs file>": [{ kind, name, line }] }), and only
// the four kinds whose removal cannot change what the program does:
//   import    an unused name in an import that keeps another name (the module is still loaded, in the same place),
//             or a whole `import type` (erased) or import of a Node builtin (no side effects to lose);
//   catch     `catch (e)` whose `e` is never read becomes `catch`;
//   function  an unused function declaration (hoisted, never called), with the comment lines directly above it;
//   type      an unused type alias or interface (erased), with the comment lines directly above it.
// A whole value import of any other module is left: dropping it would skip that module's top-level code.
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

const BUILTIN = new Set(builtinModules);
// Only `node:` names: a bare `events` or `buffer` in a browser app resolves to an npm polyfill with its own top-level code.
const isBuiltin = (spec) => spec.startsWith('node:') && (BUILTIN.has(spec) || BUILTIN.has(spec.slice(5).split('/')[0]));

let cache = null;
function targetsFor(file) {
  if (!cache) cache = process.env.UNUSED_CODEMOD_TARGETS ? JSON.parse(readFileSync(process.env.UNUSED_CODEMOD_TARGETS, 'utf8')) : {};
  return cache[file] ?? [];
}

/** The start of the run of comment lines directly above `node` (no blank line between), or the node's own line start. */
function removalStart(sc, node, withComments) {
  const text = sc.text;
  let start = text.lastIndexOf('\n', node.start - 1) + 1;
  if (text.slice(start, node.start).trim() !== '') return node.start; // something else shares the line
  if (!withComments) return start;
  const comments = (sc.getCommentsBefore?.(node) ?? []).slice().reverse();
  for (const c of comments) {
    const lineStart = text.lastIndexOf('\n', c.start - 1) + 1;
    const between = text.slice(c.end, start);
    if (text.slice(lineStart, c.start).trim() !== '' || !/^[ \t]*\n?[ \t]*$/u.test(between)) break;
    if (lineStart === 0) break; // the file's own header comment stays
    start = lineStart;
  }
  return start;
}
/** The end of the node's line, newline included, when nothing else follows it there. */
function removalEnd(sc, node) {
  const text = sc.text;
  const nl = text.indexOf('\n', node.end);
  const end = nl < 0 ? text.length : nl + 1;
  return text.slice(node.end, end).trim() === '' ? end : node.end;
}

const specText = (s) => {
  if (s.type === 'ImportDefaultSpecifier') return s.local.name;
  if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
  const imported = s.imported.type === 'Literal' ? JSON.stringify(s.imported.value) : s.imported.name;
  return `${s.importKind === 'type' ? 'type ' : ''}${imported === s.local.name ? imported : `${imported} as ${s.local.name}`}`;
};

export default {
  meta: { name: 'unused-codemod' },
  rules: {
    safe: {
      meta: { fixable: 'code' },
      create(context) {
        const file = context.filename ?? context.getFilename();
        const targets = targetsFor(file);
        if (!targets.length) return {};
        const sc = context.sourceCode;
        const wanted = (kind, name, line) => targets.some((t) => t.kind === kind && t.name === name && t.line === line);
        // An import keeps the comments above it (they may head a group); a declaration takes its own along.
        const removeWhole = (node, why, withComments = true) =>
          context.report({
            node,
            message: why,
            fix: (f) => f.removeRange([removalStart(sc, node, withComments), removalEnd(sc, node)]),
          });
        return {
          ImportDeclaration(node) {
            const unused = node.specifiers.filter((s) => wanted('import', s.local.name, s.local.loc.start.line));
            if (!unused.length) return;
            const source = sc.text.slice(node.source.start, node.source.end);
            const body = sc.text.slice(node.start, node.end);
            if ((node.attributes ?? []).length || /\/\/|\/\*/u.test(body.replace(source, ''))) return;
            const kept = node.specifiers.filter((s) => !unused.includes(s));
            if (!kept.length) {
              // `import type` is erased; `import { type A }` is not (verbatimModuleSyntax keeps it as `import {} from`).
              if (node.importKind === 'type' || isBuiltin(node.source.value)) removeWhole(node, 'unused import', false);
              return;
            }
            const def = kept.filter((s) => s.type !== 'ImportSpecifier').map(specText);
            const named = kept.filter((s) => s.type === 'ImportSpecifier').map(specText);
            const clause = [...def, ...(named.length ? [`{ ${named.join(', ')} }`] : [])].join(', ');
            const text = `import ${node.importKind === 'type' ? 'type ' : ''}${clause} from ${source};`;
            context.report({ node, message: 'unused import names', fix: (f) => f.replaceTextRange([node.start, node.end], text) });
          },
          CatchClause(node) {
            const p = node.param;
            if (p?.type !== 'Identifier' || !wanted('catch', p.name, p.loc.start.line)) return;
            context.report({
              node: p,
              message: 'unused catch binding',
              fix: (f) => f.replaceTextRange([node.start, node.body.start], 'catch '),
            });
          },
          FunctionDeclaration(node) {
            if (!node.id || !wanted('function', node.id.name, node.id.loc.start.line)) return;
            const parent = node.parent;
            if (parent?.type !== 'Program' && parent?.type !== 'BlockStatement') return; // exported or labelled: leave
            const siblings = parent.body ?? [];
            if (siblings.some((s) => s !== node && s.type === 'TSDeclareFunction' && s.id?.name === node.id.name)) return; // overloads
            removeWhole(node, 'unused function');
          },
          TSTypeAliasDeclaration(node) {
            // Not in a `declare module` or namespace block, whose declarations are exported implicitly.
            if (node.parent?.type !== 'Program' && node.parent?.type !== 'BlockStatement') return;
            if (wanted('type', node.id.name, node.id.loc.start.line)) removeWhole(node, 'unused type alias');
          },
          TSInterfaceDeclaration(node) {
            if (node.parent?.type !== 'Program' && node.parent?.type !== 'BlockStatement') return;
            if (wanted('type', node.id.name, node.id.loc.start.line)) removeWhole(node, 'unused interface');
          },
        };
      },
    },
  },
};

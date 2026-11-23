// garden/no-cross-feature-import: a feature exposes one entry, its folder's `index` file, and another feature imports only
// that entry. An import that reaches a file inside another feature ties the two together so that neither can move, split
// or change its inside alone. A feature is a folder directly under one of these roots, and two features are compared only
// within one root:
//   - apps/customer/src/features/<feature>/
//   - apps/admin/src/components/<area>/, apps/admin/src/lib/<area>/, apps/admin/src/app/(console)/<route>/
// A file directly in a root (`apps/admin/src/components/chip.tsx`) belongs to no feature, and a file outside every feature
// (a screen, `shared/`) is not judged. The import is resolved, not read as text: a relative path from the importing file,
// or the admin app's `@/` alias, is followed to the folder or file it names. `import`, `export … from`, `import('…')` and
// `typeof import('…')` count, type-only ones too; test files count like any other file. The entry is the feature's folder itself or its `index`
// file; `<feature>/index` deeper down is inside.
// Main holds none (tooling/shape/feature-entry.mjs rewrote the last to their entries): judged by the lint ratchet, each
// file's ceiling is main's zero and a file a change adds starts at zero (tooling/ci/lint-ratchet.mjs, tooling/lint/ratchet.json
// failInAddedFiles). `node tooling/lint/count-rule.mjs garden/no-cross-feature-import` prints any there are and where.
import { dirname, posix } from 'node:path';

// The app's src folder, and inside it the roots whose child folders are features.
const APP = /^(.*\/apps\/(customer|admin)\/src)\//u;
const ROOTS = { customer: ['features'], admin: ['components', 'lib', 'app/(console)'] };
const ENTRY = /^index(?:\.[cm]?[jt]sx?)?$/u;

/** The feature a resolved path lies in: { root, key, rest } with rest the path inside the feature folder, or undefined. */
function featureOf(src, roots, path) {
  for (const root of roots) {
    const base = `${src}/${root}/`;
    if (!path.startsWith(base)) continue;
    const [name, ...rest] = path.slice(base.length).split('/');
    // A file directly in the root is no feature; a feature folder is named by a path that goes on, or by the folder itself.
    if (!name || (rest.length === 0 && /\.[cm]?[jt]sx?$/u.test(name))) return undefined;
    return { root, key: `${root}/${name}`, rest: rest.join('/') };
  }
  return undefined;
}

const noCrossFeatureImport = {
  meta: { type: 'suggestion', docs: { description: "A feature imports another feature only through that feature's entry." } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    const app = APP.exec(file);
    if (!app) return {};
    const [, src, name] = app;
    const roots = ROOTS[name];
    const own = featureOf(src, roots, file);
    if (!own) return {};
    const check = (source) => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
      const spec = source.value;
      let target;
      if (spec.startsWith('./') || spec.startsWith('../')) target = posix.join(dirname(file), spec);
      else if (spec.startsWith('@/')) target = posix.join(src, spec.slice(2));
      else return;
      const other = featureOf(src, roots, target);
      if (!other || other.root !== own.root || other.key === own.key || other.rest === '' || ENTRY.test(other.rest)) return;
      context.report({
        node: source,
        message:
          `\`${spec}\` reaches inside the feature \`${other.key}\`: import what it exposes from its entry, ` +
          `\`${other.key}/index.ts\` (export the piece there if it isn't yet), or move the piece both use out of the feature`,
      });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source ?? node.argument?.literal ?? node.argument),
    };
  },
};

export const crossFeatureImportRules = { 'no-cross-feature-import': noCrossFeatureImport };

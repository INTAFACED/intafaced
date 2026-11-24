// garden/compose-only: a file that only composes other files' parts declares nothing of its own. Switched on per file in
// .oxlintrc.json `overrides`, with the names it may declare (`names`) and the objects that may hold only spreads of what
// it imports (`spreads`). The bank's contracts.ts is the first: every bank journey once appended its shapes and
// procedures there, and parallel builds collided in it; a shape goes in its area's contracts-<area>.ts instead.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const FIX =
  'put the shape in its area file (contracts-<area>.ts) and the call in a record in @intafaced/contracts; this file only ' +
  'composes the areas';

/** The names one top-level statement declares, with the node to report on. */
function declared(statement) {
  const d =
    statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
  if (!d) return [];
  if (d.type === 'VariableDeclaration')
    return d.declarations.flatMap((v) => (v.id?.type === 'Identifier' ? [[v.id.name, v, v.init]] : [['(a destructured value)', v, null]]));
  if (
    [
      'FunctionDeclaration',
      'ClassDeclaration',
      'TSTypeAliasDeclaration',
      'TSInterfaceDeclaration',
      'TSEnumDeclaration',
      'TSModuleDeclaration',
    ].includes(d.type)
  )
    return [[d.id?.name ?? d.id?.value ?? '(a nameless declaration)', d, null]];
  return [];
}
const unwrap = (n) => (['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(n?.type) ? unwrap(n.expression) : n);

const composeOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'A file that composes other files declares nothing of its own beyond the names it is given.' },
    schema: [
      {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' } },
          spreads: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { names = [], spreads = [] } = context.options[0] ?? {};
    const allowed = new Set([...names, ...spreads]);
    return {
      Program(program) {
        const imported = new Set(
          program.body.filter((s) => s.type === 'ImportDeclaration').flatMap((s) => s.specifiers.map((x) => x.local.name)),
        );
        const seen = new Set();
        for (const statement of program.body)
          for (const [name, node, init] of declared(statement)) {
            seen.add(name);
            if (!allowed.has(name)) {
              context.report({ node, message: `\`${name}\` is declared here, in a file that only composes: ${FIX}` });
              continue;
            }
            if (!spreads.includes(name)) continue;
            const object = unwrap(init);
            if (object?.type !== 'ObjectExpression') {
              context.report({ node, message: `\`${name}\` must be an object of spreads of the areas it imports: ${FIX}` });
              continue;
            }
            for (const p of object.properties)
              if (p.type !== 'SpreadElement' || p.argument?.type !== 'Identifier' || !imported.has(p.argument.name))
                context.report({ node: p, message: `\`${name}\` lists something inline, not a spread of an imported area: ${FIX}` });
          }
        for (const name of spreads)
          if (!seen.has(name))
            context.report({ node: program, message: `\`${name}\` is not declared in this file: the composed object is gone` });
      },
    };
  },
};

export const composeOnlyRules = { 'compose-only': composeOnly };

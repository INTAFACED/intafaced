// garden/test-postgres-helper: a test starts its own Postgres only through testPostgres() from
// '@intafaced/db/test-postgres', whose data lives in memory and skips crash durability, as CI's service database does.
// 286 test files each built `new PostgreSqlContainer('postgres:16-alpine')` themselves, on disk with full durability:
// on a loaded machine one took 9-257 s from start to ready against 4-8 s in memory, and 63 Postgres processes once
// waited on the disk together (intafaced#9610). The rule refuses the container package anywhere but the helper, so
// neither a direct `new PostgreSqlContainer(`, an alias nor a dynamic import gets past it, and a bare testcontainers
// GenericContainer on a postgres image.
const HELPER_FILE = /(?:^|\/)packages\/db\/src\/test-postgres\.ts$/u;
const PACKAGE = '@testcontainers/postgresql';
const FIX = "start the test's Postgres with testPostgres() from '@intafaced/db/test-postgres' (its data in memory, crash durability off)";

const isPostgresImage = (n) => n?.type === 'Literal' && typeof n.value === 'string' && /^(?:[\w.-]+\/)*postgres(?::|$)/u.test(n.value);

const testPostgresHelper = {
  meta: { type: 'problem', docs: { description: 'A test starts its own Postgres only through testPostgres().' } },
  create(context) {
    if (HELPER_FILE.test(context.filename ?? context.getFilename())) return {};
    const fromPackage = (node, source) => {
      if (source?.type === 'Literal' && source.value === PACKAGE)
        context.report({ node, message: `${PACKAGE} is used only inside packages/db/src/test-postgres.ts: ${FIX}` });
    };
    return {
      ImportDeclaration: (node) => fromPackage(node, node.source),
      ImportExpression: (node) => fromPackage(node, node.source),
      ExportNamedDeclaration: (node) => fromPackage(node, node.source),
      ExportAllDeclaration: (node) => fromPackage(node, node.source),
      CallExpression(node) {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'require') fromPackage(node, node.arguments[0]);
      },
      NewExpression(node) {
        const name = node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name;
        if (name === 'PostgreSqlContainer')
          context.report({ node, message: `a test's own \`new PostgreSqlContainer(\` runs on disk with full durability: ${FIX}` });
        else if (name === 'GenericContainer' && isPostgresImage(node.arguments[0]))
          context.report({ node, message: `a GenericContainer on a postgres image runs on disk with full durability: ${FIX}` });
      },
    };
  },
};

export const testPostgresRules = { 'test-postgres-helper': testPostgresHelper };

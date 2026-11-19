// garden/no-source-text-test: a test checks what code does, never what its source text says. A test that reads a file under
// services/*/src, apps/*/src or packages/*/src as text (`readFileSync(join(ROOT, 'services/svc-x/src/router.ts'), 'utf8')`)
// and asserts on its words breaks on every move of that code and stays green when the behaviour it meant breaks. Call the
// code and assert on its answer, its records or its events; a rule about imports belongs in a lint (this plugin) or
// tooling/ci/boundary-scan.mjs.
// Counted: `readFileSync`/`readFile` in a test file whose path lands in a src tree on a code file (.ts, .tsx, .mjs, …) or a
// folder: the path as written (`join(ROOT, 'services/svc-x/src/a.ts')`), else as read from the test's own folder
// (`join(HERE, '..', 'router.ts')`, `new URL('./a.ts', import.meta.url)`). The path is read from its literals, through
// `join`, `resolve`, `new URL` and `const` names. Migrations (.sql), compose files, JSON and docs are data and are not counted.
// The pattern is common, so the rule fails only when a change adds one: judged by the lint ratchet, the copies on main are
// each file's ceiling and a file the change adds starts at zero (tooling/ci/lint-ratchet.mjs, tooling/lint/ratchet.json
// failInAddedFiles). `node tooling/lint/count-rule.mjs garden/no-source-text-test` prints how many are left and where.
import { posix } from 'node:path';

const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const SRC_TREE = /(?:^|\/)(?:services|apps|packages)\/[^/]+\/src(?:\/|$)/u;
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/u;
const ANY_EXT = /\.[A-Za-z0-9]+$/u;
const READS = new Set(['readFileSync', 'readFile']);
const FIX =
  'a test reads no source text: call the code and assert on its answer, records or events; a rule about what code ' +
  'imports or names is a lint in tooling/lint/oxlint-plugin-garden or a check in tooling/ci/boundary-scan.mjs';

/** The string pieces a path expression is built from, in order, following `const` names up to a few steps. */
function pieces(node, consts, depth = 0) {
  if (!node || depth > 4) return [];
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'TemplateLiteral':
      return node.quasis.map((q) => q.value?.cooked ?? q.value?.raw ?? '').filter(Boolean);
    case 'BinaryExpression':
      return [...pieces(node.left, consts, depth), ...pieces(node.right, consts, depth)];
    case 'CallExpression':
    case 'NewExpression':
      return node.arguments.flatMap((a) => pieces(a, consts, depth));
    case 'Identifier':
      return consts.has(node.name) ? pieces(consts.get(node.name), consts, depth + 1) : [];
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return pieces(node.expression, consts, depth);
    default:
      return [];
  }
}

const noSourceTextTest = {
  meta: { type: 'suggestion', docs: { description: 'A test checks behaviour, never the text of a source file.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!TEST_FILE.test(file)) return {};
    const consts = new Map();
    const reads = [];
    return {
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier' && node.init) consts.set(node.id.name, node.init);
      },
      CallExpression(node) {
        const c = node.callee;
        const name = c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : undefined;
        if (name && READS.has(name) && node.arguments.length > 0) reads.push(node);
      },
      'Program:exit'() {
        for (const node of reads) {
          const path = pieces(node.arguments[0], consts).join('/').replace(/\/+/gu, '/');
          if (!path) continue;
          // A path through a src tree as written (`join(ROOT, 'services/svc-x/src/a.ts')`), else as read from this test's folder.
          const where = SRC_TREE.test(path) ? path : posix.join(posix.dirname(file), path);
          const name = where.split('/').pop() ?? '';
          const source = SRC_TREE.test(where) && (CODE_EXT.test(name) || !ANY_EXT.test(name));
          if (source) context.report({ node, message: `this test reads source text (\`${path}\`): ${FIX}` });
        }
      },
    };
  },
};

export const sourceTextTestRules = { 'no-source-text-test': noSourceTextTest };

// Four mistakes builders keep copying from the code around them, each a rule whose message names the fix. Judged by the
// lint ratchet (tooling/ci/lint-ratchet.mjs): a new copy fails, the copies on main are the baseline the garden cleans up.
// A copy kept on purpose carries `// oxlint-disable-next-line garden/<rule> -- why` on its line.

const fileOf = (context) =>
  String(context.filename ?? context.getFilename())
    .split('\\')
    .join('/');
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
const JOURNEY = /(?:^|\/)apps\/customer\/tests\/real-app\/.+\.mjs$/u;
const SERVICE = /(?:^|\/)services\/[^/]+\//u;

/** A string literal's text, or a template literal's with each `${…}` as `X`; null for anything else. */
const textOf = (n) => {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('X');
  return null;
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-class-selector: a journey finds an element by its CSS class (`page.locator('.st-row')`). A class is styling:
// it changes with the look (the lit kit renames them room by room) and the step goes red on a change nobody made to the
// behaviour. A person finds it by its role, label or text.
const SELECTOR_CALLS = new Set([
  'locator',
  '$',
  '$$',
  '$eval',
  '$$eval',
  'waitForSelector',
  'querySelector',
  'querySelectorAll',
  'closest',
]);
const OTHER_ENGINE = /^\s*(?:text|xpath|id|data-testid|internal:[\w-]+)=|^\s*\/\//u;

/** True when a CSS selector names a class: `.x`, `div.x`, `[a].x`, `:not(.x)`, outside attribute values and strings. */
export function namesClass(selector) {
  return selector
    .split('>>')
    .filter((part) => !OTHER_ENGINE.test(part))
    .some((part) => {
      const bare = part
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, '""')
        .replace(/\[[^\]]*\]/gu, '[]')
        .replace(/\\./gu, '_');
      return /(?:^|[\s>+~,(*\]\w-])\.-?[_a-zA-Z]/u.test(bare);
    });
}

const noClassSelector = {
  meta: { type: 'problem', docs: { description: 'A journey finds an element the way a person does, never by its CSS class.' } },
  create(context) {
    if (!JOURNEY.test(fileOf(context))) return {};
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c?.type !== 'MemberExpression' || c.computed || !SELECTOR_CALLS.has(c.property?.name)) return;
        const selector = textOf(node.arguments[0]);
        if (selector === null || !namesClass(selector)) return;
        context.report({
          node: node.arguments[0],
          message:
            `\`${c.property.name}('${selector}')\` finds this by a CSS class, which changes with the look: find it the way a ` +
            "person does, `getByRole('row', { name, exact: true })`, `getByLabel`, `getByText`; an element with no role or " +
            "name gets a `data-testid` in the room and `getByTestId('…')` here",
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/switch-needs-default: a switch over string cases with no `default` skips a value nobody listed. When a new
// state joins the union, the switch still compiles and the new state falls through doing nothing.
// A switch that ends a function declared to return a value, with every arm returning or throwing, is already checked:
// TypeScript refuses it ("lacks ending return statement") once a member has no arm.
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MAY_RETURN_NOTHING = /(?:^|\|)\s*(?:void|undefined|unknown|any)\s*(?:\||$)/u;
const ends = (s) => s?.type === 'ReturnStatement' || s?.type === 'ThrowStatement' || (s?.type === 'BlockStatement' && ends(s.body.at(-1)));
function checkedByReturnType(node, context) {
  const block = node.parent;
  const fn = block?.parent;
  if (block?.type !== 'BlockStatement' || block.body.at(-1) !== node || !FUNCTIONS.has(fn?.type) || fn.body !== block) return false;
  if (!fn.returnType) return false;
  let declared = context.sourceCode
    .getText(fn.returnType.typeAnnotation ?? fn.returnType)
    .replace(/^\s*:\s*/u, '')
    .trim();
  if (fn.async) declared = /^Promise<([\s\S]*)>$/u.exec(declared)?.[1] ?? declared;
  if (MAY_RETURN_NOTHING.test(declared)) return false;
  return node.cases.every((k) => k.consequent.length === 0 || ends(k.consequent.at(-1)));
}
const switchNeedsDefault = {
  meta: { type: 'problem', docs: { description: 'A switch over string cases in a service ends with a default arm.' } },
  create(context) {
    const file = fileOf(context);
    if (!SERVICE.test(file) || TEST_FILE.test(file)) return {};
    return {
      SwitchStatement(node) {
        if (!node.cases.length || node.cases.some((k) => k.test === null)) return;
        if (!node.cases.every((k) => textOf(k.test) !== null) || checkedByReturnType(node, context)) return;
        const subject = context.sourceCode.getText(node.discriminant);
        context.report({
          node: node.discriminant,
          message:
            `\`switch (${subject})\` has no default, so a value it does not list does nothing: over a union, end it with ` +
            `\`default: { const unhandled: never = ${subject}; throw new Error(\`unhandled \${String(unhandled)}\`); }\` so a ` +
            'new member fails to compile (services/svc-bank/src/ramps/rails.ts); over an open string, a default that refuses ' +
            'it with its typed error',
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-journey-sql-read: a journey that reads a service's tables (`sql\`SELECT … FROM academy.posts\``) checks the
// storage, not what the person or the service's own API shows, and breaks on a column rename nobody ran it against.
const READ = /^\s*(?:\(\s*)?(?:SELECT|WITH)\b/iu;
const TABLE = /\b(?:FROM|JOIN)\s+"?[a-z_][\w]*"?\."?[a-z_][\w]*/iu;
const noJourneySqlRead = {
  meta: { type: 'problem', docs: { description: "A journey checks what the page or the service's API shows, not its tables." } },
  create(context) {
    if (!JOURNEY.test(fileOf(context))) return {};
    return {
      TaggedTemplateExpression(node) {
        const text = textOf(node.quasi);
        if (text === null || !READ.test(text) || !TABLE.test(text)) return;
        context.report({
          node,
          message:
            "this journey reads a service's tables: check what the page shows, or ask the service through its own route " +
            '(the tRPC or HTTP call the room uses); a fact no route gives (a row that must be gone, a stored hash) keeps the ' +
            'read with `// oxlint-disable-next-line garden/no-journey-sql-read -- why`',
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-hand-row: a typed query (`sql<OrderRow[]>`, `.unsafe<OrderRow[]>`, `(await sql`…`) as OrderRow[]`) in a
// service claims the database's shape without checking it, and so does the hand-written `OrderRow` it names. A
// migration that renames or retypes a column leaves both compiling while the value read is wrong. Counted in two kinds,
// [sql-generic] (the query) and [row-type] (a hand-written type a query in the same file is typed with). A `…Row` type
// no query is typed with (a CSV line, a table row of an answer) is not judged.
const DERIVED = new Set(['infer', 'output', 'input']);
/** `z.infer<typeof X>` and the like: a type taken from a schema. */
const fromSchema = (t) => t?.type === 'TSTypeReference' && t.typeName?.type === 'TSQualifiedName' && DERIVED.has(t.typeName.right?.name);
const parseFix =
  'parse the rows where they are read: `const OrderRow = z.object({ … })`, `type OrderRow = z.infer<typeof OrderRow>`, ' +
  '`const rows = OrderRow.array().parse(await sql`…`)` (zod is in every service), so a column that changed fails here';
/** The type names a type node mentions (`OrderRow[]`, `Pick<OrderRow, 'id'>[]`, `[{ n: CountRow }]`). */
function typeNames(t, out = new Set()) {
  if (!t || typeof t !== 'object') return out;
  if (t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') out.add(t.typeName.name);
  for (const k in t) {
    if (k === 'parent') continue;
    const v = t[k];
    if (Array.isArray(v)) v.forEach((x) => typeNames(x, out));
    else if (v && typeof v.type === 'string') typeNames(v, out);
  }
  return out;
}
/** A query: a tagged template, or a call to `.unsafe(…)`, possibly awaited. */
const isQuery = (n) => {
  const e = n?.type === 'AwaitExpression' ? n.argument : n;
  return (
    e?.type === 'TaggedTemplateExpression' ||
    (e?.type === 'CallExpression' && e.callee?.type === 'MemberExpression' && e.callee.property?.name === 'unsafe')
  );
};
const noHandRow = {
  meta: { type: 'problem', docs: { description: "A service parses a query's rows with a schema; it never types them by hand." } },
  create(context) {
    const file = fileOf(context);
    if (!SERVICE.test(file) || TEST_FILE.test(file)) return {};
    const declared = new Map();
    const typedWith = new Set();
    const query = (node, args, label) => {
      typeNames(args, typedWith);
      context.report({
        node: args,
        message: `[sql-generic] \`${label}\` tells the compiler what the rows are without checking: drop it and ${parseFix}`,
      });
    };
    return {
      TSInterfaceDeclaration(node) {
        declared.set(node.id.name, node.id);
      },
      TSTypeAliasDeclaration(node) {
        if (!fromSchema(node.typeAnnotation)) declared.set(node.id.name, node.id);
      },
      TaggedTemplateExpression(node) {
        const args = node.typeArguments ?? node.typeParameters;
        if (args?.params?.length) query(node, args, `${context.sourceCode.getText(node.tag)}<…>`);
      },
      CallExpression(node) {
        const args = node.typeArguments ?? node.typeParameters;
        if (args?.params?.length && isQuery(node)) query(node, args, '.unsafe<…>');
      },
      TSAsExpression(node) {
        if (isQuery(node.expression)) query(node, node.typeAnnotation, 'as …');
      },
      'Program:exit'() {
        for (const [name, id] of declared)
          if (name.endsWith('Row') && typedWith.has(name))
            context.report({ node: id, message: `[row-type] \`${name}\` types a database row by hand: ${parseFix}` });
      },
    };
  },
};

export const repeatRules = {
  'no-class-selector': noClassSelector,
  'switch-needs-default': switchNeedsDefault,
  'no-journey-sql-read': noJourneySqlRead,
  'no-hand-row': noHandRow,
};

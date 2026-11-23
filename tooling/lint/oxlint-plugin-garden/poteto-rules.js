// Two patterns from poteto's "All Code Is Slop (Except Mine)" (AI Engineer Code Summit, 15 Nov 2026) that a builder
// copies from the code around it. Each fails only a new copy (tooling/ci/lint-ratchet.mjs); the copies on main are the
// baseline the garden cleans up later. Her words are on each rule; the replay that armed them is on intafaced PR "garden:
// two of poteto's patterns".

const TEST_FILE = /(\.(test|spec|testkit|render\.test)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|e2e|testing)\/)/u;

/** The path below the repo root (`apps/customer/src/...`), or null outside an app. */
const repoPath = (context) => {
  const file = String(context.filename ?? context.getFilename())
    .split('\\')
    .join('/');
  const i = file.lastIndexOf('/apps/');
  if (i >= 0) return file.slice(i + 1);
  return file.startsWith('apps/') ? file : null;
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-effect-in-product: "use effect in React ... agents are not good at using it ... our solution has been to just
// ban it in product code, and it's really only allowed in some places inside of Dune APIs" (talk 05:35-06:00).
// Our Dune APIs are the customer app's data layer and shared hooks: `src/data/` (sources read with useSyncExternalStore)
// and `src/shared/` (useResource holds the one loading effect). Rooms, screens and the shell read through them. The admin
// app's is `src/lib/hooks/` (its useResource); its desks, pages and routes read through it.
const CUSTOMER = 'apps/customer/src/';
const ADMIN_APP = 'apps/admin/src/';
const HOMES = {
  [CUSTOMER]: {
    homes: [`${CUSTOMER}data/`, `${CUSTOMER}shared/`],
    fix: 'load data with useResource (src/shared/resource.ts) or a data hook (src/data/hooks.ts)',
    keep: 'is a hook in src/shared/, as resource.ts is',
  },
  [ADMIN_APP]: {
    homes: [`${ADMIN_APP}lib/hooks/`],
    fix: "load data with useResource (src/lib/hooks/use-resource.ts), as src/components/founder-names.ts does, or in the page's server component",
    keep: 'is a hook in src/lib/hooks/, as use-resource.ts is',
  },
};
const EFFECTS = new Set(['useEffect', 'useLayoutEffect']);
const noEffectInProduct = {
  meta: {
    type: 'problem',
    docs: {
      description: 'No useEffect in app product code; effects live in the data hooks (customer src/data, src/shared; admin src/lib/hooks).',
    },
  },
  create(context) {
    const path = repoPath(context);
    const app = path && Object.keys(HOMES).find((root) => path.startsWith(root));
    if (!app || TEST_FILE.test(path) || HOMES[app].homes.some((h) => path.startsWith(h))) return {};
    const { fix, keep } = HOMES[app];
    return {
      CallExpression(node) {
        const c = node.callee;
        const name = c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : null;
        if (!EFFECTS.has(name)) return;
        context.report({
          node: c,
          message:
            `${name} in product code: ${fix}; compute a value from props or state during render; reset state with a \`key\`; ` +
            `do an action in its event handler. Something outside React kept in step (a listener, a timer, a focus) ${keep}`,
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-hand-answer-reader: "External data is untyped until parsed ... Derive types from authoritative schemas. When a
// protocol buffer, OpenAPI spec ... owns a shape, derive from it instead of hand-rolling a parallel type" (pstack
// skills/principle-type-system-discipline/SKILL.md:12-13). In the admin app a service's answer is read by the `parse`
// argument of founderCall / edgeCall (src/lib/desk/founder-call.ts). A reader written in that call, or in the same file,
// that checks the answer field by field without a schema is a hand copy of the shape the service owns.
const ADMIN = 'apps/admin/src/';
const CALLS = new Set(['founderCall', 'edgeCall']);
const PARSE_ARG = 5;
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

/** How a reader reads: `schema` when its body calls `.safeParse(` / `.parse(` / parseWith(...); `hand` when it checks the
 * answer itself (`typeof`, `instanceof`, `Array.isArray`, `Number.isInteger`, an `isX(...)` guard). A wrapper that only
 * hands the answer to another function does neither, and is judged where that function is written. */
function howItReads(fn) {
  const seen = { schema: false, hand: false };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'UnaryExpression' && n.operator === 'typeof') seen.hand = true;
    if (n.type === 'BinaryExpression' && n.operator === 'instanceof') seen.hand = true;
    if (n.type === 'CallExpression') {
      const c = n.callee;
      const prop = c?.type === 'MemberExpression' && !c.computed ? c.property?.name : null;
      if (prop === 'safeParse' || prop === 'parse' || (c?.type === 'Identifier' && c.name === 'parseWith')) seen.schema = true;
      if (prop === 'isArray' || prop === 'isInteger' || prop === 'isSafeInteger' || prop === 'isFinite') seen.hand = true;
      if (c?.type === 'Identifier' && /^is[A-Z]/u.test(c.name)) seen.hand = true;
    }
    for (const k in n) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(fn.body);
  return seen;
}
const byHand = (fn) => {
  const how = howItReads(fn);
  return how.hand && !how.schema;
};

const noHandAnswerReader = {
  meta: { type: 'problem', docs: { description: "Admin reads a service's answer through its contracts schema (parseWith)." } },
  create(context) {
    const path = repoPath(context);
    if (!path || !path.startsWith(ADMIN) || TEST_FILE.test(path)) return {};
    const local = new Map();
    const passed = [];
    const message =
      "this reads a service's answer by hand: pass `parseWith(<the answer's schema from @intafaced/contracts>)` " +
      '(src/lib/desk/founder-call.ts), as src/app/api/accounts/details/decide/route.ts does; if the service has no ' +
      'contracts schema for that answer, add one beside its output, as packages/contracts/src/pay-deposit-freezes.ts was; ' +
      'a check the answer must also pass (it names the record asked for) stays, after the parse';
    return {
      FunctionDeclaration(node) {
        if (node.id) local.set(node.id.name, node);
      },
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier' && isFn(node.init)) local.set(node.id.name, node.init);
      },
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || !CALLS.has(node.callee.name)) return;
        const arg = node.arguments[PARSE_ARG];
        if (isFn(arg)) {
          if (byHand(arg)) context.report({ node: arg, message });
        } else if (arg?.type === 'Identifier') passed.push(arg);
      },
      'Program:exit'() {
        const seen = new Set();
        for (const arg of passed) {
          const fn = local.get(arg.name);
          if (!fn || seen.has(fn) || !byHand(fn)) continue;
          seen.add(fn);
          context.report({ node: fn.id ?? fn, message: `'${arg.name}' ${message.slice(5)}` });
        }
      },
    };
  },
};

export const potetoRules = {
  'no-effect-in-product': noEffectInProduct,
  'no-hand-answer-reader': noHandAnswerReader,
};

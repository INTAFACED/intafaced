// The customer Business API's own calls (`createBusinessPayApi` in apps/customer/src/features/pay/pay-api.ts), which
// name only the call, not the service: svc-pay is the one they reach.
//   pay.query('merchant.balances', input, schema, signal?)
//   pay.mutate('payment.capture', input, schema, scope, operation, reference?)
// Each moves to the wrapper's record form beside it: `pay.queryRecord(RECORD, input, signal?)`,
// `pay.mutateRecord(RECORD, input, scope, operation, reference?)`. A `query` or `mutate` on anything else, or one that
// names its service first (`api.query('pay', 'merchant.x', ...)`), is not this shape.
import { literal, resolveRelative, text } from './ast.mjs';

const HOME = /\/apps\/customer\/src\/features\/pay\/pay-api\.ts$/;
const NAMES = new Set(['BusinessPayApi', 'createBusinessPayApi']);
/** The record form of each method, and how many arguments the by-name form takes. */
export const BUSINESS_FORMS = {
  payQuery: { fn: 'queryRecord', args: [3, 4] },
  payMutate: { fn: 'mutateRecord', args: [5, 6] },
};
const isString = (n) => (n?.type === 'Literal' && typeof n.value === 'string') || n?.type === 'TemplateLiteral';

/** Whether the file imports the Business API's type or factory from its home. */
function importsBusinessApi(p) {
  return p.program.body.some(
    (st) =>
      st.type === 'ImportDeclaration' &&
      st.source.value.startsWith('.') &&
      HOME.test(resolveRelative(p.file, st.source.value) ?? resolveRelative(p.file, `${st.source.value}.ts`) ?? '') &&
      st.specifiers.some((sp) => sp.type === 'ImportSpecifier' && NAMES.has(sp.imported.name ?? sp.imported.value)),
  );
}

/** Whether `name` where `at` reads it is a Business API: a parameter typed `BusinessPayApi`, or a const made by the factory. */
function isBusinessApi(p, at, name) {
  for (let n = p.parents.get(at); n; n = p.parents.get(n)) {
    if (/Function/.test(n.type)) {
      const param = n.params.find((x) => new RegExp(`\\b${name}\\b`).test(text(p, x)));
      if (param) return /\bBusinessPayApi\b/.test(text(p, param));
    }
    const body = n.type === 'Program' || n.type === 'BlockStatement' ? n.body : [];
    for (const stmt of body) {
      const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
      if (decl.type !== 'VariableDeclaration') continue;
      const d = decl.declarations.find((x) => x.id.type === 'Identifier' && x.id.name === name);
      if (d) return Boolean(d.init) && /\bcreateBusinessPayApi\(/.test(text(p, d.init));
    }
  }
  return false;
}

/** The Business API site this call is, or undefined. */
export function businessSite(p, n) {
  const callee = n.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier') return undefined;
  const method = callee.property.name;
  if (method !== 'query' && method !== 'mutate') return undefined;
  const a = n.arguments;
  if (!isString(a[0]) || isString(a[1])) return undefined;
  if (!importsBusinessApi(p) || !isBusinessApi(p, n, callee.object.name)) return undefined;
  const shape = method === 'query' ? 'payQuery' : 'payMutate';
  const site = { shape, module: 'pay', path: literal(a[0]), kind: method === 'query' ? 'query' : 'mutation' };
  const [min, max] = BUSINESS_FORMS[shape].args;
  if (a.length < min || a.length > max || a.some((x) => x.type === 'SpreadElement'))
    site.problem = `Business API ${method} with ${a.length} arguments`;
  return site;
}

/** The record call that replaces one Business API site: the call's name becomes its record, its schema goes. */
export function businessCall(p, s, name, input) {
  const a = s.node.arguments;
  const { fn } = BUSINESS_FORMS[s.shape];
  return `${text(p, s.node.callee.object)}.${fn}(${[name, input, ...a.slice(3).map((x) => text(p, x))].join(', ')})`;
}

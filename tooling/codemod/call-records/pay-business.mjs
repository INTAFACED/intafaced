// The customer Business API's own calls (`createBusinessPayApi` in apps/customer/src/features/pay/pay-api.ts), which
// name only the call, not the service: svc-pay is the one they reach.
//   pay.query('merchant.balances', input, schema, signal?)
//   pay.mutate('payment.capture', input, schema, scope, operation, reference?)
// Each moves to the wrapper's record form beside it: `pay.queryRecord(RECORD, input, signal?)`,
// `pay.mutateRecord(RECORD, input, scope, operation, reference?)`. A `query` or `mutate` on anything else, or one that
// names its service first (`api.query('pay', 'merchant.x', ...)`), is not this shape.
import { keyOf, literal, resolveRelative, text, walk } from './ast.mjs';

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

/** Each record form a Business API test double gets: it sends the record's path and answer schema to the double's own method. */
const DOUBLE_FORMS = {
  query: [
    'queryRecord(',
    '  this: { query: (...args: never[]) => unknown },',
    '  record: { path: string; output: unknown },',
    '  input?: unknown,',
    '  signal?: unknown,',
    ') {',
    "  // tooling/codemod/call-records: a Business API read by its record reaches this double's own query, by the record's path.",
    '  return Reflect.apply(this.query, this, [record.path, input, record.output, ...(signal === undefined ? [] : [signal])]);',
    '},',
  ],
  mutate: [
    'mutateRecord(',
    '  this: { mutate: (...args: never[]) => unknown },',
    '  record: { path: string; output: unknown },',
    '  input?: unknown,',
    '  ...rest: unknown[]',
    ') {',
    "  // tooling/codemod/call-records: a Business API write by its record reaches this double's own mutate, by the record's path.",
    '  return Reflect.apply(this.mutate, this, [record.path, input, record.output, ...rest]);',
    '},',
  ],
};

/** Whether `file`'s source calls a Business API by record. */
export const callsBusinessRecord = (src) => /\.(queryRecord|mutateRecord)\(\s*[A-Z][A-Z0-9_]+\b/.test(src);

/**
 * The edits giving each Business API test double (an object literal cast `as BusinessPayApi`, with `query` or `mutate`)
 * the record form of each method it has and lacks, after its last property.
 */
export function businessDoubleEdits(p) {
  const out = [];
  walk(p.program, (node) => {
    if (node.type !== 'ObjectExpression') return;
    let up = p.parents.get(node);
    let cast = false;
    while (up?.type === 'TSAsExpression' || up?.type === 'ParenthesizedExpression') {
      if (up.type === 'TSAsExpression' && /\bBusinessPayApi\b/.test(text(p, up.typeAnnotation))) cast = true;
      up = p.parents.get(up);
    }
    if (!cast) return;
    const keys = node.properties.filter((pr) => pr.type === 'Property').map(keyOf);
    const add = ['query', 'mutate'].filter((k) => keys.includes(k) && !keys.includes(`${k}Record`));
    if (!add.length) return;
    const last = node.properties[node.properties.length - 1];
    const lineStart = p.src.lastIndexOf('\n', last.start) + 1;
    const multi = p.src.slice(node.start, node.end).includes('\n');
    const indent = multi ? p.src.slice(lineStart, last.start).match(/^\s*/)[0] : '';
    const body = add
      .flatMap((k) => DOUBLE_FORMS[k])
      .filter((l) => multi || !l.trimStart().startsWith('//'))
      .map((l) => (multi ? indent + l : l.trim()));
    const after = p.src.slice(last.end).match(/^\s*,/);
    const at = after ? last.end + after[0].length : last.end;
    out.push({ start: at, end: at, text: multi ? `${after ? '' : ','}\n${body.join('\n')}` : `, ${body.join(' ').replace(/,$/, '')}` });
  });
  return out;
}

// The portal's calls made through its shared tools, which name only the call: each package's client takes the tools apart
// in its parameter and calls them bare (apps/customer/src/features/pay/portal/api-tools.ts, settings/b-client.ts):
//   export const catalogApi = ({ query, mutate, list }: PortalTools) => ({
//     product: (id) => query('merchantCatalog.products.get', { productId: id }, productSchema),
//   });
// Each tool has its record form beside it, and each caller moves to it on its own, so one caller left keeps only itself:
//   query('x.y', input, schema, signal?)            -> queryRecord(RECORD, input, signal?)
//   mutate('x.y', input, schema, opts?)             -> mutateRecord(RECORD, input, opts?)
//   list('x.y', itemSchema, input, signal?)         -> listRecord(RECORD, input, signal?)
//   identityQuery / identityMutate (svc-identity)   -> identityQueryRecord / identityMutateRecord
// The parameter takes the record form apart too, and drops a by-name tool once no call of it is left in that function
// (`toolFormsIn`). A tool reached any other way (`tools.query(...)`, a rest element, a tool renamed) is not this shape.
// A helper imported by name moves the same way, to its record form imported beside it:
//   validatedMutation(pay, 'x.y', input, inputSchema, answerSchema, scope, operation)
//     -> validatedRecordMutation(pay, RECORD, input, inputSchema, scope, operation)
import { bindingOf, resolveRelative, walk } from './ast.mjs';

const isString = (n) => (n?.type === 'Literal' && typeof n.value === 'string') || n?.type === 'TemplateLiteral';
const literal = (n) => (n?.type === 'Literal' ? n.value : n?.quasis?.length === 1 ? n.quasis[0].value.cooked : undefined);

const PAY = {
  query: { form: 'queryRecord', module: 'pay', kind: 'query', path: 0, input: 1, schema: 2, args: [3, 4] },
  mutate: { form: 'mutateRecord', module: 'pay', kind: 'mutation', path: 0, input: 1, schema: 2, args: [3, 4] },
  // The item schema is one row of the page the call answers: it checks the answer, but the record's answer is the page.
  list: { form: 'listRecord', module: 'pay', kind: 'query', path: 0, input: 2, item: 1, args: [3, 4] },
};
/** Each tools type, the file that declares it, and the tools it hands out by name. */
export const TOOLS = {
  PortalTools: { home: /\/apps\/customer\/src\/features\/pay\/portal\/api-tools\.ts$/, tools: PAY },
  SettingsBTools: {
    home: /\/apps\/customer\/src\/features\/pay\/portal\/settings\/b-client\.ts$/,
    tools: {
      ...PAY,
      identityQuery: { form: 'identityQueryRecord', module: 'identity', kind: 'query', path: 0, input: 1, schema: 2, args: [3, 4] },
      identityMutate: { form: 'identityMutateRecord', module: 'identity', kind: 'mutation', path: 0, input: 1, schema: 2, args: [3, 3] },
    },
  },
};
/** Each helper imported by name, the file that declares it, and where its call name, input and answer schema are. */
export const IMPORTED = {
  validatedMutation: {
    home: /\/apps\/customer\/src\/features\/pay\/BusinessPay\.tsx$/,
    form: 'validatedRecordMutation',
    module: 'pay',
    kind: 'mutation',
    path: 1,
    input: 2,
    schema: 4,
    args: [7, 7],
  },
};
const BUSINESS_HOME = /\/apps\/customer\/src\/features\/pay\/pay-api\.ts$/;
/**
 * Whether `name`, declared in `file`, is a by-name tool with its record form beside it: a portal tool, or the Business
 * API's `query`/`mutate` (pay-business.mjs). Its callers move one by one; the tool goes when none is left.
 */
export function hasRecordForm(file, name) {
  if (BUSINESS_HOME.test(file)) return name === 'query' || name === 'mutate';
  return Object.values(TOOLS).some((t) => t.home.test(file) && Object.hasOwn(t.tools, name));
}
/** Every by-name tool's shape, as a site's `shape`: `tool:<name>`. */
export const toolShape = (s) => (typeof s.shape === 'string' && s.shape.startsWith('tool:') ? s.tool : undefined);

/** The tools type `ann` names, imported from its home (or declared there): its entry in TOOLS. */
function toolsType(p, ann) {
  const t = ann?.typeAnnotation;
  if (t?.type !== 'TSTypeReference' || t.typeName.type !== 'Identifier' || !Object.hasOwn(TOOLS, t.typeName.name)) return undefined;
  const entry = TOOLS[t.typeName.name];
  if (entry.home.test(p.file)) return entry;
  const from = p.program.body.find(
    (st) =>
      st.type === 'ImportDeclaration' &&
      st.specifiers.some((sp) => sp.type === 'ImportSpecifier' && (sp.imported.name ?? sp.imported.value) === t.typeName.name),
  );
  if (!from || !from.source.value.startsWith('.')) return undefined;
  const file = resolveRelative(p.file, from.source.value) ?? resolveRelative(p.file, `${from.source.value}.ts`) ?? '';
  return entry.home.test(file) ? entry : undefined;
}

/** The function and parameter pattern a bare `name(...)` at `call` takes `name` from, or undefined. */
function patternOf(p, call, name) {
  for (let n = p.parents.get(call); n; n = p.parents.get(n)) {
    if (!/Function/.test(n.type)) continue;
    for (const param of n.params) {
      if (param.type !== 'ObjectPattern') continue;
      const prop = param.properties.find((x) => x.type === 'Property' && !x.computed && x.key.name === name);
      if (prop) return { fn: n, pattern: param, prop };
    }
    // A closer function's own parameter or variable of the same name would shadow it: only a plain parameter list is read.
    if (n.params.some((x) => x.type === 'Identifier' && x.name === name)) return undefined;
  }
  return undefined;
}

/** Where a helper imported by name comes from: `{ from }` (the import's own specifier, '' in its home), or undefined. */
function importedFrom(p, name, home) {
  if (home.test(p.file)) return bindingOf(p, p.program, name).kind === 'function' ? { from: '' } : undefined;
  for (const st of p.program.body) {
    if (st.type !== 'ImportDeclaration' || !st.source.value.startsWith('.')) continue;
    const sp = st.specifiers.find((x) => x.type === 'ImportSpecifier' && x.local.name === name);
    if (!sp) continue;
    if ((sp.imported.name ?? sp.imported.value) !== name) return undefined;
    const file = resolveRelative(p.file, st.source.value) ?? resolveRelative(p.file, `${st.source.value}.tsx`) ?? '';
    return home.test(file) ? { from: st.source.value } : undefined;
  }
  return undefined;
}

/** The tool-form site a bare call is, or undefined: `{ shape, module, path, kind, tool }`, with `problem` if it can't move. */
export function toolSite(p, n) {
  if (n.callee?.type !== 'Identifier') return undefined;
  const name = n.callee.name;
  let form;
  let tool;
  if (Object.hasOwn(IMPORTED, name)) {
    const got = importedFrom(p, name, IMPORTED[name].home);
    if (!got) return undefined;
    form = IMPORTED[name];
    tool = { ...form, name, from: got.from };
  } else {
    const at = patternOf(p, n, name);
    if (!at) return undefined;
    form = toolsType(p, at.pattern.typeAnnotation)?.tools[name];
    if (!form) return undefined;
    tool = { ...form, name, fn: at.fn, pattern: at.pattern, prop: at.prop };
  }
  const a = n.arguments;
  if (!isString(a[form.path])) return undefined;
  const site = { shape: `tool:${name}`, module: form.module, path: literal(a[form.path]), kind: form.kind, tool };
  if (a.length < form.args[0] || a.length > form.args[1] || a.some((x) => x.type === 'SpreadElement'))
    site.problem = `${name} with ${a.length} arguments`;
  else if (a[form.path].type === 'TemplateLiteral' && a[form.path].expressions.length) site.problem = `${name}'s call named by a template`;
  else if (tool.pattern && (!tool.prop.shorthand || tool.pattern.properties.some((x) => x.type !== 'Property' || !x.shorthand)))
    site.problem = `${name} is taken apart with a rename or a rest element`;
  return site;
}

/** The input argument of a tool-form site. */
export const toolInput = (s) => s.node.arguments[s.tool.input];
/** The schema the caller parsed the answer with (undefined for `list`, whose item schema is one row, not the answer). */
export const toolSchema = (s) => (s.tool.schema === undefined ? undefined : s.node.arguments[s.tool.schema]);
/** The schema whose checks a record would drop: the answer's, or a list's item. */
export const toolChecked = (s) => s.node.arguments[s.tool.schema ?? s.tool.item];

/** One caller, rewritten to its record form; the parameter is rewritten once every caller is (`toolFormsIn`). */
export function toolCall(changes, s, name, input) {
  const a = s.node.arguments;
  const { path, schema, item } = s.tool;
  const head = a.slice(0, path);
  const tail = a.filter((_, i) => i > path && i !== s.tool.input && i !== schema && i !== item);
  if (!s.tool.pattern) {
    if (s.tool.from) changes.imp(s.file, s.tool.from, s.tool.form);
    return { fn: s.tool.form, args: [...head, name, input, ...tail] };
  }
  const f = changes.of(s.file);
  f.toolPatterns ??= new Map();
  const key = s.tool.pattern.start;
  if (!f.toolPatterns.has(key)) f.toolPatterns.set(key, { s, moved: new Map() });
  const moved = f.toolPatterns.get(key).moved;
  moved.set(s.tool.name, (moved.get(s.tool.name) ?? 0) + 1);
  return { fn: s.tool.form, args: [...head, name, input, ...tail] };
}

/** How many bare calls of `name` the function `fn` makes. */
function callsOf(fn, name) {
  let n = 0;
  walk(fn.body, (m) => {
    if (m.type === 'Identifier' && m.name === name) n++;
  });
  return n;
}

/**
 * Each parameter some caller moved in: the record forms its moved callers use are taken apart beside the tools it had,
 * and a by-name tool none of its function's code names any more is dropped.
 */
export function toolFormsIn(changes) {
  for (const [file, f] of changes.files) {
    for (const { s, moved } of f.toolPatterns?.values() ?? []) {
      const { pattern, fn } = s.tool;
      const names = pattern.properties.map((x) => x.key.name);
      const forms = s.tool.name in TOOLS.SettingsBTools.tools ? TOOLS.SettingsBTools.tools : TOOLS.PortalTools.tools;
      const keep = names.filter((x) => !moved.has(x) || callsOf(fn, x) > moved.get(x));
      for (const x of moved.keys()) if (!keep.includes(forms[x].form) && !names.includes(forms[x].form)) keep.push(forms[x].form);
      for (const x of names) if (x.endsWith('Record') && !keep.includes(x)) keep.push(x);
      const first = pattern.properties[0];
      const last = pattern.properties[pattern.properties.length - 1];
      changes.edit(file, first.start, last.end, keep.join(', '));
    }
  }
}

// A call named by its wrapper's parameter: a function that sends the name it is handed to the service, its callers each
// naming the call by a string:
//   async function change(api, procedure: string, input) { return api.mutate('identity', procedure, input, schema); }
//   change(api, 'receiveContacts.add', input);
// or a spec whose `procedure` field a function sends, each object of it in the file naming the call by a string:
//   type Change = { procedure: 'recovery.keys.add' | 'recovery.plan.set'; ... };
//   const send = (change: Change) => api.mutate('identity', change.procedure, change.body, schema);
//   attempt({ procedure: 'recovery.keys.add', ... });
// Each caller's string is one site, and once every one has its record the whole wrapper moves at once: each string
// becomes its record, the parameter (or the spec's field) is typed `AppProcedure`, and the wrapper sends
// `callAs(api, procedure, input, schema, opts)` (apps/customer/src/shared/api.ts), which calls by the record and keeps the
// wrapper's own schema as the answer's check, as it read the answer before. One caller left by name leaves them all.
// Anything else the wrapper does with the name (compares it, hands the wrapper on, takes it from a request) stays, named.
import { join, relative } from 'node:path';
import { bindingOf, load, resolveRelative, text, walk } from './ast.mjs';
import { hasRecordForm } from './tool-forms.mjs';

const CUSTOMER_SRC = '/apps/customer/src/';
const SENDERS = new Set(['query', 'mutate']);
const isString = (n) => n?.type === 'Literal' && typeof n.value === 'string';
const lineOf = (p, n) => p.src.slice(0, n.start).split('\n').length;
const at = (p, n) => `${relative(join(p.file.slice(0, p.file.indexOf('/apps/')), '.'), p.file)}:${lineOf(p, n)}`;

/** The strings a caller names its call by: one string, or a `? :` of two (each becomes its record in place); else undefined. */
const namesOf = (arg) =>
  isString(arg)
    ? [arg]
    : arg?.type === 'ConditionalExpression' && isString(arg.consequent) && isString(arg.alternate)
      ? [arg.consequent, arg.alternate]
      : undefined;

/** `x.query(module, path, input, schema, opts?)` or `x.mutate(...)`, its module a string: the sender a wrapper may hand its name to. */
function sender(n) {
  if (n?.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return undefined;
  const name = n.callee.property.name;
  if (!SENDERS.has(name) || !isString(n.arguments[0])) return undefined;
  if (n.arguments.length < 4 || n.arguments.length > 5 || n.arguments.some((a) => a.type === 'SpreadElement')) return undefined;
  return { module: n.arguments[0].value, kind: name === 'query' ? 'query' : 'mutation' };
}

/** The innermost function around `node` that takes `name` as a plain parameter: `{ fn, id, index }`. */
function paramOf(p, node, name) {
  for (let n = p.parents.get(node); n; n = p.parents.get(n)) {
    if (!/Function/.test(n.type)) continue;
    const index = n.params.findIndex((x) => x.type === 'Identifier' && x.name === name);
    if (index >= 0) return { fn: n, id: n.params[index], index };
    if (n.params.some((x) => JSON.stringify(x).includes(`"name":"${name}"`))) return undefined;
  }
  return undefined;
}

/** The name a function is called by, and the statement that declares it: `function f` or `const f = () =>`. */
function nameOf(p, fn) {
  if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name;
  const up = p.parents.get(fn);
  return up?.type === 'VariableDeclarator' && up.init === fn && up.id.type === 'Identifier' ? up.id.name : undefined;
}

/** Whether `id` (a name read in `p`) is the declaration `decl` names, as `bindingOf` sees it. */
function boundTo(p, id, decl) {
  const b = bindingOf(p, id, id.name);
  return (b.kind === 'function' && b.declaration === decl) || (b.kind === 'var' && b.declarator.init === decl);
}

/** Every read of `name` in `root` that `isIt` says is the one we follow, but its own declaration. */
function readsOf(p, root, name, isIt, decl) {
  const out = [];
  walk(root, (n) => {
    if (n.type !== 'Identifier' || n.name !== name || n === decl) return;
    const up = p.parents.get(n);
    if (up?.type === 'MemberExpression' && up.property === n && !up.computed) return;
    if (up?.type === 'Property' && up.key === n && !up.computed && !up.shorthand) return;
    if ((up?.type ?? '').startsWith('TS') && up.type !== 'TSAsExpression' && up.type !== 'TSNonNullExpression') return;
    if ((up?.type ?? '').startsWith('Import')) return;
    if (isIt(n)) out.push(n);
  });
  return out;
}

/** The files a wrapper declared in `p` is imported into by name, each with the local name; `{ why }` when it is reached another way. */
function importers(p, name, files) {
  const out = [];
  for (const file of files) {
    if (file === p.file) continue;
    const q = load(file);
    if (!q.src.includes(name)) continue;
    for (const stmt of q.program.body) {
      if ((stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportAllDeclaration') && stmt.source) {
        if (resolveRelative(q.file, stmt.source.value) === p.file) return { why: `${at(q, stmt)} re-exports it` };
        continue;
      }
      if (stmt.type !== 'ImportDeclaration' || resolveRelative(q.file, stmt.source.value) !== p.file) continue;
      for (const s of stmt.specifiers ?? []) {
        if (s.type === 'ImportNamespaceSpecifier') return { why: `${at(q, s)} imports its file whole` };
        if (s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === name) out.push({ q, local: s.local.name });
      }
    }
  }
  return { files: out };
}

/**
 * A wrapper handed out by the hook around it, in the object it returns (`function useChange() { ...; return { busy, run }; }`),
 * and called only through what each caller of the hook holds (`const change = useChange(); change.run('a.b', ...)`): those
 * calls, `{ calls }`; or `{ why }` for the first use that is not one (the holder handed on whole, taken apart, or the
 * wrapper read off it but not called).
 */
function heldCalls(p, id, name) {
  const on = `${at(p, id)} hands ${name} on rather than calling it`;
  const prop = p.parents.get(id);
  // A shorthand `{ run }` is read twice, by its key and its value: the value alone is followed.
  if (prop?.type === 'Property' && prop.shorthand && prop.key === id) return { calls: [] };
  const obj = prop?.type === 'Property' && prop.shorthand && prop.value === id ? p.parents.get(prop) : undefined;
  const ret = obj?.type === 'ObjectExpression' ? p.parents.get(obj) : undefined;
  if (ret?.type !== 'ReturnStatement') return { why: on };
  let hook = p.parents.get(ret);
  while (hook && !/Function/.test(hook.type)) hook = p.parents.get(hook);
  const hookName = hook && nameOf(p, hook);
  if (!hookName) return { why: on };
  const exported = p.program.body.some(
    (s) =>
      s.type === 'ExportNamedDeclaration' &&
      (s.declaration === hook ||
        s.declaration?.declarations?.some((d) => d.init === hook) ||
        s.specifiers?.some((x) => x.local.name === hookName)),
  );
  if (exported) return { why: `${on}: its hook ${hookName} is exported, and the codemod follows what it returns only in its file` };
  const calls = [];
  const seen = new Set();
  for (const h of readsOf(p, p.program, hookName, (n) => boundTo(p, n, hook), hook.id ?? p.parents.get(hook).id)) {
    const made = p.parents.get(h);
    const decl = made?.type === 'CallExpression' && made.callee === h ? p.parents.get(made) : undefined;
    if (decl?.type !== 'VariableDeclarator' || decl.init !== made || decl.id.type !== 'Identifier')
      return { why: `${on}: ${at(p, h)} takes ${hookName}'s answer other than into one name` };
    const holder = decl.id.name;
    const scope = p.parents.get(p.parents.get(decl));
    const reads = readsOf(p, scope, holder, (n) => bindingOf(p, n, holder).declarator === decl, decl.id);
    const why = holderCalls(p, reads, holder, name, on, calls, seen);
    if (why) return { why };
  }
  if (!calls.length) return { why: `${on}: nothing calls it through ${hookName}` };
  return { calls };
}

/** The function a destructured parameter `name` read at `n` belongs to. */
function paramOwner(p, n, name) {
  for (let up = p.parents.get(n); up; up = p.parents.get(up))
    if (/Function/.test(up.type) && up.params.some((x) => JSON.stringify(x).includes(`"name":"${name}"`))) return up;
  return undefined;
}

/**
 * Each read of a hook's holder: `holder.<name>(...)` is a call, another member is no matter, and the holder handed as a
 * JSX prop (`<Form change={change} />`) to a component of this file that takes that prop apart is followed into it.
 * Pushes the calls; returns why one read is none of these.
 */
function holderCalls(p, reads, holder, name, on, calls, seen) {
  for (const r of reads) {
    const m = p.parents.get(r);
    if (m?.type === 'MemberExpression' && m.object === r && !m.computed) {
      if (m.property.name !== name) continue;
      const c = p.parents.get(m);
      if (c?.type !== 'CallExpression' || c.callee !== m) return `${on}: ${at(p, m)} reads ${holder}.${name} rather than calling it`;
      calls.push(c);
      continue;
    }
    const box = m?.type === 'JSXExpressionContainer' ? p.parents.get(m) : undefined;
    const tag = box?.type === 'JSXAttribute' && box.name.type === 'JSXIdentifier' ? p.parents.get(box) : undefined;
    const comp = tag?.type === 'JSXOpeningElement' && tag.name.type === 'JSXIdentifier' ? tag.name : undefined;
    const b = comp && bindingOf(p, comp, comp.name);
    const fn = b?.kind === 'function' ? b.declaration : b?.kind === 'var' ? b.declarator.init : undefined;
    const props = fn && /Function/.test(fn.type) ? fn.params[0] : undefined;
    const prop = box?.name.name;
    const field =
      props?.type === 'ObjectPattern' &&
      props.properties.find(
        (x) => x.type === 'Property' && !x.computed && (x.key.name ?? x.key.value) === prop && x.value.type === 'Identifier',
      );
    if (!field) return `${on}: ${at(p, r)} hands ${holder}, which holds it, on whole`;
    if (seen.has(fn)) continue;
    seen.add(fn);
    const local = field.value.name;
    const inner = readsOf(p, fn.body, local, (n) => bindingOf(p, n, local).kind === 'param' && paramOwner(p, n, local) === fn);
    const why = holderCalls(p, inner, local, name, on, calls, seen);
    if (why) return why;
  }
  return undefined;
}

/**
 * The calls of the wrapper `fn`, each with the string it names its call by at parameter `index`: `{ calls: [{ q, call, arg }] }`,
 * or `{ why }` for the first use that is not such a call.
 */
function callersOf(p, fn, index, files) {
  const name = nameOf(p, fn);
  if (!name) return { why: 'it is no function its callers call by a name' };
  const up = p.parents.get(fn);
  const stmt = fn.type === 'FunctionDeclaration' ? p.parents.get(fn) : p.parents.get(p.parents.get(up));
  const exported = stmt?.type === 'ExportNamedDeclaration';
  const uses = [{ q: p, ids: readsOf(p, p.program, name, (n) => boundTo(p, n, fn), fn.id ?? up.id) }];
  if (
    !exported &&
    p.program.body.some((s) => s.type === 'ExportNamedDeclaration' && !s.declaration && s.specifiers.some((x) => x.local.name === name))
  )
    return { why: `it is exported by name (${name}), which the codemod does not follow` };
  if (exported) {
    const found = importers(p, name, files);
    if (found.why) return found;
    for (const { q, local } of found.files)
      uses.push({ q, ids: readsOf(q, q.program, local, (n) => bindingOf(q, n, local).kind === 'import') });
  }
  const calls = [];
  for (const { q, ids } of uses)
    for (const id of ids) {
      let call = q.parents.get(id);
      if (call?.type !== 'CallExpression' || call.callee !== id) {
        const held = heldCalls(q, id, name);
        if (held.why) return { why: held.why };
        for (const c of held.calls) {
          const arg = c.arguments[index];
          if (c.arguments.slice(0, index + 1).some((a) => a.type === 'SpreadElement'))
            return { why: `${at(q, c)} calls ${name} with a spread` };
          const named = namesOf(arg);
          if (!named) return { why: `${at(q, c)} names its call by ${arg ? text(q, arg).slice(0, 40) : 'nothing'}, not a string` };
          for (const a of named) calls.push({ q, call: c, arg: a });
        }
        continue;
      }
      if (call.arguments.slice(0, index + 1).some((a) => a.type === 'SpreadElement'))
        return { why: `${at(q, call)} calls ${name} with a spread` };
      const arg = call.arguments[index];
      const named = namesOf(arg);
      if (!named) return { why: `${at(q, call)} names its call by ${arg ? text(q, arg).slice(0, 40) : 'nothing'}, not a string` };
      for (const a of named) calls.push({ q, call, arg: a });
    }
  if (!calls.length) return { why: `nothing calls ${name}` };
  return { calls };
}

/** One wrapper as a site of each of its callers, or `{ why }` it stays; `undefined` when the call is no wrapper's. */
function paramWrapper(p, site, files) {
  const nameArg = site.node.arguments[1];
  const param = paramOf(p, nameArg, nameArg.name);
  if (!param) return undefined;
  const ann = param.id.typeAnnotation?.typeAnnotation;
  // A closed set of strings is fan.mjs's: one site per value, in the one call.
  if (ann && ann.type !== 'TSStringKeyword') return undefined;
  const fname = nameOf(p, param.fn) ?? 'it';
  // A tool with its record form beside it: each caller is its own site (tool-forms.mjs, pay-business.mjs), named with
  // its own reason while it stays; the tool's sender is left only until its last caller moves.
  if (hasRecordForm(p.file, fname))
    return { why: `its tool ${fname} has a record form its callers move to one by one, and stays while a caller is left` };
  // Every read of the name is one sender's call name, all to one service and of one kind.
  const reads = readsOf(
    p,
    param.fn.body,
    nameArg.name,
    (n) => bindingOf(p, n, n.name).kind === 'param' && paramOf(p, n, n.name)?.fn === param.fn,
  );
  const inner = [];
  // A read inside a template string (a cache key, `bills:${procedure}:...`) reads the record's path, which is the string.
  const keys = [];
  for (const r of reads) {
    const call = p.parents.get(r);
    if (call?.type === 'TemplateLiteral' && call.expressions.includes(r)) {
      keys.push(r);
      continue;
    }
    const s = sender(call);
    if (!s || call.arguments[1] !== r) return { why: `its wrapper ${fname} reads its call name for more than sending it (${at(p, r)})` };
    inner.push({ call, ...s });
  }
  if (!inner.length) return { why: `its wrapper ${fname} reads its call name only in a template string` };
  if (new Set(inner.map((x) => `${x.module} ${x.kind}`)).size !== 1)
    return { why: `its wrapper ${fname} sends its call name to more than one service, or both as a query and a mutation` };
  const found = callersOf(p, param.fn, param.index, files);
  if (found.why) return { why: `its wrapper ${fname} takes its call name by a parameter, and ${found.why}` };
  return {
    key: `${p.file}:${param.fn.start}`,
    file: p.file,
    name: fname,
    module: inner[0].module,
    kind: inner[0].kind,
    typed: { node: param.id.typeAnnotation, after: param.id },
    inner: inner.map((x) => x.call),
    keys,
    callers: found.calls.map(({ q, call, arg }) => ({ q, node: call, arg })),
  };
}

/** A spec type declared in this file, as `{ alias, field }` (its `procedure` field), or `{ why }`. */
function specType(p, param) {
  const ann = param.id.typeAnnotation?.typeAnnotation;
  if (ann?.type !== 'TSTypeReference' || ann.typeName.type !== 'Identifier' || ann.typeArguments)
    return { why: 'its spec is not typed by a type of its file' };
  const b = bindingOf(p, ann, ann.typeName.name);
  if (b.kind !== 'type' || b.declaration.type !== 'TSTypeAliasDeclaration' || b.declaration.typeAnnotation.type !== 'TSTypeLiteral')
    return { why: `its spec type ${ann.typeName.name} is not an object type of its file` };
  if (b.exported) return { why: `its spec type ${ann.typeName.name} is exported, so other files may build it` };
  const field = b.declaration.typeAnnotation.members.find(
    (m) => m.type === 'TSPropertySignature' && !m.computed && m.key.name === 'procedure',
  );
  const t = field?.typeAnnotation?.typeAnnotation;
  const strings = (x) =>
    x?.type === 'TSStringKeyword' ||
    (x?.type === 'TSLiteralType' && isString(x.literal)) ||
    (x?.type === 'TSUnionType' && x.types.every(strings));
  if (!field || field.optional || !strings(t)) return { why: `its spec type ${ann.typeName.name}'s procedure is not a string` };
  return { alias: b.declaration, field };
}

/** A spec whose `procedure` field a function sends, as a site of each object of it in the file; `{ why }`; or `undefined`. */
function specWrapper(p, site) {
  const nameArg = site.node.arguments[1];
  const obj = nameArg.object;
  if (obj.type !== 'Identifier' || nameArg.computed || nameArg.property.name !== 'procedure') return undefined;
  if (bindingOf(p, obj, obj.name).kind !== 'param') return undefined;
  const param = paramOf(p, obj, obj.name);
  if (!param) return undefined;
  const spec = specType(p, param);
  if (spec.why) return { why: spec.why };
  const typeName = spec.alias.id.name;
  // Every read of a `.procedure` in the file is a sender's call name, so no other use of the field can read a string.
  const inner = [];
  let other;
  walk(p.program, (n) => {
    if (other || n.type !== 'MemberExpression' || n.computed || n.property.name !== 'procedure') return;
    const s = sender(p.parents.get(n));
    if (!s || p.parents.get(n).arguments[1] !== n) other = n;
    else inner.push({ call: p.parents.get(n), ...s });
  });
  if (other) return { why: `${at(p, other)} reads a spec's procedure for more than sending it` };
  if (new Set(inner.map((x) => `${x.module} ${x.kind}`)).size !== 1)
    return { why: 'its specs are sent to more than one service, or both as a query and a mutation' };
  // Each spec object is one `procedure: '<call>'` in the file; one named any other way, or destructured, stays.
  const callers = [];
  let bad;
  walk(p.program, (n) => {
    if (bad) return;
    if (
      n.type === 'Property' &&
      !n.computed &&
      (n.key.name ?? n.key.value) === 'procedure' &&
      p.parents.get(n)?.type === 'ObjectExpression'
    ) {
      if (isString(n.value)) callers.push({ q: p, node: n, arg: n.value });
      else bad = `${at(p, n)} names a spec's call by ${text(p, n.value).slice(0, 40)}, not a string`;
    }
    if (n.type === 'ObjectPattern' && n.properties.some((x) => x.type === 'Property' && (x.key.name ?? x.key.value) === 'procedure'))
      bad = `${at(p, n)} takes a spec's procedure apart`;
  });
  if (bad) return { why: bad };
  if (!callers.length) return { why: `no ${typeName} in its file names its call` };
  return {
    key: `${p.file}:${spec.field.start}`,
    file: p.file,
    name: typeName,
    module: inner[0].module,
    kind: inner[0].kind,
    typed: { node: spec.field.typeAnnotation, after: spec.field.key },
    inner: inner.map((x) => x.call),
    callers,
  };
}

/**
 * The sites a call named by its wrapper's parameter or spec is: one per caller string, each carrying the wrapper; `[]` for
 * the second sender of a wrapper already seen; `{ why }` naming why its wrapper stays; or `undefined` when the call is none.
 */
export function wrapperOut(p, site, files, seen) {
  if (site.shape !== 'query' && site.shape !== 'mutate') return undefined;
  const nameArg = site.node.arguments[1];
  const shape = nameArg?.type === 'Identifier' ? paramWrapper : nameArg?.type === 'MemberExpression' ? specWrapper : undefined;
  if (!shape) return undefined;
  if (shape === paramWrapper && bindingOf(p, nameArg, nameArg.name).kind !== 'param') return undefined;
  const w = shape(p, site, files);
  if (!w || w.why) return w;
  if (!p.file.includes(CUSTOMER_SRC)) return { why: `its wrapper ${w.name} is outside the customer app, which alone has callAs` };
  if (seen.has(w.key)) return [];
  seen.add(w.key);
  return w.callers.map((c, i) => ({
    file: c.q.file,
    line: lineOf(c.q, c.node),
    node: c.node,
    shape: 'wrapper',
    module: w.module,
    path: c.arg.value,
    kind: w.kind,
    wrapper: { ...w, at: i, size: w.callers.length, arg: c.arg },
  }));
}

/** One caller of a wrapper, written later with the others (`wrapperIn`). */
export function wrapperBranch(changes, s, name, spec) {
  const f = changes.of(s.wrapper.file);
  f.wrappers ??= new Map();
  if (!f.wrappers.has(s.wrapper.key)) f.wrappers.set(s.wrapper.key, { w: s.wrapper, got: [] });
  f.wrappers.get(s.wrapper.key).got[s.wrapper.at] = { s, name, spec };
}

const relSpec = (from, to) => {
  let r = relative(join(from, '..'), to).replace(/\.tsx?$/, '');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
};

/**
 * Each wrapper whose every caller has its record, moved whole: the strings become records, the name is typed
 * `AppProcedure`, and each sender becomes `callAs`. A wrapper with a caller left keeps all of them, each named.
 * `kindOf(name)` is the kind of a record already written, so a record of the other kind never moves a caller.
 */
export function wrapperIn(changes, planned, done, kindOf = () => undefined) {
  for (const f of changes.files.values()) {
    for (const { w, got } of f.wrappers?.values() ?? []) {
      const all = Array.from({ length: w.size }, (_, i) => got[i]);
      const wrongKind = all.find((x) => x && kindOf(x.name) && kindOf(x.name) !== w.kind);
      if (all.some((x) => !x) || wrongKind) {
        const back = new Set(all.filter(Boolean).map((x) => x.s));
        for (const r of [...done, ...planned.existing]) r.sites = r.sites.filter((x) => !back.has(x));
        const why = wrongKind
          ? `${wrongKind.name} is a ${kindOf(wrongKind.name)}, but its wrapper ${w.name} sends a ${w.kind}`
          : `another caller of its wrapper ${w.name} stays, and the wrapper sends them all`;
        for (const x of back) planned.hand.push({ site: x, why });
        continue;
      }
      for (const { s, name, spec } of all) {
        changes.edit(s.file, s.wrapper.arg.start, s.wrapper.arg.end, name);
        changes.imp(s.file, spec, name);
      }
      const p = load(w.file);
      if (w.typed.node) changes.edit(w.file, w.typed.node.start, w.typed.node.end, ': AppProcedure');
      else changes.edit(w.file, w.typed.after.end, w.typed.after.end, ': AppProcedure');
      for (const k of w.keys ?? []) changes.edit(w.file, k.start, k.end, `${k.name}.path`);
      for (const call of w.inner) {
        const a = call.arguments.slice(1).map((x) => text(p, x));
        changes.edit(w.file, call.start, call.end, `callAs(${text(p, call.callee.object)}, ${a.join(', ')})`);
      }
      const api = relSpec(w.file, `${w.file.slice(0, w.file.indexOf(CUSTOMER_SRC))}${CUSTOMER_SRC}shared/api.ts`);
      changes.imp(w.file, api, 'callAs');
      changes.imp(w.file, api, 'type AppProcedure');
    }
  }
}

#!/usr/bin/env node
// Rewrites each installer that swaps methods on another module's class at run time (garden/no-runtime-swap) into a
// layer: a function that takes the class and returns a subclass carrying the same methods.
//
//   export function installFokPlace(ctor: typeof TradeService): void {      export function withFokPlace(Base: typeof TradeService): typeof TradeService {
//     const proto = ctor.prototype as unknown as {…};                          return class FokPlace extends Base {
//     if (proto[FLAG]) return;                                                     override async placeOrder(principal: Principal, input: PlaceOrderInput) {
//     proto[FLAG] = true;                                                           …
//     const origPlace = proto.placeOrder;                              →             const order = await super.placeOrder(principal, bound);
//     proto.placeOrder = async function (this: TradeService, principal, input) {     …
//       … await origPlace.call(this, principal, bound) …                           }
//     };                                                                         };
//   }                                                                          }
//   installFokPlace(TradeService);                                            (the import-time call is deleted)
//
// What each part becomes, and why the behaviour is the same once the layers are applied in the order the installers ran:
//   - `orig.call(this, …)` / `orig.apply(this, args)`, the method as it stood when the installer ran: `super.m(…)`, the
//     method of the layers below this one.
//   - `proto.n.call(this, …)`, read off the shared prototype when it runs, so the newest installed `n`: `this.n(…)`, the
//     most derived `n`.
//   - `if (proto[FLAG]) return; proto[FLAG] = true;`: dropped. A layer is applied once, where the service is put
//     together, so nothing guards a second install.
//   - `if (typeof proto.m === 'function') {…}` / `if (orig) {…}`: kept unconditionally when the base class declares `m`
//     (so the condition was always true), else the installer is left.
//   - a base-class `private` member a layer overrides becomes `protected` (a subclass may not override a private one).
//   - the file's own top-level `installX(…)` call, a wrapper whose body only calls rewritten installers, and a
//     side-effect `import './x.js'` of a rewritten file elsewhere: deleted. The layers are applied in one place,
//     `assemble*()` beside the service (services/svc-trade/src/assemble.ts), which index.ts calls at start-up.
// Anything else in an installer (a statement it does not know, `proto` or `orig` used another way, `super` that would
// land inside a nested function) leaves that installer as it is, with its reason; it is then fixed by hand.
// Safe to rerun: a rewritten file has no installer left, so a second run changes nothing.
//
//   node tooling/codemod/runtime-swap/rewrite.mjs [files…]          rewrite (default: every file count-rule lists), then
//                                                                   prettier the files it changed; lists what it left
//   node tooling/codemod/runtime-swap/rewrite.mjs --check [files…]  list what it would change and leave; exit 1 if any
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function walk(node, visit, parent = null, inFn = 0) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, inFn);
  const nextFn = node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' ? inFn + 1 : inFn;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'type' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) for (const v of value) walk(v, visit, node, nextFn);
    else walk(value, visit, node, nextFn);
  }
}
const bare = (n) => {
  let x = n;
  while (
    x &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSTypeAssertion'].includes(x.type)
  )
    x = x.expression;
  return x;
};
const propName = (m) =>
  m?.type !== 'MemberExpression'
    ? undefined
    : !m.computed && m.property?.type === 'Identifier'
      ? m.property.name
      : m.computed && m.property?.type === 'Literal' && typeof m.property.value === 'string'
        ? m.property.value
        : undefined;
const isId = (n, names) => bare(n)?.type === 'Identifier' && names.has(bare(n).name);
const parse = (file, src) => {
  const r = parseSync(file, src, { lang: 'ts', sourceType: 'module' });
  if (r.errors?.length) throw new Error(`${file}: ${r.errors[0].message}`);
  return r.program;
};

/** Member names and `private` members of class `name` in the file `from` imports it from. */
function baseClass(file, program, name) {
  for (const s of program.body) {
    if (s.type !== 'ImportDeclaration' || !s.source.value.startsWith('.')) continue;
    if (!s.specifiers.some((sp) => sp.local?.name === name)) continue;
    const imported = s.specifiers.find((sp) => sp.local?.name === name).imported?.name ?? name;
    const path = resolve(dirname(file), s.source.value.replace(/\.js$/u, '.ts'));
    if (!existsSync(path)) return null;
    const src = readFileSync(path, 'utf8');
    let found = null;
    walk(parse(path, src), (n) => {
      if (n.type === 'ClassDeclaration' && n.id?.name === imported) found = n;
    });
    if (!found) return null;
    const members = new Map();
    const overloads = new Map(); // every declaration of a name (an overloaded method has several)
    for (const m of found.body.body) {
      const key = m.key?.type === 'Identifier' ? m.key.name : undefined;
      if (key && (m.type === 'MethodDefinition' || m.type === 'PropertyDefinition')) {
        if (!members.has(key)) members.set(key, m);
        (overloads.get(key) ?? overloads.set(key, []).get(key)).push(m);
      }
    }
    return { path, src, members, overloads, name: imported };
  }
  return null;
}

/** The parts of the comment text between `from` and `to` (the comments that lead a statement). */
const leadingComments = (src, from, to) => {
  const text = src.slice(from, to);
  const lines = text.split('\n').map((l) => l.trim());
  return lines.filter((l) => l.startsWith('//') || l.startsWith('/*') || l.startsWith('*')).join('\n');
};

/** Turn one installer into a layer; returns { text, privates } or { left: reason }. */
function layerOf(file, src, program, fn) {
  const params = fn.params;
  if (params.length !== 1 || (params[0].type !== 'Identifier' && params[0].type !== 'AssignmentPattern'))
    return { left: 'not one class parameter' };
  const param = params[0].type === 'AssignmentPattern' ? params[0].left : params[0];
  const typeAnn = param.typeAnnotation?.typeAnnotation;
  if (typeAnn?.type !== 'TSTypeQuery' || typeAnn.exprName?.type !== 'Identifier') return { left: 'its parameter is not `typeof <Class>`' };
  const ctor = param.name;
  const className = typeAnn.exprName.name;
  const base = baseClass(file, program, className);
  if (!base) return { left: `class ${className} not found` };

  const protos = new Set();
  const origs = new Map(); // orig name -> member
  const methods = [];
  const privates = new Set();
  const needs = [];
  let reason = null;
  let prevEnd = fn.body.start + 1;

  const isProtoInit = (init) => {
    const x = bare(init);
    return (x?.type === 'MemberExpression' && propName(x) === 'prototype' && isId(x.object, new Set([ctor]))) || isId(x, protos);
  };
  const isFlag = (n) => n?.type === 'MemberExpression' && n.computed && isId(n.object, protos) && bare(n.property)?.type === 'Identifier';

  const method = (member, fnNode, comment) => {
    if (fnNode?.type === 'Identifier') {
      // `proto.m = namedFn`: a function declared in this file with a `this` parameter; the layer's method calls it.
      const decl = program.body
        .map((st) => (st.type === 'ExportNamedDeclaration' ? st.declaration : st))
        .find((st) => st?.type === 'FunctionDeclaration' && st.id?.name === fnNode.name);
      if (!decl) return (reason = `\`${member}\` is set to \`${fnNode.name}\`, not a function declared here`);
      const ps = decl.params.filter((p) => !(p.type === 'Identifier' && p.name === 'this'));
      const nameOf = (p) =>
        p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : null;
      if (!ps.every(nameOf)) return (reason = `\`${fnNode.name}\` has a parameter that is not a plain name`);
      const has = base.members.has(member);
      if (has && base.members.get(member).accessibility === 'private') privates.add(member);
      methods.push(
        `${comment ? `${comment}\n` : ''}${has ? 'override ' : ''}${member}(${ps.map((p) => src.slice(p.start, p.end)).join(', ')}) {\n` +
          `  return ${fnNode.name}.call(this, ${ps.map(nameOf).join(', ')});\n}`,
      );
      return;
    }
    if (fnNode.type !== 'FunctionExpression') return (reason = `\`${member}\` is not set to a function expression`);
    const ps = fnNode.params.filter((p) => !(p.type === 'Identifier' && p.name === 'this'));
    const overrides = base.members.has(member);
    const ref = `${className}['${member}']`;
    // The swapped-in function took its types from the prototype it was assigned to; a method takes them from the base
    // class it overrides, so an unannotated parameter and the result keep the base method's types.
    const paramText = ps
      .map((p, i) =>
        overrides && p.type === 'Identifier' && !p.typeAnnotation ? `${p.name}: Parameters<${ref}>[${i}]` : src.slice(p.start, p.end),
      )
      .join(', ');
    const ret = fnNode.returnType ? src.slice(fnNode.returnType.start, fnNode.returnType.end) : overrides ? `: ReturnType<${ref}>` : '';
    const body = fnNode.body;
    const edits = [];
    walk(body, (n, _parent, inFn) => {
      if (reason) return;
      if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && !n.callee.computed) {
        const how = n.callee.property.name;
        const target = bare(n.callee.object);
        if ((how === 'call' || how === 'apply') && n.arguments[0]?.type === 'ThisExpression') {
          let head = null;
          let name = null;
          if (target?.type === 'Identifier' && origs.has(target.name)) {
            head = 'super';
            name = origs.get(target.name);
          } else if (target?.type === 'MemberExpression' && isId(target.object, protos) && propName(target)) {
            head = 'this';
            name = propName(target);
          }
          if (head) {
            if (head === 'super' && inFn > 0) return (reason = `\`super.${name}\` would land inside a nested function`);
            const rest = n.arguments.slice(1);
            let args;
            if (how === 'call') args = rest.map((a) => src.slice(a.start, a.end)).join(', ');
            else if (rest.length === 1) args = `...(${src.slice(rest[0].start, rest[0].end)} as Parameters<${className}['${name}']>)`;
            else return (reason = `\`.apply\` with ${rest.length} arguments`);
            const access = /^[A-Za-z_$][\w$]*$/u.test(name) ? `.${name}` : `['${name}']`;
            edits.push({ start: n.start, end: n.end, text: `${head}${access}(${args})` });
            if (base.members.get(name)?.accessibility === 'private') privates.add(name);
            n.__done = true;
            return;
          }
        }
      }
      if (n.type === 'Identifier' && (origs.has(n.name) || protos.has(n.name))) {
        const covered = edits.some((e) => e.start <= n.start && n.end <= e.end);
        if (!covered) reason = `\`${n.name}\` is used another way inside \`${member}\``;
      }
    });
    if (reason) return;
    let text = src.slice(body.start, body.end);
    for (const e of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, e.start - body.start) + e.text + text.slice(e.end - body.start);
    const has = base.members.has(member);
    if (has && base.members.get(member).accessibility === 'private') privates.add(member);
    const head = `${has ? 'override ' : ''}${fnNode.async ? 'async ' : ''}${fnNode.generator ? '*' : ''}`;
    const key = /^[A-Za-z_$][\w$]*$/u.test(member) ? member : `['${member}']`;
    methods.push(`${comment ? `${comment}\n` : ''}${head}${key}(${paramText})${ret} ${text}`);
  };

  const statements = (list) => {
    for (const s of list) {
      if (reason) return;
      const comment = leadingComments(src, prevEnd, s.start);
      prevEnd = s.end;
      if (s.type === 'VariableDeclaration' && s.declarations.length === 1 && s.declarations[0].id.type === 'Identifier') {
        const d = s.declarations[0];
        if (isProtoInit(d.init)) {
          protos.add(d.id.name);
          continue;
        }
        const x = bare(d.init);
        if (x?.type === 'MemberExpression' && isId(x.object, protos) && propName(x)) {
          origs.set(d.id.name, propName(x));
          continue;
        }
        reason = `a declaration it does not know: \`${src.slice(s.start, Math.min(s.end, s.start + 60))}\``;
        return;
      }
      if (s.type === 'IfStatement' && !s.alternate && isFlag(s.test) && s.consequent.type === 'ReturnStatement') continue;
      // `installY(ctor);`: this installer first installed another one beneath itself. The layer leaves that to where the
      // service is put together, which applies `withY` below this layer (reported as `needs`).
      if (
        s.type === 'ExpressionStatement' &&
        s.expression.type === 'CallExpression' &&
        s.expression.callee.type === 'Identifier' &&
        /^install[A-Z]/u.test(s.expression.callee.name) &&
        s.expression.arguments.length === 1 &&
        isId(s.expression.arguments[0], new Set([ctor]))
      ) {
        needs.push(s.expression.callee.name.replace(/^install/u, 'with'));
        continue;
      }
      if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression') {
        const { left, right, operator } = s.expression;
        if (operator === '=' && isFlag(left) && bare(right)?.type === 'Literal') continue;
        if (operator === '=' && left.type === 'MemberExpression' && isId(left.object, protos) && propName(left)) {
          method(propName(left), bare(right), comment);
          continue;
        }
      }
      if (s.type === 'IfStatement' && !s.alternate) {
        const t = s.test;
        let member = null;
        if (t.type === 'BinaryExpression' && t.operator === '===' && t.left.type === 'UnaryExpression' && t.left.operator === 'typeof') {
          const m = bare(t.left.argument);
          if (m?.type === 'MemberExpression' && isId(m.object, protos) && t.right.value === 'function') member = propName(m);
        } else if (isId(t, new Set(origs.keys()))) member = origs.get(bare(t).name);
        if (member && base.members.get(member)?.type === 'MethodDefinition') {
          prevEnd = s.consequent.start + 1;
          statements(s.consequent.type === 'BlockStatement' ? s.consequent.body : [s.consequent]);
          prevEnd = s.end;
          continue;
        }
        reason = `a condition it cannot prove always true: \`${src.slice(t.start, t.end)}\``;
        return;
      }
      reason = `a statement it does not know: \`${src.slice(s.start, Math.min(s.end, s.start + 60))}\``;
      return;
    }
  };
  statements(fn.body.body);
  if (reason) return { left: reason };
  if (methods.length === 0) return { left: 'no method set' };
  const layer = fn.id.name.replace(/^install/u, '');
  const text =
    `export function with${layer}(Base: typeof ${className}): typeof ${className} {\n` +
    `  return class ${layer} extends Base {\n${methods.join('\n\n')}\n  };\n}`;
  return { text, privates, base, needs };
}

/** Rewrite one file. Returns { out, done: [names], left: [{name, reason}], privates: Map(path -> {src, names}) , removed: [names] }. */
export function rewrite(file, src) {
  const program = parse(file, src);
  const edits = [];
  const done = [];
  const left = [];
  const needs = [];
  const privates = new Map();
  for (const s of program.body) {
    const fn = s.type === 'ExportNamedDeclaration' ? s.declaration : s.type === 'FunctionDeclaration' ? s : null;
    if (fn?.type !== 'FunctionDeclaration' || !/^install[A-Z]/u.test(fn.id?.name ?? '')) continue;
    const body = fn.body.body;
    if (
      !body.some(
        (st) =>
          st.type === 'VariableDeclaration' &&
          st.declarations.some((d) => bare(d.init)?.type === 'MemberExpression' && propName(bare(d.init)) === 'prototype'),
      )
    )
      continue;
    const r = layerOf(file, src, program, fn);
    if (r.left) {
      left.push({ name: fn.id.name, reason: r.left });
      continue;
    }
    done.push(fn.id.name);
    for (const n of r.needs) needs.push(`${fn.id.name.replace(/^install/u, 'with')} needs ${n} applied beneath it`);
    edits.push({ start: s.start, end: s.end, text: r.text });
    if (r.privates.size) {
      const p = privates.get(r.base.path) ?? { src: r.base.src, names: new Set(), overloads: r.base.overloads };
      for (const n of r.privates) p.names.add(n);
      privates.set(r.base.path, p);
    }
  }
  const rewritten = new Set(done);
  // A wrapper whose body only calls rewritten installers (installPositionMode) goes too: the layers are applied where
  // the service is put together.
  const removed = [];
  const kept = [];
  for (const s of program.body) {
    const fn = s.type === 'ExportNamedDeclaration' ? s.declaration : s.type === 'FunctionDeclaration' ? s : null;
    if (fn?.type !== 'FunctionDeclaration' || !/^install[A-Z]/u.test(fn.id?.name ?? '') || rewritten.has(fn.id.name)) continue;
    const calls = fn.body.body.map((st) =>
      st.type === 'ExpressionStatement' && st.expression.type === 'CallExpression' ? st.expression.callee : null,
    );
    if (calls.length > 0 && calls.every((c) => c?.type === 'Identifier' && rewritten.has(c.name))) {
      removed.push(fn.id.name);
      edits.push({ start: s.start, end: s.end, text: '' });
    } else if (calls.some((c) => c?.type === 'Identifier' && rewritten.has(c.name))) {
      // A wrapper that also does something else (pretrade-credit.ts marks the production posture): its install calls
      // go, the rest stays, and so do its calls.
      fn.body.body.forEach((st, i) => {
        if (calls[i]?.type === 'Identifier' && rewritten.has(calls[i].name)) edits.push({ start: st.start, end: st.end, text: '' });
      });
      kept.push(fn.id.name);
    }
  }
  const gone = new Set([...rewritten, ...removed]);
  // The file's own import-time install (`installX(C);`, or the `try { installX(); } catch { … }` that retries it).
  for (const s of program.body) {
    let call = s.type === 'ExpressionStatement' ? s.expression : null;
    if (s.type === 'TryStatement' && s.block.body.length === 1 && s.block.body[0].type === 'ExpressionStatement')
      call = s.block.body[0].expression;
    if (call?.type === 'CallExpression' && call.callee.type === 'Identifier' && gone.has(call.callee.name))
      edits.push({ start: s.start, end: s.end, text: '' });
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // A FLAG symbol nothing reads any more.
  if (done.length) {
    const p2 = parse(file, out);
    const cut = [];
    for (const s of p2.body) {
      if (s.type !== 'VariableDeclaration' || s.declarations.length !== 1) continue;
      const d = s.declarations[0];
      const init = d.init;
      if (d.id.type !== 'Identifier' || init?.type !== 'CallExpression' || out.slice(init.callee.start, init.callee.end) !== 'Symbol.for')
        continue;
      const uses = out.match(new RegExp(`\\b${d.id.name}\\b`, 'gu'))?.length ?? 0;
      if (uses === 1) cut.push(s);
    }
    for (const s of cut.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + out.slice(s.end).replace(/^\n/u, '');
  }
  out = dropDeadImports(file, out, /^install[A-Z]/u);
  if (done.length) {
    // An import or a type the removed prototype shapes alone named (`EngineSubmitRequest`, bracket-place's `BracketAdds`).
    const count = (text, name) => text.match(new RegExp(`\\b${name}\\b`, 'gu'))?.length ?? 0;
    const p3 = parse(file, out);
    const locals = new Set();
    for (const s of p3.body)
      if (s.type === 'ImportDeclaration')
        for (const sp of s.specifiers) if (sp.local && count(src, sp.local.name) > 1) locals.add(sp.local.name);
    out = dropDeadImports(file, out, locals);
    const p4 = parse(file, out);
    const cut = [];
    for (const s of p4.body) {
      const t = s.type === 'TSTypeAliasDeclaration' ? s : s.type === 'ExportNamedDeclaration' ? null : null;
      if (t && count(out, t.id.name) === 1 && count(src, t.id.name) > 1) cut.push(t);
    }
    for (const t of cut.sort((a, b) => b.start - a.start)) {
      const lead = out.lastIndexOf('\n\n', t.start);
      const from = lead >= 0 && /^\n\n\/\*\*[^]*\*\/\n$/u.test(out.slice(lead, t.start)) ? lead + 1 : t.start;
      out = out.slice(0, from) + out.slice(t.end).replace(/^\n/u, '');
    }
  }
  if (done.length) out = dropUnreadSymbols(file, out);
  return { out, done, left, removed, kept, privates, needs };
}

/** A top-level `const X = Symbol.for(…)` (an installer's flag) that nothing reads any more. */
function dropUnreadSymbols(file, src) {
  let out = src;
  const cut = [];
  for (const s of parse(file, out).body) {
    if (s.type !== 'VariableDeclaration' || s.declarations.length !== 1) continue;
    const d = s.declarations[0];
    if (
      d.id.type !== 'Identifier' ||
      d.init?.type !== 'CallExpression' ||
      out.slice(d.init.callee.start, d.init.callee.end) !== 'Symbol.for'
    )
      continue;
    if ((out.match(new RegExp(`\\b${d.id.name}\\b`, 'gu'))?.length ?? 0) === 1) cut.push(s);
  }
  for (const s of cut.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + out.slice(s.end).replace(/^\n/u, '');
  return out;
}

/** `private` → `protected` on the named members of a base class source. */
export function protect(src, overloads, names) {
  let out = src;
  const at = [...names]
    .flatMap((n) => overloads.get(n) ?? [])
    .filter((m) => m.accessibility === 'private')
    .sort((a, b) => b.start - a.start);
  for (const m of at) {
    const head = out.slice(m.start, m.end);
    out = out.slice(0, m.start) + head.replace(/^private\b/u, 'protected') + out.slice(m.end);
  }
  return out;
}

/** A side-effect-only `import './x.js';` of a file that no longer installs anything. */
export function dropBareImports(file, src, cleared) {
  if (!/^import '\./mu.test(src)) return src;
  const program = parse(file, src);
  let out = src;
  const cut = [];
  for (const s of program.body) {
    if (s.type !== 'ImportDeclaration' || s.specifiers.length !== 0 || !s.source.value.startsWith('.')) continue;
    const path = resolve(dirname(file), s.source.value.replace(/\.js$/u, '.ts'));
    if (cleared.has(path)) cut.push(s);
  }
  for (const s of cut.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + out.slice(s.end).replace(/^\n/u, '');
  return out;
}

// ── Where the layers go: the order each entry's imports used to install them in ──────────────────────────────────────

const fnOf = (s) => (s.type === 'ExportNamedDeclaration' ? s.declaration : s.type === 'FunctionDeclaration' ? s : null);
const isInstaller = (fn) =>
  fn?.type === 'FunctionDeclaration' &&
  /^install[A-Z]/u.test(fn.id?.name ?? '') &&
  fn.body.body.some(
    (st) =>
      st.type === 'VariableDeclaration' &&
      st.declarations.some((d) => bare(d.init)?.type === 'MemberExpression' && propName(bare(d.init)) === 'prototype'),
  );

/** Every installer and wrapper in `files`, and each file's top-level install calls, read before anything is rewritten. */
export function scan(files) {
  const installers = new Map(); // name -> { file, base }
  const wrappers = new Map(); // name -> [installer names]
  const programs = new Map();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!/\binstall[A-Z]/u.test(src)) continue;
    const program = parse(file, src);
    programs.set(file, { src, program });
    for (const s of program.body) {
      const fn = fnOf(s);
      if (isInstaller(fn)) {
        const param = fn.params[0]?.type === 'AssignmentPattern' ? fn.params[0].left : fn.params[0];
        installers.set(fn.id.name, { file, base: param?.typeAnnotation?.typeAnnotation?.exprName?.name });
      }
    }
  }
  for (const [, { program }] of programs)
    for (const s of program.body) {
      const fn = fnOf(s);
      if (fn?.type !== 'FunctionDeclaration' || !/^install[A-Z]/u.test(fn.id?.name ?? '') || installers.has(fn.id.name)) continue;
      const calls = fn.body.body.map((st) =>
        st.type === 'ExpressionStatement' && st.expression.type === 'CallExpression' ? st.expression.callee : null,
      );
      const inst = calls.filter((c) => c?.type === 'Identifier' && installers.has(c.name)).map((c) => c.name);
      if (inst.length) wrappers.set(fn.id.name, { calls: inst, pure: inst.length === calls.length });
    }
  const atImport = new Map(); // file -> [installer names], in the order its top level ran them
  for (const [file, { program }] of programs) {
    const list = [];
    for (const s of program.body) {
      let call = s.type === 'ExpressionStatement' ? s.expression : null;
      if (s.type === 'TryStatement' && s.block.body.length === 1 && s.block.body[0].type === 'ExpressionStatement')
        call = s.block.body[0].expression;
      const name = call?.type === 'CallExpression' && call.callee.type === 'Identifier' ? call.callee.name : null;
      if (name && installers.has(name)) list.push(name);
      else if (name && wrappers.has(name)) list.push(...wrappers.get(name).calls);
    }
    if (list.length) atImport.set(file, list);
  }
  return { installers, wrappers, atImport };
}

const importCache = new Map();
/** The relative modules `file` loads when it runs (type-only imports load nothing). */
function loads(file) {
  if (importCache.has(file)) return importCache.get(file);
  const out = [];
  importCache.set(file, out);
  if (!existsSync(file)) return out;
  const program = parse(file, readFileSync(file, 'utf8'));
  for (const s of program.body) {
    let spec = null;
    if (s.type === 'ImportDeclaration' && s.importKind !== 'type') spec = s.source.value;
    else if ((s.type === 'ExportNamedDeclaration' || s.type === 'ExportAllDeclaration') && s.source && s.exportKind !== 'type')
      spec = s.source.value;
    if (!spec?.startsWith('.')) continue;
    const f = resolve(dirname(file), spec.replace(/\.js$/u, '.ts'));
    if (existsSync(f)) out.push(f);
  }
  return out;
}
/** Modules in the order they finish loading from `entry` (ES modules run depth-first, each once). */
export function loadOrder(entry) {
  const seen = new Set();
  const order = [];
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const d of loads(f)) visit(d);
    order.push(f);
  };
  visit(entry);
  return order;
}
/** The installers that had run, in order, once `entry` and everything it imports had loaded. Each ran once (its flag). */
export function stackAt(entry, atImport) {
  const stack = [];
  for (const f of loadOrder(entry)) for (const n of atImport.get(f) ?? []) if (!stack.includes(n)) stack.push(n);
  return stack;
}

const layerName = (installer) => installer.replace(/^install/u, 'with');
const relImport = (from, to) => {
  let r = relative(dirname(from), to).replace(/\.ts$/u, '.js');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
};

/** Add `names` to an import from `spec` in `src` (merged into one that is there, else a new line after the imports). */
function addImports(file, src, wanted) {
  let out = src;
  for (const [spec, names] of wanted) {
    const program = parse(file, out);
    const imports = program.body.filter((s) => s.type === 'ImportDeclaration');
    const there = imports.find(
      (s) => s.source.value === spec && s.importKind !== 'type' && s.specifiers.some((sp) => sp.type === 'ImportSpecifier'),
    );
    const have = new Set(imports.flatMap((s) => s.specifiers.map((sp) => sp.local?.name)));
    const add = [...names].filter((n) => !have.has(n));
    if (!add.length) continue;
    if (there) {
      const last = there.specifiers.at(-1);
      out = out.slice(0, last.end) + `, ${add.join(', ')}` + out.slice(last.end);
    } else {
      const at = imports.length ? imports.at(-1).end : 0;
      out = out.slice(0, at) + `\nimport { ${add.join(', ')} } from '${spec}';` + out.slice(at);
    }
  }
  return out;
}

/**
 * Apply `stack` where `file` constructs a class the stack layers: `new TradeService(` becomes `new LayeredTradeService(`,
 * declared once after the imports. Returns { out, notes }.
 */
export function applyStack(file, src, stack, installers, layeredAt) {
  const program = parse(file, src);
  const notes = [];
  const byBase = new Map();
  for (const n of stack) {
    const base = installers.get(n).base;
    (byBase.get(base) ?? byBase.set(base, []).get(base)).push(n);
  }
  const imports = new Map();
  for (const s of program.body)
    if (s.type === 'ImportDeclaration')
      for (const sp of s.specifiers)
        if (sp.local) imports.set(sp.local.name, { source: s.source.value, imported: sp.imported?.name ?? sp.local.name });
  const news = [];
  const otherUses = new Map();
  walk(program, (n, parent) => {
    if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && byBase.has(imports.get(n.callee.name)?.imported))
      news.push(n.callee);
    else if (
      n.type === 'Identifier' &&
      byBase.has(imports.get(n.name)?.imported) &&
      !(parent?.type === 'NewExpression' && parent.callee === n) &&
      parent?.type !== 'ImportSpecifier' &&
      parent?.type !== 'TSTypeReference' &&
      parent?.type !== 'TSTypeQuery' &&
      parent?.type !== 'TSQualifiedName'
    )
      otherUses.set(n.name, (otherUses.get(n.name) ?? 0) + 1);
  });
  const constructed = [...new Set(news.map((c) => c.name))];
  for (const [name, count] of otherUses) notes.push(`${name} is used ${count} other way(s) here (not \`new\`): check by hand`);
  if (!constructed.length) return { out: src, notes };
  const wanted = new Map();
  const want = (spec, name) => (wanted.get(spec) ?? wanted.set(spec, new Set()).get(spec)).add(name);
  const decls = [];
  const rename = new Map();
  for (const local of constructed) {
    const { source, imported } = imports.get(local);
    const layers = byBase.get(imported);
    for (const n of layers) want(relImport(file, installers.get(n).file), layerName(n));
    const fromAdmission = source.endsWith('test-admission.js');
    const target = `Layered${imported}`;
    rename.set(local, target);
    const list = layers.map(layerName).join(', ');
    if (fromAdmission) {
      want(source, `layered${imported}`);
      decls.push(`const ${target} = layered${imported}(${list});`);
    } else {
      want(relImport(file, layeredAt), 'layered');
      decls.push(`const ${target} = layered(${local}, ${list});`);
    }
  }
  let out = src;
  for (const c of news.sort((a, b) => b.start - a.start))
    if (rename.has(c.name)) out = out.slice(0, c.start) + rename.get(c.name) + out.slice(c.end);
  const p2 = parse(file, out);
  const lastImport = p2.body.filter((s) => s.type === 'ImportDeclaration').at(-1);
  const at = lastImport ? lastImport.end : 0;
  const comment = '// The layers this file used to get installed on import, applied here in the same order (garden/no-runtime-swap).';
  out = out.slice(0, at) + `\n\n${comment}\n${decls.join('\n')}` + out.slice(at);
  out = addImports(file, out, wanted);
  return { out, notes };
}

/**
 * Delete top-level calls of `gone` installers/wrappers in a file that is not their own, and their unused imports. Only a
 * call on the real class (no argument, or an imported class: the service's own or a test adapter's subclass of it) goes:
 * the installer's own module had already installed it on import, so its flag made the call change nothing. A call on a
 * class of the file's own (a test's stand-in) did install, and is left to fix by hand.
 */
export function dropInstallCalls(file, src, gone) {
  const program = parse(file, src);
  const imported = new Set();
  for (const s of program.body)
    if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) if (sp.local) imported.add(sp.local.name);
  const cut = [];
  // At the top level, or inside a function (wire-replay.test.ts installs again where it assembles its copy of index.ts).
  const statements = [];
  walk(program, (n) => {
    if (n.type === 'Program' || n.type === 'BlockStatement') statements.push(...n.body);
  });
  for (const s of statements) {
    let call = s.type === 'ExpressionStatement' ? s.expression : null;
    if (s.type === 'TryStatement' && s.block.body.length === 1 && s.block.body[0].type === 'ExpressionStatement')
      call = s.block.body[0].expression;
    if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !gone.has(call.callee.name)) continue;
    if (call.arguments.every((a) => a.type === 'Identifier' && imported.has(a.name))) cut.push(s);
  }
  if (!cut.length) return src;
  let out = src;
  for (const s of cut.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + out.slice(s.end).replace(/^\n/u, '');
  return dropDeadImports(file, out, gone);
}

/** Import specifiers matching `which` (a set of names or a pattern) that nothing in the file names any more. */
export function dropDeadImports(file, src, which) {
  let out = src;
  const p2 = parse(file, out);
  const edits = [];
  const matches = (n) => (which instanceof RegExp ? which.test(n) : which.has(n));
  for (const s of p2.body) {
    if (s.type !== 'ImportDeclaration') continue;
    const dead = s.specifiers.filter(
      (sp) => sp.local && matches(sp.local.name) && (out.match(new RegExp(`\\b${sp.local.name}\\b`, 'gu'))?.length ?? 0) === 1,
    );
    if (!dead.length) continue;
    if (dead.length === s.specifiers.length) edits.push({ start: s.start, end: s.end, text: '' });
    else if (s.specifiers.every((sp) => sp.type === 'ImportSpecifier')) {
      const keep = s.specifiers.filter((sp) => !dead.includes(sp)).map((sp) => out.slice(sp.start, sp.end));
      edits.push({
        start: s.start,
        end: s.end,
        text: `import ${s.importKind === 'type' ? 'type ' : ''}{ ${keep.join(', ')} } from '${s.source.value}';`,
      });
    }
  }
  for (const e of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end).replace(e.text ? /^/u : /^\n/u, '');
  return out;
}

/**
 * A test that installs a layer on a stand-in class of its own (`installX(Door as unknown as typeof TradeService);` then
 * `new Door()`): the installer changed `Door` itself. The layer makes a subclass instead, so the calls on one class in a
 * block become one `const LayeredDoor = layeredStandIn(Door, withX, withY);` (layered.testkit.ts) and each later
 * `new Door(` in that block builds `LayeredDoor`. A name that only aliases the class (`const ctor = Owner as unknown as
 * typeof PositionService;`) stands for the class it names, and goes once nothing reads it. Returns { out, notes, used }.
 */
export function rewriteStandIns(file, src, rewritten) {
  const program = parse(file, src);
  const edits = [];
  const notes = [];
  const blocks = [];
  let used = false;
  walk(program, (n) => {
    if (n.type === 'BlockStatement' || n.type === 'Program') blocks.push(n);
  });
  for (const block of blocks) {
    const aliasOf = new Map(); // `const ctor = Owner as …` -> Owner
    const aliasDecl = new Map();
    const groups = new Map(); // class -> { first, rest, layers, names }
    for (const st of block.body) {
      if (st.type === 'VariableDeclaration' && st.declarations.length === 1) {
        const d = st.declarations[0];
        if (d.id.type === 'Identifier' && bare(d.init)?.type === 'Identifier' && d.init?.type !== 'Identifier') {
          aliasOf.set(d.id.name, bare(d.init).name);
          aliasDecl.set(d.id.name, st);
        }
      }
      const call = st.type === 'ExpressionStatement' ? st.expression : null;
      if (
        call?.type !== 'CallExpression' ||
        call.callee.type !== 'Identifier' ||
        !rewritten.has(call.callee.name) ||
        call.arguments.length !== 1
      )
        continue;
      const named = bare(call.arguments[0]);
      if (named?.type !== 'Identifier') continue;
      const cls = aliasOf.get(named.name) ?? named.name;
      const g = groups.get(cls) ?? groups.set(cls, { first: st, rest: [], layers: [], names: new Set([cls]) }).get(cls);
      if (g.first !== st) g.rest.push(st);
      g.layers.push(layerName(call.callee.name));
      g.names.add(named.name);
    }
    for (const [cls, g] of groups) {
      used = true;
      const alias = `Layered${cls[0].toUpperCase()}${cls.slice(1)}`;
      edits.push({ start: g.first.start, end: g.first.end, text: `const ${alias} = layeredStandIn(${cls}, ${g.layers.join(', ')});` });
      for (const st of g.rest) edits.push({ start: st.start, end: st.end, text: '' });
      const last = (g.rest.at(-1) ?? g.first).end;
      walk(block, (n, parent) => {
        if (n.type !== 'Identifier' || !g.names.has(n.name) || n.start < g.first.start) return;
        if (edits.some((e) => e.start <= n.start && n.end <= e.end)) return;
        if (n.start < last)
          return notes.push(`\`${n.name}\` is used between its installs (line ${src.slice(0, n.start).split('\n').length}): check by hand`);
        if (parent?.type === 'NewExpression' && parent.callee === n) edits.push({ start: n.start, end: n.end, text: alias });
        else if (parent?.type !== 'TSTypeQuery' && parent?.type !== 'TSTypeReference')
          notes.push(
            `\`${n.name}\` is used after its install other than by \`new\` (line ${src.slice(0, n.start).split('\n').length}): check by hand`,
          );
      });
      // An alias of the class that nothing reads now.
      for (const name of g.names) {
        const decl = aliasDecl.get(name);
        if (!decl) continue;
        let reads = 0;
        walk(block, (n) => {
          if (
            n.type === 'Identifier' &&
            n.name === name &&
            !(n.start >= decl.start && n.end <= decl.end) &&
            !edits.some((e) => e.start <= n.start && n.end <= e.end)
          )
            reads += 1;
        });
        if (reads === 0) edits.push({ start: decl.start, end: decl.end, text: '' });
      }
    }
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end).replace(e.text ? /^/u : /^\n/u, '');
  return { out, notes, used };
}

const tsFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('node_modules'));
const isTest = (f) => /\.(test|spec)\.ts$/u.test(f);

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  // --root <dir>: a copy of the repo to rewrite (a dry run on a scratch copy); the default is this checkout.
  const rootAt = args.indexOf('--root');
  const ROOT = rootAt >= 0 ? resolve(args[rootAt + 1]) : REPO;
  let files = args.filter((a, i) => !a.startsWith('--') && (rootAt < 0 || i !== rootAt + 1)).map((f) => resolve(f));
  if (files.length === 0) {
    const listed = execFileSync('node', [join(REPO, 'tooling/lint/count-rule.mjs'), 'garden/no-runtime-swap'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    files = listed
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/u)[1])
      .filter(Boolean)
      .map((f) => join(ROOT, f));
  }
  // Each service the listed files sit in: its src folder is scanned whole, tests included.
  const srcDirs = [...new Set(files.map((f) => relative(ROOT, f).split('/').slice(0, 3).join('/')))].map((d) => join(ROOT, d));
  const all = srcDirs.flatMap(tsFiles);
  const { installers, wrappers, atImport } = scan(all.filter((f) => !isTest(f)));

  const changed = new Map();
  const read = (f) => changed.get(f) ?? readFileSync(f, 'utf8');
  const cleared = new Set();
  const protects = new Map();
  let leftCount = 0;
  const rewritten = new Set();
  for (const file of files) {
    const src = read(file);
    const r = rewrite(file, src);
    for (const l of r.left) {
      leftCount += 1;
      console.log(`left   ${relative(ROOT, file)} ${l.name}: ${l.reason}`);
    }
    for (const n of r.done) {
      rewritten.add(n);
      console.log(`layer  ${relative(ROOT, file)} ${n} → ${layerName(n)}`);
    }
    for (const n of r.needs) console.log(`needs  ${relative(ROOT, file)} ${n}`);
    for (const n of r.kept) console.log(`kept   ${relative(ROOT, file)} ${n}: its install calls went, the rest stays`);
    for (const n of r.removed) console.log(`gone   ${relative(ROOT, file)} ${n} (only called rewritten installers)`);
    if (r.out !== src) changed.set(file, r.out);
    if (r.done.length && r.left.length === 0) cleared.add(file);
    for (const [path, p] of r.privates) {
      const q = protects.get(path) ?? { overloads: p.overloads, names: new Set() };
      for (const n of p.names) q.names.add(n);
      protects.set(path, q);
    }
  }
  for (const [path, q] of protects) {
    const src = read(path);
    const out = protect(src, q.overloads, q.names);
    if (out !== src) {
      changed.set(path, out);
      console.log(`base   ${relative(ROOT, path)}: private → protected for ${[...q.names].join(', ')}`);
    }
  }
  // Only installers rewritten in full are moved; a stack holding one that was left stays as it is.
  const gone = new Set([
    ...rewritten,
    ...[...wrappers].filter(([, w]) => w.pure && w.calls.every((n) => rewritten.has(n))).map(([w]) => w),
  ]);
  for (const dir of srcDirs) {
    const layeredAt = join(dir, 'layered.ts');
    for (const file of tsFiles(dir)) {
      // Where an entry constructs a layered class: index.ts (the service put together) and each test.
      const entry = isTest(file) || relative(dir, file) === 'index.ts';
      let src = read(file);
      if (/\binstall[A-Z]/u.test(src)) src = dropInstallCalls(file, src, gone);
      if (isTest(file) && /\binstall[A-Z]/u.test(src)) {
        const r = rewriteStandIns(file, src, rewritten);
        for (const n of r.notes) console.log(`note   ${relative(ROOT, file)}: ${n}`);
        if (r.out !== src) {
          console.log(`stand  ${relative(ROOT, file)}: a stand-in class layered in place of installed on`);
          src = dropDeadImports(file, r.out, gone);
          const wanted = new Map();
          const kit = join(dir, 'layered.testkit.ts');
          if (!existsSync(kit)) throw new Error(`${relative(ROOT, kit)} is missing: it holds layeredStandIn()`);
          if (r.used) wanted.set(relImport(file, kit), new Set(['layeredStandIn']));
          for (const n of rewritten)
            if (new RegExp(`\\b${layerName(n)}\\b`, 'u').test(src)) {
              const spec = relImport(file, installers.get(n).file);
              (wanted.get(spec) ?? wanted.set(spec, new Set()).get(spec)).add(layerName(n));
            }
          src = addImports(file, src, wanted);
        }
      }
      if (entry) {
        const stack = stackAt(file, atImport).filter((n) => rewritten.has(n));
        if (stack.length) {
          if (!existsSync(layeredAt))
            throw new Error(`${relative(ROOT, layeredAt)} is missing: it holds layered(), which applies the layers`);
          const r = applyStack(file, src, stack, installers, layeredAt);
          for (const n of r.notes) console.log(`note   ${relative(ROOT, file)}: ${n}`);
          if (r.out !== src) console.log(`stack  ${relative(ROOT, file)}: ${stack.map(layerName).join(', ')}`);
          src = r.out;
        }
      } else if (!files.includes(file) && /\bnew (TradeService|PositionService|AuthService)\(/u.test(src)) {
        const users = tsFiles(dir).filter((t) => isTest(t) && loadOrder(t).includes(file));
        const stacks = new Set(
          users.map((t) =>
            stackAt(t, atImport)
              .filter((n) => rewritten.has(n))
              .join(','),
          ),
        );
        console.log(
          `note   ${relative(ROOT, file)}: constructs a layered class for ${users.length} test(s), stacks: ${[...stacks].map((s) => s || '(none)').join(' | ')}: check by hand`,
        );
      }
      if (cleared.size) src = dropBareImports(file, src, cleared);
      if (isTest(file) && new RegExp(`\\b(${[...gone].join('|')})\\(`, 'u').test(src))
        console.log(`note   ${relative(ROOT, file)}: calls an installer inside a test: fix by hand`);
      if (src !== read(file)) {
        // An import the edits above left unread (a class a test only passed to an installer).
        const before = readFileSync(file, 'utf8');
        const count = (text, name) => text.match(new RegExp(`\\b${name}\\b`, 'gu'))?.length ?? 0;
        const locals = new Set();
        for (const s of parse(file, src).body)
          if (s.type === 'ImportDeclaration')
            for (const sp of s.specifiers) if (sp.local && count(before, sp.local.name) > 1) locals.add(sp.local.name);
        src = dropDeadImports(file, src, locals);
        changed.set(file, src);
      }
    }
  }
  if (check) {
    console.log(`${changed.size} file(s) would change; ${leftCount} installer(s) left`);
    process.exit(changed.size || leftCount ? 1 : 0);
  }
  for (const [file, out] of changed) writeFileSync(file, out);
  if (changed.size)
    execFileSync(
      join(REPO, 'node_modules/.bin/prettier'),
      ['--config', join(REPO, '.prettierrc.json'), '--write', '--log-level', 'warn', ...changed.keys()],
      {
        cwd: REPO,
        stdio: 'inherit',
      },
    );
  console.log(`${changed.size} file(s) changed; ${leftCount} installer(s) left`);
}

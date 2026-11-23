// A schema made by a helper: `interests: unique(audience, 5)`, where
//   function unique(schema, max) { return z.array(schema).min(1).max(max).refine(..., 'Duplicate selections are not allowed'); }
// The schema at that place is what the helper returns, read where the helper is written, so a `.refine` in it is named in
// the record like one written in the schema's own chain. Only a helper that does nothing but return one expression is
// read (a function, or a const arrow, in the file or imported from beside it): anything it computes first could change
// what it returns, so that one stays, named. A step further into the returned schema that lands on one of the helper's
// own parameters stops there (portable.mjs's `follow` reads no parameter), which leaves that finding named, never guessed.
import { bindingOf, load, resolveRelative } from './ast.mjs';

const unwrap = (n) => {
  while (n && (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression')) n = n.expression;
  return n;
};

/** The one expression a function returns, when returning it is all the function does. */
function onlyReturn(fn) {
  fn = unwrap(fn);
  if (!fn || !/^(ArrowFunctionExpression|FunctionExpression|FunctionDeclaration)$/.test(fn.type)) return undefined;
  if (fn.async || fn.generator) return undefined;
  if (fn.body?.type !== 'BlockStatement') return fn.body;
  const [only, ...more] = fn.body.body;
  return !more.length && only?.type === 'ReturnStatement' && only.argument ? only.argument : undefined;
}

/**
 * What the helper a schema is made by returns: `{ q, n, helper }`, the expression in the file it is written in and the
 * helper's name. Undefined when `call` is not a call of a helper this can read.
 */
export function returnedBy(q, call) {
  call = unwrap(call);
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') return undefined;
  const helper = call.callee.name;
  let b = bindingOf(q, call, helper);
  if (b.kind === 'import' && b.from.startsWith('.')) {
    const file = resolveRelative(q.file, b.from);
    if (!file) return undefined;
    q = load(file);
    b = bindingOf(q, q.program.body[0] ?? q.program, b.imported);
  }
  const fn = b.kind === 'function' ? b.declaration : b.kind === 'var' ? b.declarator.init : undefined;
  const n = onlyReturn(fn);
  return n ? { q, n, helper } : undefined;
}

// `z.lazy(() => X)` in a schema's source, for the portability step (portable.mjs): a forward reference or a recursive
// tree stands for the schema its function returns, which is how the export writes it (procedure-strict-schema.ts walks
// what a lazy points to, at the lazy's own place). So a finding on the far side of a lazy is followed into `X`, and a
// refinement reported at a lazy's place is the one `X` carries.
//
// Read only where the function is written as its answer: `() => X`, `() => { return X; }` or `function () { return X; }`.
// A function that does anything else first is not read.

const unwrap = (n) => {
  while (n && (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression')) n = n.expression;
  return n;
};

/** The expression a `z.lazy(...)` call's function returns, or undefined when the call is not written that way. */
export function lazyBody(call) {
  if (call?.type !== 'CallExpression' || call.arguments.length !== 1) return undefined;
  const fn = unwrap(call.arguments[0]);
  if (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') return undefined;
  if (fn.params.length > 0 || fn.async || fn.generator) return undefined;
  if (fn.body.type !== 'BlockStatement') return fn.body;
  const [only, ...rest] = fn.body.body;
  return rest.length === 0 && only?.type === 'ReturnStatement' && only.argument ? only.argument : undefined;
}

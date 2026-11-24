// garden/no-sign-in-in-step: a journey step never signs a founder in. Each founder sign-in must send an authenticator step
// no earlier sign-in spent, so a step that signs in may wait out a whole 30 s window inside its own time limit, and fails
// or passes by where in the window it started. The founders' sessions come from the `founders` fixture in
// apps/customer/tests/real-app/journey.mjs, which signs each founder in once per journey file in each worker.
// Judged: a call to one of SIGN_INS in a journey file (`*.pw.mjs`), reached from a `test()` or `test.beforeEach()`
// callback directly or through a function of the same file. A sign-in behind a once-guard (an `if`, `??`, `??=` or `||`
// on a module-level variable the file keeps its session in; approverSessions on a kept gates context) or in a
// `beforeAll` happens once per file and passes.
const JOURNEY_FILE = /(^|\/)apps\/customer\/tests\/.*\.pw\.[cm]?js$/u;
const SIGN_INS = new Set(['founderSignIn', 'openFounderDesk', 'approverSessions']);
const STEP_CALLS = new Set(['test', 'test.only', 'test.fixme', 'test.fail', 'test.slow', 'test.beforeEach']);

const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
const calledName = (callee) => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed) return callee.property?.name;
  return undefined;
};
const dotted = (callee) => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed && callee.object?.type === 'Identifier')
    return `${callee.object.name}.${callee.property?.name}`;
  return undefined;
};
/** The identifiers an expression reads, as names. */
function namesIn(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Identifier') out.add(node.name);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue;
    if (Array.isArray(v)) for (const c of v) namesIn(c, out);
    else if (v && typeof v.type === 'string') namesIn(v, out);
  }
  return out;
}

const noSignInInStep = {
  meta: { type: 'problem', docs: { description: 'A journey step takes its founder sessions from the founders fixture.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!JOURNEY_FILE.test(file)) return {};
    const stepCallbacks = new Set();
    const localFns = new Map(); // name -> function node, for the file's top-level functions
    const kept = new Set(); // module-level variables a session may be kept in
    const signIns = [];
    return {
      Program(program) {
        for (const s of program.body) {
          const decl = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
          if (decl?.type === 'FunctionDeclaration' && decl.id) localFns.set(decl.id.name, decl);
          if (decl?.type !== 'VariableDeclaration') continue;
          for (const d of decl.declarations) {
            if (d.id?.type !== 'Identifier') continue;
            if (isFn(d.init)) localFns.set(d.id.name, d.init);
            else if (decl.kind === 'let' || d.init?.type === 'ObjectExpression' || d.init?.type === 'NewExpression') kept.add(d.id.name);
          }
        }
      },
      CallExpression(node) {
        if (STEP_CALLS.has(dotted(node.callee))) {
          const cb = node.arguments.at(-1);
          if (isFn(cb)) stepCallbacks.add(cb);
        }
        if (SIGN_INS.has(calledName(node.callee))) signIns.push(node);
      },
      'Program:exit'() {
        // The file's own functions a step reaches, through any chain of same-file calls.
        const callsIn = (fn) => {
          const found = new Set();
          (function walk(n) {
            if (!n || typeof n !== 'object') return;
            if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && localFns.has(n.callee.name)) found.add(n.callee.name);
            for (const [k, v] of Object.entries(n)) {
              if (k === 'parent') continue;
              if (Array.isArray(v)) for (const c of v) walk(c);
              else if (v && typeof v.type === 'string') walk(v);
            }
          })(fn.body);
          return found;
        };
        const reached = new Set();
        const queue = [...stepCallbacks].flatMap((cb) => [...callsIn(cb)]);
        while (queue.length) {
          const name = queue.pop();
          if (reached.has(name)) continue;
          reached.add(name);
          queue.push(...callsIn(localFns.get(name)));
        }
        const reachedFns = new Set([...reached].map((n) => localFns.get(n)));
        const guardedBy = (n) => {
          const p = n.parent;
          if (!p) return false;
          const reads = (expr) => [...namesIn(expr)].some((name) => kept.has(name));
          if ((p.type === 'IfStatement' || p.type === 'ConditionalExpression') && p.test !== n) return reads(p.test);
          if (p.type === 'LogicalExpression' && p.right === n) return reads(p.left);
          if (p.type === 'AssignmentExpression' && p.right === n && p.operator !== '=') return reads(p.left);
          return false;
        };
        for (const call of signIns) {
          // approverSessions on a gates context the file keeps (made with shareSessions) signs in once for it.
          let guarded =
            calledName(call.callee) === 'approverSessions' && call.arguments.some((a) => [...namesIn(a)].some((name) => kept.has(name)));
          for (let n = call; n?.parent; n = n.parent) {
            if (guardedBy(n)) guarded = true;
            if (!isFn(n.parent)) continue;
            const owner = n.parent;
            if (!guarded && (stepCallbacks.has(owner) || reachedFns.has(owner))) {
              const name = calledName(call.callee);
              context.report({
                node: call,
                message:
                  `${name} inside a journey step signs a founder in again, and each sign-in may wait out a 30 s ` +
                  "authenticator window inside the step's time. Take the session from the `founders` fixture in " +
                  'apps/customer/tests/real-app/journey.mjs (`founders.console(key)` for a signed-in console page, ' +
                  '`founders.ops()` for the approver sessions), which signs each founder in once per file in each worker',
              });
            }
            if (stepCallbacks.has(owner) || reachedFns.has(owner) || localFns.has(owner.id?.name)) break;
          }
        }
      },
    };
  },
};

export const signInInStepRules = { 'no-sign-in-in-step': noSignInInStep };

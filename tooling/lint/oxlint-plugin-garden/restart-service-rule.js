// garden/restart-through-helper: a journey stops, starts or restarts a stack service only through `restartService`,
// `stopService` or `startService` (apps/customer/tests/real-app/stack.mjs). Each awaits the stack tool, which waits for
// the service's health, and then drops the kept-alive sockets Edge closed meanwhile. A restart run as a blocking
// `tool('local-test-stack.mjs', 'restart', …)` froze the worker past Edge's 72 s keep-alive, and the next call through
// Edge failed with "other side closed": J-support-public-08 #4 (#7449, fixed by hand in #8074), J-support-public-12
// (#8395, fixed by hand in #8422), and the drains J-copy-bots-otc-01, -02 and -14 each carried a copy of.
// Judged: in the real-app folder (journeys and their helpers; stack.mjs, the helpers' home, is not judged), a call of
// `tool` or `toolAwaited` whose first argument is 'local-test-stack.mjs' and whose second is 'restart', 'stop' or
// 'start', and a call of stack.mjs's blocking `restartWith` or `restartWithSetting`.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const REAL_APP = /(^|\/)apps\/customer\/tests\/real-app\/[^/]+\.[cm]?js$/u;
const HOME = /(^|\/)apps\/customer\/tests\/real-app\/stack\.mjs$/u;
const TOOLS = new Set(['tool', 'toolAwaited']);
const VERBS = new Set(['restart', 'stop', 'start']);
const BLOCKING = new Set(['restartWith', 'restartWithSetting']);
const literal = (n) => (n?.type === 'Literal' ? n.value : undefined);

const restartThroughHelper = {
  meta: { type: 'problem', docs: { description: 'A journey restarts a stack service only through restartService.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!REAL_APP.test(file) || HOME.test(file)) return {};
    return {
      CallExpression(node) {
        const name = node.callee?.type === 'Identifier' ? node.callee.name : undefined;
        const [script, verb] = node.arguments;
        let what;
        if (TOOLS.has(name) && literal(script) === 'local-test-stack.mjs' && VERBS.has(literal(verb)))
          what = `\`${name}('local-test-stack.mjs', '${literal(verb)}', …)\``;
        else if (BLOCKING.has(name)) what = `\`${name}(…)\`, a blocking restart,`;
        else return;
        context.report({
          node,
          message:
            `${what} restarts a stack service by hand: a restart that blocks the worker, or does not drop the sockets Edge ` +
            'closed while it ran, sends the next call on a dead socket ("other side closed", #7449). Use ' +
            '`await restartService(service, settings)`, `await stopService(service)` or `await startService(service)` from ' +
            'apps/customer/tests/real-app/stack.mjs, which await the health-checked restart and drop the closed sockets',
        });
      },
    };
  },
};

export const restartServiceRules = { 'restart-through-helper': restartThroughHelper };

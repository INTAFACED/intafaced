// oxlint JS plugin: the weeds INTAFACED is known to grow. Plain ESM, no dependencies.
// Loaded by the root .oxlintrc.json ("jsPlugins"), rules "garden/<name>". Advice only: nothing in CI runs it yet
// (project-state garden stake-01 part A); the local check (stake-02) prints its findings.
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
const isTest = (context) => TEST_FILE.test(context.filename ?? context.getFilename());

// 1. Local copies of helpers that should live in one shared place.
const HELPER_NAMES = new Set(['isRecord', 'isObject', 'isPlainObject', 'asRecord', 'sleep', 'wait', 'delay', 'unreachable']);
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
const noLocalHelper = {
  meta: { type: 'suggestion', docs: { description: 'Import the shared helper instead of defining a local isRecord/sleep/unreachable.' } },
  create(context) {
    const report = (node, name) => context.report({ node, message: `local helper '${name}': import the shared one` });
    return {
      FunctionDeclaration(node) {
        if (node.id && HELPER_NAMES.has(node.id.name)) report(node.id, node.id.name);
      },
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier' && HELPER_NAMES.has(node.id.name) && isFn(node.init)) report(node.id, node.id.name);
      },
    };
  },
};

// 2. `x as unknown as T`: the double cast that switches the type checker off.
const noDoubleCast = {
  meta: { type: 'suggestion', docs: { description: 'No `as unknown as T`.' } },
  create(context) {
    return {
      TSAsExpression(node) {
        const inner = node.expression;
        if (inner?.type === 'TSAsExpression' && inner.typeAnnotation?.type === 'TSUnknownKeyword') {
          context.report({
            node,
            message: '`as unknown as` turns type checking off here: narrow with a type guard or a schema parse, or fix the source type',
          });
        }
      },
    };
  },
};

// 3. Every suppression says why (after `--` for lint directives, after the directive for @ts-*), or a comment above.
const LINT_DIRECTIVE = /^\s*\*?\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])(.*)$/su;
const TS_DIRECTIVE = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const ANY_DIRECTIVE = /^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck))/u;
const requireSuppressionReason = {
  meta: { type: 'suggestion', docs: { description: 'Require every lint or type suppression to say why.' } },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        const ownLineByEnd = new Map();
        for (const c of comments) {
          const { line, column } = c.loc.start;
          if ((sourceCode.lines[line - 1] ?? '').slice(0, column).trim() === '') ownLineByEnd.set(c.loc.end.line, c);
        }
        const explainedAbove = (c) => {
          let above = ownLineByEnd.get(c.loc.start.line - 1);
          while (above && (ANY_DIRECTIVE.test(above.value) || /^[\s*]*$/u.test(above.value)))
            above = ownLineByEnd.get(above.loc.start.line - 1);
          return above !== undefined;
        };
        for (const c of comments) {
          const lint = LINT_DIRECTIVE.exec(c.value);
          if (lint) {
            const rest = lint[1] ?? '';
            const i = rest.indexOf('--');
            if (i >= 0 && rest.slice(i + 2).trim()) continue;
            if (explainedAbove(c)) continue;
            context.report({ loc: c.loc, message: 'lint suppression without a reason: end it with `-- why`' });
            continue;
          }
          const ts = TS_DIRECTIVE.exec(c.value);
          if (ts) {
            if ((ts[1] ?? '').replace(/^[\s:-]+/u, '').trim()) continue;
            if (explainedAbove(c)) continue;
            context.report({ loc: c.loc, message: 'type suppression without a reason: say why after the directive' });
          }
        }
      },
    };
  },
};

// 4. Real-clock waits in tests: new Promise(r => setTimeout(r, n)), timers/promises setTimeout, await sleep/delay/wait(n).
const containsSetTimeout = (node) => {
  let found = false;
  const walk = (n) => {
    if (!n || found || typeof n !== 'object') return;
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'setTimeout') {
      found = true;
      return;
    }
    for (const k in n) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(node);
  return found;
};
const SLEEP_CALLS = new Set(['sleep', 'delay', 'wait', 'pause', 'waitMs']);
const noRealClockWaitInTests = {
  meta: { type: 'problem', docs: { description: 'Tests wait on an event or a fake clock, never on the wall clock.' } },
  create(context) {
    if (!isTest(context)) return {};
    return {
      NewExpression(node) {
        if (
          node.callee?.type === 'Identifier' &&
          node.callee.name === 'Promise' &&
          isFn(node.arguments[0]) &&
          containsSetTimeout(node.arguments[0].body)
        ) {
          context.report({ node, message: 'sleep in a test: new Promise(setTimeout); use vi.useFakeTimers() or await the event' });
        }
      },
      ImportDeclaration(node) {
        if (node.source.value === 'node:timers/promises' || node.source.value === 'timers/promises') {
          for (const s of node.specifiers)
            if (s.type === 'ImportSpecifier' && s.imported?.name === 'setTimeout')
              context.report({
                node: s,
                message: 'sleep in a test: timers/promises setTimeout; use vi.useFakeTimers() or await the event',
              });
        }
      },
      AwaitExpression(node) {
        const a = node.argument;
        if (
          a?.type === 'CallExpression' &&
          a.callee?.type === 'Identifier' &&
          SLEEP_CALLS.has(a.callee.name) &&
          a.arguments[0]?.type === 'Literal' &&
          typeof a.arguments[0].value === 'number'
        ) {
          context.report({
            node,
            message: `sleep in a test: await ${a.callee.name}(${a.arguments[0].value}); use vi.useFakeTimers() or await the event`,
          });
        }
      },
    };
  },
};

// 5. Playwright: page.waitForTimeout(n) is a fixed wait; wait for a locator or a response instead.
const noWaitForTimeout = {
  meta: { type: 'problem', docs: { description: 'No fixed waitForTimeout in browser tests.' } },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c?.type === 'MemberExpression' && !c.computed && c.property?.name === 'waitForTimeout') {
          context.report({ node, message: 'fixed waitForTimeout: wait for a locator, response or event' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'garden' },
  rules: {
    'no-local-helper': noLocalHelper,
    'no-double-cast': noDoubleCast,
    'require-suppression-reason': requireSuppressionReason,
    'no-real-clock-wait-in-tests': noRealClockWaitInTests,
    'no-wait-for-timeout': noWaitForTimeout,
  },
};

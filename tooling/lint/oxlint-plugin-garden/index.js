// oxlint JS plugin: the weeds INTAFACED is known to grow. Plain ESM, no dependencies.
// Loaded by the root .oxlintrc.json ("jsPlugins"), rules "garden/<name>". tooling/ci/lint-ratchet.mjs fails a change whose
// touched files gain a finding, in CI and before a push; tooling/lint/ratchet.json names the few rules that only print.
import { copyRules } from './copy-rules.js';
import { absentRules } from './absent-rule.js';
import { moneyRules } from './money-rules.js';
import { sharedMarketRules } from './shared-market-rule.js';
import { duplicateRules } from './duplicate-rules.js';
import { potetoRules } from './poteto-rules.js';
import { handTypedPatchRules } from './hand-typed-patch-rule.js';
import { eitherStateRules } from './either-state-rule.js';
import { madeUpPrincipalRules } from './made-up-principal-rule.js';
import { exactLocatorRules } from './exact-locator-rule.js';
import { retryActionRules } from './retry-action-rule.js';

const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
const isTest = (context) => TEST_FILE.test(context.filename ?? context.getFilename());

// 1. Local copies of helpers that should live in one shared place.
const HELPER_NAMES = new Set(['isRecord', 'isObject', 'isPlainObject', 'asRecord', 'sleep', 'wait', 'delay', 'unreachable']);
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
const noLocalHelper = {
  meta: { type: 'suggestion', docs: { description: 'Import the shared helper instead of defining a local isRecord/sleep/unreachable.' } },
  create(context) {
    const report = (node, name) =>
      context.report({
        node,
        message: `local helper '${name}': import the shared one (isRecord from @intafaced/contracts/guards, sleep from @intafaced/contracts/sleep)`,
      });
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
            message:
              '`as unknown as` turns type checking off here: narrow with a type guard or a schema parse, or fix the source type. ' +
              'A partial test fake takes a single `as T`, which still checks the fields it writes; a test that passes a wrong type ' +
              'on purpose suppresses the line with `-- why`',
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
// What a fixed wait in a test becomes. A record's expiry or window passing: age that record with the TEST age door
// (agePast in apps/customer/tests/real-app/test-age.mjs; only svc-trade mounts it so far). Something that happens: await its locator, response or event.
// A unit test's timer: vi.useFakeTimers(). Proving nothing happens for a while has no event: keep the wait and say why.
const waitFix = (rule) =>
  `an expiry or window: age the record with agePast (apps/customer/tests/real-app/test-age.mjs; svc-trade has the door today, another service mounts packages/service-kit test-age.ts first); an outcome: await its locator, response or event; a unit test's timer: vi.useFakeTimers(); proving nothing happens: keep the wait with \`// oxlint-disable-next-line garden/${rule} -- why\``;
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
          context.report({ node, message: `sleep in a test: new Promise(setTimeout); ${waitFix('no-real-clock-wait-in-tests')}` });
        }
      },
      ImportDeclaration(node) {
        if (node.source.value === 'node:timers/promises' || node.source.value === 'timers/promises') {
          for (const s of node.specifiers)
            if (s.type === 'ImportSpecifier' && s.imported?.name === 'setTimeout')
              context.report({
                node: s,
                message: `sleep in a test: timers/promises setTimeout; ${waitFix('no-real-clock-wait-in-tests')}`,
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
            message: `sleep in a test: await ${a.callee.name}(${a.arguments[0].value}); ${waitFix('no-real-clock-wait-in-tests')}`,
          });
        }
      },
    };
  },
};

// 5. Playwright: page.waitForTimeout(n) is a fixed wait; waitFix names what it becomes.
const noWaitForTimeout = {
  meta: { type: 'problem', docs: { description: 'No fixed waitForTimeout in browser tests.' } },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c?.type === 'MemberExpression' && !c.computed && c.property?.name === 'waitForTimeout') {
          context.report({ node, message: `fixed waitForTimeout: ${waitFix('no-wait-for-timeout')}` });
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
    ...copyRules,
    ...absentRules,
    ...moneyRules,
    ...sharedMarketRules,
    ...duplicateRules,
    ...potetoRules,
    ...handTypedPatchRules,
    ...eitherStateRules,
    ...madeUpPrincipalRules,
    ...exactLocatorRules,
    ...retryActionRules,
  },
};

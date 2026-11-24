// garden/no-deep-entry: a journey enters the customer app where a trader does, then clicks to its screen. A step counts as
// proven only when its screens are reached through the menus on the hosted beta's build (owner decision 24 Nov 2026;
// tooling/ci/menu-reach.mjs), and most journeys entered by typing a deep address.
// A `goto` of a customer-app path may name the front page `/`, a menu row (apps/customer/src/app/menus.ts), a room the
// All services index lists (apps/customer/src/screens/more/tiles.ts allServices: two clicks from any page) or a room an
// emailed link opens (`publicFrame`): deep-entries.json, written by tooling/lint/deep-entries.mjs.
// Anything else (a detail or parameter route, an alias, a business page, a path of no room, a path built from values) is
// reached by clicking from one of those, as a trader does. Only a path the rule can read is judged: a string or a template
// starting with `/`; another app's address, held in a variable, is not this app's entry.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
import { readFileSync } from 'node:fs';

const REAL_APP = /(?:^|\/)apps\/customer\/tests\/real-app\/.+\.mjs$/u;
// The crawl opens every page to read its links (tooling/scripts/menu-crawl.mjs): it is the check, not a journey.
const CRAWL = /(?:^|\/)menu-reach\.pw\.mjs$/u;
// The entries, read from the app's own modules by tooling/lint/deep-entries.mjs and kept beside this rule, so the lint
// ratchet's copy of main's plugin judges with main's list.
let cached;
const allowed = () => (cached ??= new Set(JSON.parse(readFileSync(new URL('./deep-entries.json', import.meta.url), 'utf8')).entries));

/** The path a `goto`'s first argument names, '' when it is built from values, or null when it is not a customer path. */
function pathOf(arg) {
  if (arg?.type === 'Literal' && typeof arg.value === 'string') return arg.value.startsWith('/') ? arg.value : null;
  if (arg?.type === 'TemplateLiteral') {
    const head = arg.quasis[0]?.value?.cooked ?? '';
    if (!head.startsWith('/')) return null;
    return arg.expressions.length ? '' : head;
  }
  return null;
}

const noDeepEntry = {
  meta: {
    type: 'problem',
    docs: { description: 'A journey enters the customer app at the front page, Home, a menu row or a listed room, then clicks.' },
  },
  create(context) {
    const file = context.filename ?? context.getFilename();
    if (!REAL_APP.test(file) || CRAWL.test(file)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression' || callee.computed || callee.property?.name !== 'goto') return;
        const raw = pathOf(node.arguments[0]);
        if (raw === null) return;
        const path = raw === '' ? '' : raw.split(/[?#]/u)[0].replace(/\/+$/u, '') || '/';
        if (path && allowed().has(path)) return;
        context.report({
          node,
          message:
            `${path ? `\`goto('${path}')\` enters` : 'a `goto` of a path built from values enters'} the app at a screen a trader can't open from ` +
            'the front page, Home, a menu or the All services index: a step on a screen no menu path reaches is not proven ' +
            "(the beta reach check, tooling/ci/menu-reach.mjs). Enter at '/', '/home', a menu row (menus.ts) or a room All services lists, " +
            'then click to the screen as a trader does (a room this change adds is listed once main has it: tooling/lint/deep-entries.mjs)',
        });
      },
    };
  },
};

export const deepEntryRules = { 'no-deep-entry': noDeepEntry };

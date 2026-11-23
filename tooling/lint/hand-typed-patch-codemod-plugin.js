// The oxlint plugin tooling/lint/hand-typed-patch-codemod.mjs runs with --fix. For each garden/no-hand-typed-patch
// finding named in HAND_PATCH_TARGETS ({ "<abs file>": [{ name, line }] }) that sits in the type literal of a prototype
// cast (`ctor.prototype as { open: (...) => ... }`), it writes the member's type from the class: `open: Cls['open']`.
// The class is the cast's receiver when it is a class name, or the `typeof Cls` its parameter is declared as.
// TradeService is skipped: its members' types live in TradeServiceInternal, which
// services/svc-trade/src/spot/trade-service/boundary.test.ts keeps inside spot/trade-service, so those are a judgement. A type is erased when TypeScript compiles, so this
// cannot change what runs; the driver keeps a member only when tsc accepts the class's own type there.
import { readFileSync } from 'node:fs';

let cache = null;
function targetsFor(file) {
  if (!cache) cache = process.env.HAND_PATCH_TARGETS ? JSON.parse(readFileSync(process.env.HAND_PATCH_TARGETS, 'utf8')) : {};
  return cache[file] ?? [];
}

const isPrototype = (n) => n?.type === 'MemberExpression' && !n.computed && n.property?.name === 'prototype';
function underCasts(n) {
  while (n?.type === 'TSAsExpression' || n?.type === 'TSTypeAssertion' || n?.type === 'TSSatisfiesExpression') n = n.expression;
  return n;
}
const isFunction = (n) => n?.type === 'FunctionDeclaration' || n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression';

/** The class a `<receiver>.prototype` belongs to: the receiver's own name, or the `typeof Cls` of the parameter it is. */
function classOf(receiver) {
  if (receiver?.type !== 'Identifier') return null;
  for (let n = receiver.parent; n; n = n.parent) {
    if (!isFunction(n)) continue;
    for (const p of n.params ?? []) {
      const id = p.type === 'AssignmentPattern' ? p.left : p;
      if (id?.type !== 'Identifier' || id.name !== receiver.name) continue;
      const t = id.typeAnnotation?.typeAnnotation;
      return t?.type === 'TSTypeQuery' && t.exprName?.type === 'Identifier' ? t.exprName.name : null;
    }
  }
  return /^[A-Z]/u.test(receiver.name) ? receiver.name : null;
}

export default {
  meta: { name: 'hand-patch-codemod' },
  rules: {
    fix: {
      meta: { fixable: 'code' },
      create(context) {
        const file = context.filename ?? context.getFilename();
        const targets = targetsFor(file);
        if (!targets.length) return {};
        const sc = context.sourceCode;
        const visit = (node) => {
          if (node.parent?.type === 'TSAsExpression' || node.parent?.type === 'TSSatisfiesExpression') return; // the outer cast only
          const target = underCasts(node);
          if (!isPrototype(target) || node.typeAnnotation?.type !== 'TSTypeLiteral') return;
          const cls = classOf(target.object);
          if (!cls || cls === 'TradeService') return;
          for (const m of node.typeAnnotation.members) {
            if (m.computed || m.key?.type !== 'Identifier') continue;
            const name = m.key.name;
            if (!targets.some((t) => t.name === name && t.line === m.key.loc.start.line)) continue;
            if (m.type !== 'TSPropertySignature' && !(m.type === 'TSMethodSignature' && m.kind === 'method')) continue;
            const end = sc.text.slice(m.start, m.end).trimEnd().endsWith(';')
              ? ';'
              : sc.text.slice(m.start, m.end).trimEnd().endsWith(',')
                ? ','
                : '';
            const text = `${m.readonly ? 'readonly ' : ''}${name}${m.optional ? '?' : ''}: ${cls}['${name}']${end}`;
            context.report({
              node: m,
              message: `${name} → ${cls}['${name}']`,
              fix: (f) => f.replaceTextRange([m.start, m.end], text),
            });
          }
        };
        return { TSAsExpression: visit, TSTypeAssertion: visit };
      },
    },
  },
};

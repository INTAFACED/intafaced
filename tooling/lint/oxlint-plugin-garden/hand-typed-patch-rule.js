// garden/no-hand-typed-patch: a prototype patch that writes its own type for a method it reads or replaces.
// `ctor.prototype as unknown as { finalize: (orderId: string, status: 'cancelled' | ...) => Promise<void> }` tells the
// compiler the method is whatever the patch says, so a change to the real one (an overload, a new argument, a narrower
// type) never reaches the patch. Three closers in svc-trade (gtd-gtt-place.ts, ioc-place.ts, option-place.ts) called
// `finalize` this way, which is how they skipped the cancel evidence #8563 made a compile error for every other caller.
// One finding per hand-typed member, so adding a member to a patch that already exists fails too. `as unknown as` alone
// is garden/no-double-cast's; this rule also judges the single `prototype as {...}` and a re-cast of the patch variable.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
const MESSAGE = (name) =>
  `'${name}' on a prototype patch has a hand-written type, so the compiler stops checking the real method's arguments, ` +
  `overloads and return (how three closers skipped finalize's cancel evidence, #8563). Type it from the class itself: ` +
  `TradeServiceInternal['${name}'] for TradeService (trade-service.ts), <Class>['${name}'] for another class. Forward every ` +
  `argument (...args: Parameters<...>). New behaviour goes in the class or its area file, not in a new patch.`;

const isPrototype = (n) => n?.type === 'MemberExpression' && !n.computed && n.property?.name === 'prototype';
/** The expression under any stack of `as` casts. */
function underCasts(n) {
  while (n?.type === 'TSAsExpression' || n?.type === 'TSTypeAssertion' || n?.type === 'TSSatisfiesExpression') n = n.expression;
  return n;
}
const keyName = (m) => (m.key?.type === 'Identifier' ? m.key.name : m.key?.type === 'Literal' ? String(m.key.value) : null);

export const handTypedPatchRules = {
  'no-hand-typed-patch': {
    meta: { type: 'problem', docs: { description: 'Type a prototype patch from the class, never by hand.' } },
    create(context) {
      if (TEST_FILE.test(context.filename ?? context.getFilename())) return {};
      /** Type aliases and interfaces this file declares, by name. */
      const local = new Map();
      /** Variables holding a prototype cast (`const proto = ctor.prototype as ...`). */
      const patchVars = new Set();
      const casts = [];

      /** Is this member type written by hand: a function, unknown or any, or a reference to such a type of this file? */
      function handWritten(t, seen = new Set()) {
        if (!t) return false;
        if (t.type === 'TSFunctionType' || t.type === 'TSUnknownKeyword' || t.type === 'TSAnyKeyword') return true;
        if (t.type === 'TSUnionType' || t.type === 'TSIntersectionType') return t.types.some((x) => handWritten(x, seen));
        if (t.type === 'TSParenthesizedType') return handWritten(t.typeAnnotation, seen);
        if (t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') {
          const decl = local.get(t.typeName.name);
          if (!decl || seen.has(decl)) return false;
          seen.add(decl);
          return decl.type === 'TSTypeAliasDeclaration' && handWritten(decl.typeAnnotation, seen);
        }
        if (t.type === 'TSIndexedAccessType') {
          // `Host['submit']` where Host is this file's own object type is still a hand-written signature.
          const obj = t.objectType;
          const idx = t.indexType;
          if (obj?.type !== 'TSTypeReference' || obj.typeName?.type !== 'Identifier') return false;
          const decl = local.get(obj.typeName.name);
          if (!decl || seen.has(decl)) return false;
          seen.add(decl);
          const key = idx?.type === 'TSLiteralType' ? String(idx.literal?.value) : null;
          const member = membersOf(decl).find((m) => keyName(m) === key);
          return member ? memberHandWritten(member, seen) : false;
        }
        return false;
      }
      function memberHandWritten(m, seen) {
        if (m.type === 'TSMethodSignature') return true;
        if (m.type === 'TSPropertySignature' && !m.computed) return handWritten(m.typeAnnotation?.typeAnnotation, seen);
        return false;
      }
      function membersOf(decl) {
        if (decl.type === 'TSInterfaceDeclaration') return decl.body?.body ?? [];
        if (decl.type === 'TSTypeAliasDeclaration') return literalMembers(decl.typeAnnotation, new Set([decl]));
        return [];
      }
      /** The members of an inline object type, or of this file's alias or interface it names, through intersections. */
      function literalMembers(t, seen = new Set()) {
        if (!t) return [];
        if (t.type === 'TSTypeLiteral') return t.members;
        if (t.type === 'TSIntersectionType') return t.types.flatMap((x) => literalMembers(x, seen));
        if (t.type === 'TSParenthesizedType') return literalMembers(t.typeAnnotation, seen);
        if (t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') {
          const decl = local.get(t.typeName.name);
          if (!decl || seen.has(decl)) return [];
          seen.add(decl);
          return decl.type === 'TSInterfaceDeclaration' ? (decl.body?.body ?? []) : literalMembers(decl.typeAnnotation, seen);
        }
        return [];
      }

      return {
        TSTypeAliasDeclaration(node) {
          if (node.id?.name) local.set(node.id.name, node);
        },
        TSInterfaceDeclaration(node) {
          if (node.id?.name) local.set(node.id.name, node);
        },
        VariableDeclarator(node) {
          const init = node.init;
          if (node.id?.type === 'Identifier' && init?.type === 'TSAsExpression' && isPrototype(underCasts(init)))
            patchVars.add(node.id.name);
        },
        TSAsExpression(node) {
          // Only the outermost cast of a stack is judged.
          if (node.parent?.type === 'TSAsExpression') return;
          casts.push(node);
        },
        'Program:exit'() {
          for (const node of casts) {
            const base = underCasts(node);
            const onPatch = isPrototype(base) || (base?.type === 'Identifier' && patchVars.has(base.name));
            if (!onPatch) continue;
            for (const m of literalMembers(node.typeAnnotation)) {
              if (!memberHandWritten(m, new Set())) continue;
              const name = keyName(m) ?? '?';
              context.report({ node: m, message: MESSAGE(name) });
            }
          }
        },
      };
    },
  },
};

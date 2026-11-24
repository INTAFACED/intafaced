// garden/no-service-sentence: a screen never prints the sentence a service wrote. A service's `.message`, `.residual`,
// `.residuals` and `.statusLine` are for operators (they name owner rules, env vars and decision ids); the person sees the
// screen's own words for the refusal's code (the room's refusals.ts). Switched on per folder in .oxlintrc.json `overrides`
// (the copy bots room's screens first), and judged by the lint ratchet (tooling/ci/lint-ratchet.mjs).
const FIX = "show the room's own words for the refusal's code (refusals.ts), never the service's sentence";
const OPERATOR_FIELDS = new Set(['residual', 'residuals', 'statusLine']);
const REPLY = /(?:failure|result)$/u;

const nameOf = (n) => (n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' && !n.computed ? n.property?.name : null);
const WRAPPERS = new Set(['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'ParenthesizedExpression']);

/** Is this value what a JSX container or a template prints: the whole expression, or the end of a `??`, `||`, `+` or
 * ternary inside one? */
function printed(node) {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (p.type === 'JSXExpressionContainer' || p.type === 'TemplateLiteral') return true;
    if (WRAPPERS.has(p.type)) n = p;
    else if ((p.type === 'LogicalExpression' || p.type === 'BinaryExpression') && p.right === n) n = p;
    else if (p.type === 'ConditionalExpression' && p.test !== n) n = p;
    else return false;
  }
  return false;
}

const noServiceSentence = {
  meta: { type: 'problem', docs: { description: "A screen never prints a service's sentence." } },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed) return;
        const field = node.property?.name;
        if (OPERATOR_FIELDS.has(field)) context.report({ node, message: `\`.${field}\` is the service's operator line: ${FIX}` });
        else if (field === 'message' && (REPLY.test(nameOf(node.object) ?? '') || printed(node)))
          context.report({ node, message: `\`.message\` is the service's sentence: ${FIX}` });
      },
    };
  },
};

export const serviceSentenceRules = { 'no-service-sentence': noServiceSentence };

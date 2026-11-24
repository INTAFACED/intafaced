// garden/no-made-up-principal: product code that writes a person's authority by hand.
// A principal is what svc-identity verified about a caller: whose it is, what it may do (`scopes`) and the person's level
// (`tier`). An object that spells all three with the tier written in, `{ userId, scopes: ['trade:write'], tier: 'basic' }`,
// claims a level nobody checked, and every door that asks `requireTradeTier(principal, 'basic')` then passes whatever the
// person's real level is. The CI review found it twice in four days, each a security FAIL: the live-run supervisor placing
// strategy orders as a made-up `tier: 'basic'` (J-algo-dev-07, 12 Nov) and the protection engine's `engineActor`
// (J-derivatives-03, 12 Nov). The copy they had to follow is on main: svc-trade's operator cancel and reader
// (src/admin/wire.ts). The fix acts with the principal the request carried, or rebuilds a stored one through the one
// supported way (svc-trade src/algo/durable-principal.ts, which never writes a tier in). Judged by the lint ratchet:
// a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const TEST_FILE =
  /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|testing)\/)|(test-harness|testkit|\/testing\.|\.mock\.)/u;
const PRODUCT = /(?:^|\/)(?:services|packages|apps)\/[^/]+\/src\//u;
// Where a principal is made from a verified credential: the token code and the identity service that issues it.
const ISSUERS = /(?:^|\/)(?:packages\/auth|services\/svc-identity)\/src\//u;

const keyOf = (p) => (p.type === 'Property' && !p.computed ? (p.key?.name ?? (p.key?.type === 'Literal' ? p.key.value : null)) : null);

// The tier as written, through `as const`, `satisfies` and `!`; a template with no `${}` is a string too.
const tierText = (value) => {
  let v = value;
  while (v && (v.type === 'TSAsExpression' || v.type === 'TSSatisfiesExpression' || v.type === 'TSNonNullExpression')) v = v.expression;
  if (v?.type === 'Literal' && typeof v.value === 'string') return v.value;
  if (v?.type === 'TemplateLiteral' && v.expressions.length === 0) return v.quasis.map((q) => q.value.cooked).join('');
  return null;
};

const noMadeUpPrincipal = {
  meta: { type: 'problem', docs: { description: 'Product code never writes a principal with its tier spelled in.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!PRODUCT.test(file) || TEST_FILE.test(file) || ISSUERS.test(file)) return {};
    return {
      ObjectExpression(node) {
        const props = new Map(node.properties.map((p) => [keyOf(p), p]).filter(([k]) => k));
        const tier = props.get('tier');
        if (!tier || !props.has('scopes') || !(props.has('userId') || props.has('sub'))) return;
        const text = tierText(tier.value);
        if (text === null) return;
        context.report({
          node: tier,
          message:
            `a principal with \`tier: '${text}'\` written in claims a level nobody checked, so every tier check ` +
            'passes it: act with the principal the request carried, or rebuild a stored one with principalFromAlgoGrant ' +
            '(svc-trade src/algo/durable-principal.ts), which takes the tier the person was verified at',
        });
      },
    };
  },
};

export const madeUpPrincipalRules = { 'no-made-up-principal': noMadeUpPrincipal };

// garden/no-sign-in-retry: a journey signs in once; a refused sign-in fails its test instead of being tried again.
// Two retries had grown in the journeys (`signInOnceMore` behind the founder console's sign-in, and J-bank-02's own, each
// counting the refused step spent with `stepAfterRefusal` and signing in once more). The cause they covered, a fresh
// one-time code equal to a spent step's code, was fixed in svc-identity (#8487); after it a retry fired once in about
// 380 pull-request and dispatched runs and hid why, as a second try always does. A refused sign-in now fails and names
// identity's answer. The gates' own operator sign-in in tooling/scripts is not a journey and is not judged here.
const JOURNEY_CODE = /(^|\/)apps\/customer\/tests\//u;
const RETRY_PARTS = new Set(['stepAfterRefusal', 'signInOnceMore']);

const calledName = (callee) => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed) return callee.property?.name;
  return undefined;
};

const noSignInRetry = {
  meta: { type: 'problem', docs: { description: 'A journey signs in once; a refused sign-in fails its test.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!JOURNEY_CODE.test(file)) return {};
    return {
      CallExpression(node) {
        const name = calledName(node.callee);
        if (!RETRY_PARTS.has(name)) return;
        context.report({
          node,
          message:
            `${name} in a journey sets up a second sign-in after a refused one, which hides the refusal. Sign in once with a ` +
            "real, unused step (the founder console's founderSignIn, or a journey's own nextCode) and let a refusal fail " +
            'the test; when one fires, fix its cause in the product or the stack',
        });
      },
    };
  },
};

export const signInRetryRules = { 'no-sign-in-retry': noSignInRetry };

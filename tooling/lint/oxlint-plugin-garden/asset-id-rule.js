// garden/asset-id-schema: in `packages/contracts/src`, an `assetId` field is written from `assetIdSchema`
// (`packages/contracts/src/asset-id.ts`), never from a bare `z.string()`. The brand is what makes an account or user id
// passed where an asset id is wanted fail to compile; a field started from `z.string()` drops it, and every caller of that
// field can swap the ids again in silence (84 such fields were there before the brand).
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const CONTRACTS = /(?:^|\/)packages\/contracts\/src\/[^/]+\.[cm]?tsx?$/u;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/u;

/** True when `node` is `z.string()` or a chain started from it (`z.string().min(1).nullable()`). */
function startsFromZString(node) {
  let n = node;
  while (n) {
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (
        c?.type === 'MemberExpression' &&
        !c.computed &&
        c.object?.type === 'Identifier' &&
        c.object.name === 'z' &&
        c.property?.name === 'string'
      )
        return true;
      n = c?.type === 'MemberExpression' ? c.object : null;
    } else if (n.type === 'MemberExpression') n = n.object;
    else return false;
  }
  return false;
}

const assetIdSchemaRule = {
  meta: { type: 'problem', docs: { description: 'An `assetId` field in a contract starts from `assetIdSchema`.' } },
  create(context) {
    const file = context.filename ?? context.getFilename();
    if (!CONTRACTS.test(file) || TEST_FILE.test(file)) return {};
    return {
      Property(node) {
        const key = node.key;
        const name = key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? key.value : undefined;
        if (name !== 'assetId' || !startsFromZString(node.value)) return;
        context.report({
          node: node.value,
          message:
            'an asset id field drops the AssetId brand when it starts from `z.string()`, so an account or user id can be passed ' +
            "for it and still compile: write `assetId: assetIdSchema` (import it from './asset-id.js') and chain the field's own " +
            'rules on it (`assetIdSchema.min(1)`, `.regex(...)`, `.nullable()`)',
        });
      },
    };
  },
};

export const assetIdRules = { 'asset-id-schema': assetIdSchemaRule };

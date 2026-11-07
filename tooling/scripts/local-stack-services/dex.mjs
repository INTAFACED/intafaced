// The Protocol plane's order door (J-dex-protocol-10): svc-dex's wallet-signed order session and the person's own
// orders. It holds no key of the person's, no balance and no database; its orders, spent nonces and sign-outs are JSON
// files under DEX_ORDER_STORE_DIR in this stack's data directory. It gets no INTERNAL_SERVICE_SECRET: the secret that
// reaches ledger.post is withheld from this process, as services/svc-dex/README.md says.
// Every owner value here is the labelled LOCAL TEST value in tooling/profiles/test-owner-values/dex.json. The session
// secret is TEST-labelled and derived from this machine's secrets.json, so it is never a literal in the tree; svc-dex
// refuses to boot on a TEST secret outside dev or test. Production stays blank and every order call refuses by name
// (dex.auth.session_unset, dex.auth.lifetime_unset, dex.order.cap_unset).
// The order vault: with the stack's LOCAL TEST chain, svc-dex reads it through the chain's gate and asks the node to send
// the keeper's calls from the seeded TEST keeper (an address with no key, impersonated on that anvil only), and trades the
// seeded TEST A/B order pool. With no chain those stay blank and every order action reads rail.crypto.
// The quote venues stay as svc-dex ships them (none configured), so `quote` still refuses dex.quote.* by name.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { profileEnvFor } from '../owner-settings.mjs';

const TOKEN_A = { address: '0x00000000000000000000000000000000000a11ce', symbol: 'TEST A', decimals: 6, name: 'TEST Token A' };
const TOKEN_B = { address: '0x00000000000000000000000000000000000b0b00', symbol: 'TEST B', decimals: 18, name: 'TEST Token B' };

export default ({ c, secrets, PORTS, P, testChain }) => ({
  name: 'dex',
  env: () => {
    const chain = testChain?.() ?? null;
    const vault = chain?.orderVault ? chain : null;
    const env = {
      ...c('svc-dex', PORTS.dex),
      ...profileEnvFor('dex', 'dev'),
      DEX_ORDER_STORE_DIR: path.join(P.data, 'dex-orders'),
      DEX_AUTH_SECRET: `TEST-${createHash('sha256').update(`dex order session\0${secrets.internal}`).digest('hex')}`,
      INDEXER_URL: `http://127.0.0.1:${PORTS.indexer}`,
      MATCHING_URL: `http://127.0.0.1:${PORTS.matching}`,
      ...(vault
        ? {
            DEX_ORDER_RPC_URL: vault.rpcUrl,
            DEX_ORDER_CHAIN_ID: '84532',
            DEX_ORDER_VAULT_ADDRESS: vault.orderVault,
            DEX_ORDER_KEEPER_ADDRESS: vault.orderKeeper,
            DEX_ORDER_PAIRS: JSON.stringify([{ base: TOKEN_A, quote: TOKEN_B, pool: vault.orderPool }]),
            ...(vault.recurringVault ? { DEX_RECURRING_ADDRESS: vault.recurringVault } : {}),
          }
        : {}),
    };
    delete env.INTERNAL_SERVICE_SECRET;
    return env;
  },
});

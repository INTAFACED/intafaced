// The Protocol Plane's read side for the Web3 rooms (/dex, /chain, /protocol, /wallet): the network chip, the chain status,
// the network card and the action blockers read svc-protocol (J-dex-protocol-01). It holds no key and posts nothing.
// PROTOCOL_CHAIN_ID is the app's network id, 84532 (the wallet guard's APP_CHAIN_ID), so the labels read as they will
// once the owner publishes a node.
// PROTOCOL_RPC_URL: when anvil is installed the stack runs a LOCAL TEST chain (tooling/scripts/local-test-chain.mjs):
// a throwaway anvil on loopback with chain id 84532, seeded with TEST tokens, TEST pools and a router, and svc-protocol
// reads it through the chain's gate. It is a stand-in, not Base Sepolia: it forks nothing and reaches nothing. A journey
// that asserts the node is unreachable closes the gate (J-dex-protocol-01). With no anvil the stack runs no node and the
// URL is UNUSED, so every chain read refuses as unreachable (rail.crypto).
// PROTOCOL_AMM_FACTORY_ADDRESS is the seeded TEST pool factory on that chain; with no chain it stays the zero default.
// PROTOCOL_ENTRYPOINT_ADDRESS is the ERC-4337 v0.7 EntryPoint, the address the Base Sepolia deploy requires
// (src/deployments/sepolia-deploy-env.ts). The account factories stay the zero default (not deployed), so their paths
// refuse by name. INDEXER_URL and DEX_URL stay unset (not started here): the blockers say "not connected". DATABASE_URL
// is this stack's svc_protocol role; protocol is in SCHEMAS, so db:migrate runs before the process listens.
import { createHash } from 'node:crypto';

export default ({ c, secrets, dbUrl, PORTS, UNUSED, testChain, CUSTOMER_ORIGIN, CUSTOMER_LOCALHOST_ORIGIN }) => ({
  name: 'protocol',
  env: () => {
    const chain = testChain?.() ?? null;
    return {
      ...c('svc-protocol', PORTS.protocol),
      DATABASE_URL: dbUrl('svc_protocol', secrets),
      PROTOCOL_CHAIN_ID: '84532',
      PROTOCOL_RPC_URL: chain ? chain.rpcUrl : UNUSED,
      ...(chain ? { PROTOCOL_AMM_FACTORY_ADDRESS: chain.factory } : {}),
      PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/protocol.json: the representation a
      // wallet signs once before its first signing action. Production stays blank and every signing action refuses
      // (compliance.representation_unset) until counsel's text and the owner's version are set.
      PROTOCOL_REPRESENTATION_VERSION: 'TEST-1',
      PROTOCOL_REPRESENTATION_TEXT:
        "TEST representation, not counsel's wording: I am not located in, or acting for anyone in, a region where this service is not available.",
      // LOCAL TEST swap settings, labelled in the same file: the slippage ceiling, the quote lifetime and the confirmations
      // before a swap reads filled. Production stays blank and the swap form refuses by name.
      PROTOCOL_SWAP_SLIPPAGE_BPS: '300',
      PROTOCOL_SWAP_QUOTE_TTL_SECONDS: '30',
      PROTOCOL_SWAP_CONFIRMATIONS: '1',
      // LOCAL TEST only (tooling/profiles/test-owner-values/protocol.json): the wallet session that opens the address book
      // (J-dex-protocol-04). The secret is TEST-labelled and derived from this machine's secrets.json, so it is never a
      // literal in the tree; svc-protocol refuses to boot on a TEST secret outside dev or test. Production stays blank and
      // the address book refuses protocol.wallet_session_unset until the owner sets all three.
      PROTOCOL_WALLET_SESSION_SECRET: `TEST-${createHash('sha256').update(`protocol wallet session\0${secrets.internal}`).digest('hex')}`,
      PROTOCOL_WALLET_SESSION_TTL_SECONDS: '3600',
      PROTOCOL_WALLET_SESSION_ORIGINS: `${CUSTOMER_ORIGIN},${CUSTOMER_LOCALHOST_ORIGIN}`,
      PROTOCOL_ADDRESS_BOOK_MAX_CONTACTS: '50',
      PROTOCOL_WALLET_GROUPS_MAX: '10',
    };
  },
});

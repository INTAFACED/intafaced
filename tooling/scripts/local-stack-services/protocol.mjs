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
export default ({ c, secrets, dbUrl, PORTS, UNUSED, testChain }) => ({
  name: 'protocol',
  env: () => {
    const chain = testChain?.() ?? null;
    return {
      ...c('svc-protocol', PORTS.protocol),
      DATABASE_URL: dbUrl('svc_protocol', secrets),
      PROTOCOL_CHAIN_ID: '84532',
      PROTOCOL_RPC_URL: chain ? chain.rpcUrl : UNUSED,
      ...(chain ? { PROTOCOL_AMM_FACTORY_ADDRESS: chain.factory } : {}),
      // LOCAL TEST price reference: the seeded TEST USD token counts as one dollar, and a pool must hold 1,000 TEST USD
      // worth on its priced side (labelled in tooling/profiles/test-owner-values/protocol.json). Blank in production.
      ...(chain?.usdToken ? { PROTOCOL_PRICE_USD_TOKENS: chain.usdToken, PROTOCOL_PRICE_MIN_RESERVE_USD: '1000' } : {}),
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
      // LOCAL TEST network fee settings, labelled in the same file: the percentiles of the last blocks' priority fees for
      // Slow, Normal and Fast, how many blocks they are read from, and the fee cap per gas (100 gwei). Production stays
      // blank and the fee levels refuse by name (protocol.gas_percentiles_unset, protocol.swap_fee_cap_unset).
      PROTOCOL_GAS_PERCENTILES: '10,50,90',
      PROTOCOL_GAS_HISTORY_BLOCKS: '20',
      PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI: '100000000000',
    };
  },
});

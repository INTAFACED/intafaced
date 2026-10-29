// The Protocol Plane's read side for the Web3 rooms (/dex, /chain, /protocol, /wallet): the network chip, the chain status,
// the network card and the action blockers read svc-protocol (J-dex-protocol-01). It holds no key and posts nothing.
// PROTOCOL_CHAIN_ID is the app's network, Base Sepolia (84532, the wallet guard's APP_CHAIN_ID), so the labels read as they
// will once the owner publishes a node. This stack runs no Base Sepolia node: PROTOCOL_RPC_URL is UNUSED, so every chain
// read refuses as unreachable (rail.crypto) instead of answering from a local chain under the testnet's name.
// PROTOCOL_ENTRYPOINT_ADDRESS is the ERC-4337 v0.7 EntryPoint, the address the Base Sepolia deploy requires
// (src/deployments/sepolia-deploy-env.ts). Factories stay the zero default (not deployed), so their paths refuse by name.
// INDEXER_URL and DEX_URL stay unset (not started here): the blockers say "not connected". DATABASE_URL is this stack's
// svc_protocol role; protocol is in SCHEMAS, so db:migrate runs before the process listens.
export default ({ c, secrets, dbUrl, PORTS, UNUSED }) => ({
  name: 'protocol',
  env: () => ({
    ...c('svc-protocol', PORTS.protocol),
    DATABASE_URL: dbUrl('svc_protocol', secrets),
    PROTOCOL_CHAIN_ID: '84532',
    PROTOCOL_RPC_URL: UNUSED,
    PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/protocol.json: the representation a
    // wallet signs once before its first signing action. Production stays blank and every signing action refuses
    // (compliance.representation_unset) until counsel's text and the owner's version are set.
    PROTOCOL_REPRESENTATION_VERSION: 'TEST-1',
    PROTOCOL_REPRESENTATION_TEXT:
      "TEST representation, not counsel's wording: I am not located in, or acting for anyone in, a region where this service is not available.",
    // LOCAL TEST only (same profile): how long a contract ownership challenge stays signable. Blank in production refuses
    // protocol.listing.challenge_ttl_unset and no challenge is issued.
    PROTOCOL_LISTING_CHALLENGE_TTL_SECONDS: 'TEST:300',
  }),
});

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
  }),
});

// The chain explorer's read model (J-dex-protocol-09): svc-indexer follows the stack's LOCAL TEST chain
// (tooling/scripts/local-test-chain.mjs, anvil with chain id 84532) through the same gate svc-protocol reads, and keeps
// every block, transaction and log it sees in its own schema. It holds no key and posts nothing.
// INDEXER_VENUE_ADDRESS: the TEST chain carries no order-book venue, so the indexer follows the seeded TEST router
// (a contract with code, so its per-pass eth_getCode check holds); no router log matches the venue's events, so the
// order-book tables stay empty and say nothing. With no anvil there is no chain: the RPC is UNUSED and the venue is the
// zero address, so the indexer runs and reports the chain unreachable (indexer.venue_unset) instead of inventing one.
// The other settings are the labelled LOCAL TEST values in tooling/profiles/test-owner-values/indexer.json. Production
// stays blank: the explorer list refuses indexer.explorer_list_limit_unset and a dropped hash indexer.tx_drop_window_unset.
import { SECOND_CHAIN_ID, SECOND_GATE_URL } from '../local-test-chain.mjs';
import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/indexer.json.`);
  return entry.value;
}

export default ({ c, secrets, dbUrl, PORTS, UNUSED, testChain }) => ({
  name: 'indexer',
  env: () => {
    const chain = testChain?.() ?? null;
    return {
      ...c('svc-indexer', PORTS.indexer),
      DATABASE_URL: dbUrl('svc_indexer', secrets),
      INDEXER_CHAIN_ID: '84532',
      INDEXER_RPC_URL: chain ? chain.rpcUrl : UNUSED,
      INDEXER_VENUE_ADDRESS: chain ? chain.router : '0x0000000000000000000000000000000000000000',
      INDEXER_START_HEIGHT: testValue('INDEXER_START_HEIGHT'),
      INDEXER_FINALITY_DEPTH: testValue('INDEXER_FINALITY_DEPTH'),
      INDEXER_BATCH_SIZE: testValue('INDEXER_BATCH_SIZE'),
      INDEXER_POLL_INTERVAL_MS: '1000',
      INDEXER_EXPLORER_LIST_LIMIT: testValue('INDEXER_EXPLORER_LIST_LIMIT'),
      INDEXER_TX_DROP_WINDOW_SECONDS: testValue('INDEXER_TX_DROP_WINDOW_SECONDS'),
      // The pools the explorer lists (J-dex-protocol-09 #7): the seeded TEST pool factory, the one svc-protocol quotes from.
      // With no chain it stays unset and every pools read refuses indexer.pool_factory_unset.
      ...(chain ? { INDEXER_POOL_FACTORY_ADDRESS: chain.factory } : {}),
      // The search's second network (J-dex-protocol-09 #10): the stack's second LOCAL TEST chain, behind its own gate.
      INDEXER_SEARCH_NETWORKS: chain ? JSON.stringify([{ chainId: SECOND_CHAIN_ID, rpcUrl: SECOND_GATE_URL }]) : '',
    };
  },
});

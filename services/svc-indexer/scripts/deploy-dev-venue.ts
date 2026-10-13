/**
 * Deploy the DevVenue fixture to the local dev chain, and print what to set.
 *
 *   docker compose up -d evm
 *   pnpm --filter @intafaced/svc-indexer chain:deploy
 *
 * This exists so a developer can watch the read model fill up against a real
 * chain, not because anything deploys this contract for real. `DevVenue` has no
 * access control at all — anyone can publish any trade they like — so
 * `deployDevVenue` refuses on any endpoint that does not identify itself as a
 * throwaway anvil/hardhat node on the dev chain id.
 *
 * The address is deterministic while the `evm` service holds no volume: a
 * restart gives a genesis-fresh chain, the deployer's nonce is 0 again, and the
 * contract lands at the same address every time. That is what lets
 * docker-compose.apps.yml name it as a default instead of making every developer
 * copy hex out of a terminal.
 */
import { assertSeedReceipt } from './seed-receipt.js';
import { deployDevVenue, devChainClients, devRpcUrl, marketWord, scaled } from './dev-venue.js';

const clients = devChainClients();
console.log(`Deploying DevVenue to ${devRpcUrl()} as ${clients.deployer} …`);

const venue = await deployDevVenue(clients);
const artifactAbi = venue.abi;
const account = clients.walletClient.account!;

// A first block of activity, so `book`, `fills` and `positions` all have
// something in them the moment the indexer catches up. Without it a developer
// runs the deploy, queries the API, sees an empty book and cannot tell whether
// the pipeline works.
const market = marketWord('ETH-USD');
const seed = await clients.walletClient.writeContract({
  address: venue.address,
  abi: artifactAbi,
  functionName: 'publishAll',
  args: [
    {
      market,
      side: 0,
      levelPrice: scaled('3000.5'),
      levelQuantity: scaled('2.25'),
      maker: clients.deployer,
      taker: clients.deployer,
      fillPrice: scaled('3000.5'),
      fillQuantity: scaled('0.5'),
      takerSide: 0,
      account: clients.deployer,
      size: scaled('0.5'),
      entryPrice: scaled('3000.5'),
    },
  ],
  account,
  chain: clients.walletClient.chain,
});
const seedReceipt = await clients.publicClient.waitForTransactionReceipt({ hash: seed });
assertSeedReceipt(seedReceipt);

console.log(`
DevVenue          ${venue.address}
deployment block  ${venue.deploymentBlock}
seeded market     ETH-USD  (one level, one fill, one position)

Point svc-indexer at it:

  INDEXER_RPC_URL=${devRpcUrl()}
  INDEXER_VENUE_ADDRESS=${venue.address}
  INDEXER_START_HEIGHT=${venue.deploymentBlock}

Then:  pnpm --filter @intafaced/svc-indexer dev
`);

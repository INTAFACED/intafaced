/**
 * SEED THE LOCAL STACK'S TEST CHAIN, and fund a TEST wallet on it (J-dex-protocol-02, -04).
 *
 *   PROTOCOL_RPC_URL=http://127.0.0.1:14530 PROTOCOL_CHAIN_ID=84532 tsx scripts/seed-test-chain.ts seed <record.json>
 *   PROTOCOL_RPC_URL=... PROTOCOL_CHAIN_ID=84532 tsx scripts/seed-test-chain.ts fund <address>
 *
 * Run by tooling/scripts/local-test-chain.mjs, never by hand against anything else. The stack's chain is a throwaway
 * anvil node started with `--chain-id 84532`: a LOCAL TEST stand-in for Base Sepolia, so the app (APP_CHAIN_ID 84532)
 * treats it as its network. Nothing here reaches Base Sepolia: the node is anvil on loopback, started empty, no fork.
 * Every token is a TEST token anyone can mint; every reserve is TEST.
 *
 * Refuses unless the endpoint is loopback, answers `web3_clientVersion` as anvil, and reports the expected chain id.
 * The anvil check is what keeps the public dev key off a real Base Sepolia node, which would answer 84532 too.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  toHex,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

/** PUBLIC, WELL-KNOWN, WORTHLESS: anvil's own default mnemonic (account #0 is the TEST deployer). */
const PUBLIC_ANVIL_DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** Fixed TEST token addresses the journeys read rows by (apps/customer/tests/real-app/dex.mjs). */
export const TEST_TOKENS = {
  A: { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', symbol: 'TESTA', decimals: 6 },
  B: { address: '0x00000000000000000000000000000000000b0b00', name: 'TEST Token B', symbol: 'TESTB', decimals: 18 },
  THIN: { address: '0x00000000000000000000000000000000000071a0', name: 'TEST Thin', symbol: 'TESTTHIN', decimals: 18 },
} as const;
/** J-dex-protocol-04's "contract address on the TEST chain": any code there makes it a contract. */
export const TEST_CONTRACT: Address = '0x0000000000000000000000000000000000c0ffee';

type Artifact = { abi: Abi; bytecode: Hex };
const artifact = (name: string): Artifact =>
  JSON.parse(readFileSync(new URL(`../contracts/out/${name}.json`, import.meta.url), 'utf8')) as Artifact;

const rpcUrl = process.env.PROTOCOL_RPC_URL ?? '';
const chainId = Number(process.env.PROTOCOL_CHAIN_ID ?? '');

function clients() {
  const url = new URL(rpcUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`REFUSING: ${rpcUrl} is not loopback`);
  const chain = defineChain({
    id: chainId,
    name: 'LOCAL TEST stand-in',
    nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = mnemonicToAccount(PUBLIC_ANVIL_DEV_MNEMONIC);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 });
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
  return { publicClient, walletClient, account };
}

async function assertStandIn(publicClient: ReturnType<typeof clients>['publicClient']) {
  const version = (await publicClient.request({ method: 'web3_clientVersion' } as never)) as string;
  if (!/^anvil\//i.test(version)) throw new Error(`REFUSING: "${version}" is not a throwaway anvil node`);
  const observed = await publicClient.getChainId();
  if (observed !== chainId) throw new Error(`REFUSING: node reports chain ${observed}, expected ${chainId}`);
  return version;
}

async function seed(out: string) {
  const { publicClient, walletClient, account } = clients();
  const version = await assertStandIn(publicClient);
  // Seeded already (the chain kept running across a stack restart): the record still names what is on the node.
  if (existsSync(out)) {
    const record = JSON.parse(readFileSync(out, 'utf8')) as { factory: Address; tokens: typeof TEST_TOKENS };
    const [factoryCode, tokenCode] = await Promise.all([
      publicClient.getCode({ address: record.factory }),
      publicClient.getCode({ address: record.tokens.A.address }),
    ]);
    if (factoryCode && factoryCode !== '0x' && tokenCode && tokenCode !== '0x') {
      console.log(`already seeded: factory ${record.factory}`);
      return;
    }
  }
  const send = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction failed: ${hash}`);
    return receipt;
  };
  const deploy = async (name: string, args: unknown[] = []) => {
    const a = artifact(name);
    const receipt = await send(await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args }));
    return receipt.contractAddress as Address;
  };

  // TEST tokens at their fixed addresses. A CREATE address cannot be chosen, so each TestToken is deployed once and its
  // runtime code copied to the fixed address. TestToken keeps name, symbol and decimals as immutables, so that code is
  // the whole token: nothing in storage to copy, and the copy answers exactly as the deployment does.
  const token = artifact('TestToken');
  for (const t of Object.values(TEST_TOKENS)) {
    const deployed = await deploy('TestToken', [t.name, t.symbol, t.decimals]);
    const code = await publicClient.getCode({ address: deployed });
    await publicClient.request({ method: 'anvil_setCode', params: [t.address, code] } as never);
  }
  await publicClient.request({ method: 'anvil_setCode', params: [TEST_CONTRACT, '0x00'] } as never);

  // Factory and router: deterministic by the deployer's nonce on a fresh node; the pools by CREATE2 from the factory.
  const factory = await deploy('PoolFactory');
  const router = await deploy('SovereignRouter');
  const factoryAbi = artifact('PoolFactory').abi;
  const poolAbi = artifact('ConstantProductPool').abi;
  const { A, B, THIN } = TEST_TOKENS;
  const pools = [
    // Two A/B pools, one better: deeper reserves and the lower fee win any quote.
    { label: 'TEST A/B deep 0.30%', a: A, b: B, feeBps: 30, amountA: '1000000', amountB: '1000000' },
    { label: 'TEST A/B shallow 1.00%', a: A, b: B, feeBps: 100, amountA: '50000', amountB: '50000' },
    // A thin token: so little reserve that a price is not honest to show.
    { label: 'TEST A/Thin thin 0.30%', a: A, b: THIN, feeBps: 30, amountA: '0.001', amountB: '0.001' },
  ];
  const seeded = [];
  for (const p of pools) {
    await send(
      await walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: 'createPool',
        args: [p.a.address, p.b.address, p.feeBps],
      }),
    );
    const pool = (await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [p.a.address, p.b.address, p.feeBps],
    })) as Address;
    const token0 = (await publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'token0' })) as Address;
    const units = {
      [getAddress(p.a.address)]: parseUnits(p.amountA, p.a.decimals),
      [getAddress(p.b.address)]: parseUnits(p.amountB, p.b.decimals),
    };
    for (const [addr, amount] of Object.entries(units)) {
      await send(
        await walletClient.writeContract({
          address: addr as Address,
          abi: token.abi,
          functionName: 'mint',
          args: [account.address, amount],
        }),
      );
      await send(
        await walletClient.writeContract({ address: addr as Address, abi: token.abi, functionName: 'approve', args: [pool, amount] }),
      );
    }
    const token1 = getAddress(token0) === getAddress(p.a.address) ? p.b.address : p.a.address;
    await send(
      await walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'mint',
        args: [account.address, units[getAddress(token0)], units[getAddress(token1)]],
      }),
    );
    seeded.push({ label: p.label, pool, feeBps: p.feeBps, token0, token1: getAddress(token1) });
  }
  const record = {
    node: version,
    chainId,
    rpcUrl,
    tokens: TEST_TOKENS,
    contract: TEST_CONTRACT,
    factory,
    router,
    pools: seeded,
    test: true,
  };
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`seeded: factory ${factory}, router ${router}, ${seeded.length} TEST pools`);
}

/** TEST funding for one TEST wallet: TEST ETH for gas, and TEST Token A and B. Anyone may mint a TestToken. */
async function fund(address: Address) {
  const { publicClient, walletClient } = clients();
  await assertStandIn(publicClient);
  await publicClient.request({ method: 'anvil_setBalance', params: [address, toHex(parseUnits('10', 18))] } as never);
  const abi = artifact('TestToken').abi;
  for (const t of [TEST_TOKENS.A, TEST_TOKENS.B]) {
    const hash = await walletClient.writeContract({
      address: t.address,
      abi,
      functionName: 'mint',
      args: [address, parseUnits('10000', t.decimals)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  console.log(`funded ${address}: 10 TEST ETH, 10000 ${TEST_TOKENS.A.name}, 10000 ${TEST_TOKENS.B.name}`);
}

const [command, arg] = process.argv.slice(2);
if (command === 'seed' && arg) await seed(arg);
else if (command === 'fund' && arg) await fund(getAddress(arg));
else throw new Error('usage: seed-test-chain.ts seed <record.json> | fund <address>');

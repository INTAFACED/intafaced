/**
 * TEST FIXTURES FOR THE TOKEN PAGES on the local stack's TEST chain (J-dex-protocol-07).
 *
 *   PROTOCOL_RPC_URL=http://127.0.0.1:14530 PROTOCOL_CHAIN_ID=84532 tsx scripts/seed-token-pages.ts <test-chain.json>
 *
 * Run by the journey test, never by hand against anything else. It reads the factory from the record seed-test-chain.ts
 * wrote, then adds what the token pages need to show real rows:
 * - a TEST token copying TEST Token A's name and symbol, listed later in a pool with no trade (a lookalike with no history);
 * - a TEST token with no symbol, in a pool, so an address search has something only its address can find;
 * - TEST swaps by two TEST traders in the deep TEST A/B pool, so trades, candles, volume and realised results exist.
 * Prints the fixture addresses as JSON. Every token is a TEST token anyone can mint; every amount is TEST.
 *
 * The same guards as seed-test-chain.ts: loopback only, the node must answer as anvil, and report the expected chain id.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseUnits,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

/** PUBLIC, WELL-KNOWN, WORTHLESS: anvil's own default mnemonic. Account #0 deploys; #1 and #2 are the TEST traders. */
const PUBLIC_ANVIL_DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const A = getAddress('0x00000000000000000000000000000000000a11ce');
const B = getAddress('0x00000000000000000000000000000000000b0b00');

type Artifact = { abi: Abi; bytecode: Hex };
const artifact = (name: string): Artifact =>
  JSON.parse(readFileSync(new URL(`../contracts/out/${name}.json`, import.meta.url), 'utf8')) as Artifact;

const rpcUrl = process.env.PROTOCOL_RPC_URL ?? '';
const chainId = Number(process.env.PROTOCOL_CHAIN_ID ?? '');

const url = new URL(rpcUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`REFUSING: ${rpcUrl} is not loopback`);
const chain = defineChain({
  id: chainId,
  name: 'LOCAL TEST stand-in',
  nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 });
const wallet = (index: number) =>
  createWalletClient({ chain, account: mnemonicToAccount(PUBLIC_ANVIL_DEV_MNEMONIC, { addressIndex: index }), transport: http(rpcUrl) });

const version = (await publicClient.request({ method: 'web3_clientVersion' } as never)) as string;
if (!/^anvil\//i.test(version)) throw new Error(`REFUSING: "${version}" is not a throwaway anvil node`);
const observed = await publicClient.getChainId();
if (observed !== chainId) throw new Error(`REFUSING: node reports chain ${observed}, expected ${chainId}`);

const recordPath = process.argv[2];
if (!recordPath || !existsSync(recordPath)) throw new Error('usage: seed-token-pages.ts <test-chain.json> (the seeded TEST chain record)');
const { factory } = JSON.parse(readFileSync(recordPath, 'utf8')) as { factory: Address };
const out = join(dirname(recordPath), 'test-token-pages.json');

const token = artifact('TestToken');
const factoryAbi = artifact('PoolFactory').abi;
const poolAbi = artifact('ConstantProductPool').abi;
const deployer = wallet(0);

const send = async (hash: Hex) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction failed: ${hash}`);
  return receipt;
};
const write = (client: ReturnType<typeof wallet>, address: Address, abi: Abi, functionName: string, args: unknown[]) =>
  client.writeContract({ address, abi, functionName, args } as never).then(send);

// The node mines once a second after its seed; these fixtures mine per transaction, then put that back.
await publicClient.request({ method: 'evm_setAutomine', params: [true] } as never);
try {
  /** A TEST token in a TEST pool against TEST Token B, with TEST liquidity and no trade. */
  async function listed(name: string, symbol: string): Promise<{ token: Address; pool: Address }> {
    const receipt = await send(await deployer.deployContract({ abi: token.abi, bytecode: token.bytecode, args: [name, symbol, 18] }));
    const address = getAddress(receipt.contractAddress!);
    await write(deployer, factory, factoryAbi, 'createPool', [address, B, 30]);
    const pool = (await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [address, B, 30],
    })) as Address;
    const amount = parseUnits('1000', 18);
    for (const t of [address, B]) {
      await write(deployer, t, token.abi, 'mint', [deployer.account.address, amount]);
      await write(deployer, t, token.abi, 'approve', [pool, amount]);
    }
    await write(deployer, pool, poolAbi, 'mint', [deployer.account.address, amount, amount]);
    return { token: address, pool };
  }

  let fixtures: { lookalike: Address; noSymbol: Address } | null = null;
  if (existsSync(out)) {
    const kept = JSON.parse(readFileSync(out, 'utf8')) as { lookalike: Address; noSymbol: Address };
    const [one, two] = await Promise.all([
      publicClient.getCode({ address: kept.lookalike }),
      publicClient.getCode({ address: kept.noSymbol }),
    ]);
    if (one && one !== '0x' && two && two !== '0x') fixtures = kept;
  }
  if (!fixtures) {
    const lookalike = await listed('TEST Token A', 'TESTA');
    const noSymbol = await listed('TEST no symbol', '');
    fixtures = { lookalike: lookalike.token, noSymbol: noSymbol.token };
    writeFileSync(out, `${JSON.stringify({ ...fixtures, test: true }, null, 2)}\n`);
  }

  // TEST trades in the deep TEST A/B pool: trader 1 buys A, then sells part of it; trader 2 buys A.
  const deep = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [A, B, 30],
  })) as Address;
  const trades: { trader: number; tokenIn: Address; amount: bigint }[] = [
    { trader: 1, tokenIn: B, amount: parseUnits('100', 18) },
    { trader: 1, tokenIn: A, amount: parseUnits('40', 6) },
    { trader: 2, tokenIn: B, amount: parseUnits('50', 18) },
  ];
  for (const t of trades) {
    const trader = wallet(t.trader);
    await publicClient.request({ method: 'anvil_setBalance', params: [trader.account.address, toHex(parseUnits('10', 18))] } as never);
    await write(trader, t.tokenIn, token.abi, 'mint', [trader.account.address, t.amount]);
    await write(trader, t.tokenIn, token.abi, 'approve', [deep, t.amount]);
    await write(trader, deep, poolAbi, 'swapExactIn', [t.tokenIn, t.amount, 1n, trader.account.address]);
  }
  console.log(JSON.stringify({ ...fixtures, pool: deep, traders: [wallet(1).account.address, wallet(2).account.address], test: true }));
} finally {
  await publicClient.request({ method: 'evm_setAutomine', params: [false] } as never);
  await publicClient.request({ method: 'evm_setIntervalMining', params: [1] } as never);
}

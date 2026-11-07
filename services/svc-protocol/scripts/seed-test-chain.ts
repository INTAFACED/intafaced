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
  encodeAbiParameters,
  http,
  keccak256,
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
  /** The TEST stand-in for a dollar stable token: the stack's reference for USD prices (PROTOCOL_PRICE_USD_TOKENS). */
  USD: { address: '0x000000000000000000000000000000000000d011', name: 'TEST USD', symbol: 'TESTUSD', decimals: 6 },
  /**
   * A second TEST stable token, allowlisted to pay network fees but with an oracle mark that is stale on purpose
   * (J-dex-protocol-02 #11): it trades in no pool, so it is never offered to swap, only to pay a fee and be refused.
   */
  EUR: { address: '0x00000000000000000000000000000000000e0e00', name: 'TEST EUR', symbol: 'TESTEUR', decimals: 6 },
  /**
   * An airdropped TEST token that trades in no pool (J-dex-protocol-04 #7): `fund <address> spam` sends some to a wallet
   * unasked, from the TEST deployer, so the wallet's Activity has a spam row to hide and show.
   */
  DROP: { address: '0x00000000000000000000000000000000000d7090', name: 'TEST Airdrop', symbol: 'TESTDROP', decimals: 18 },
} as const;
/**
 * The TEST network-fee relay's parts (RC-dex-protocol-02, J-dex-protocol-02 #11). The relayer submits a person's signed
 * swap and pays its gas in TEST ETH; the two oracle reporters push the fee tokens' marks. All three are addresses with
 * no key, impersonated on this anvil only (anvil_impersonateAccount), so nothing can sign for them anywhere else.
 */
export const TEST_FEE_RELAYER: Address = '0x0000000000000000000000000000000000fee5e1';
export const TEST_ORACLE_REPORTERS: readonly [Address, Address] = [
  '0x00000000000000000000000000000000000a7e0a',
  '0x00000000000000000000000000000000000a7e0b',
];
/**
 * TEST oracle marks, native wei per whole token (1 TEST USD = 0.0004 TEST ETH; 1 TEST EUR = 0.00044 TEST ETH). Labelled
 * TEST: illustrative magnitudes for a stand-in chain, never a live rate.
 */
export const TEST_FEE_MARKS = { USD: 400_000_000_000_000n, EUR: 440_000_000_000_000n } as const;
/** TEST oracle settings: a mark older than a day is stale; the two reporters may differ by at most 1%. */
export const TEST_ORACLE_STALENESS_SECONDS = 86_400;
const TEST_ORACLE_MAX_DISAGREEMENT_BPS = 100;
/** The TEST relay's published markup on the oracle rate: 5% (500 bps), immutable in the deployed relay. */
export const TEST_FEE_MARKUP_BPS = 500;
/**
 * The TEST claim-link escrow's published expiry bounds (D-swap-12, J-dex-protocol-04 #6): a link lasts at least one
 * minute and at most 30 days. Immutable in the deployed escrow. TEST values: one minute keeps a journey's wait short.
 */
export const TEST_CLAIM_EXPIRY_BOUNDS = { min: 60, max: 30 * 86_400 } as const;
/**
 * The order vault's TEST parts (D-limit-dca-01 to -04, J-dex-protocol-10): the keeper is an address with no key,
 * impersonated on this anvil only, which svc-dex asks the node to send `fill`, `poke` and `sweepUncredited` from. The
 * order pool is a TEST A/B pool made outside the factory, so the swap rooms, the pools list and the explorer never see
 * it, and the TEST world sets its depth directly (`orders-market`). The marks are the TEST oracle's, native wei per whole
 * token: TEST B at 0.0004 TEST ETH, TEST A at TEST B times the TEST price.
 */
export const TEST_ORDER_KEEPER: Address = '0x00000000000000000000000000000000000bee75';
const TEST_ORDER_QUOTE_MARK = 400_000_000_000_000n;
const TEST_ORDER_POOL_FEE_BPS = 30;
/** The order pool's default depth, in whole TEST A: deep enough that an order of a few hundred fills whole. */
const TEST_ORDER_POOL_DEPTH = 1_000_000n;
/** The order pool's depth when the world gives an order room for one exact partial fill. */
const TEST_ORDER_THIN_DEPTH = 1_000n;

/** What `fund <address> spam` sends: an amount of TEST Airdrop nobody asked for. */
const SPAM_FUNDING = '1000';
/** What `fund <address> stable` gives: TEST USD only, and no TEST ETH. */
const STABLE_ONLY_FUNDING = '100';

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

/**
 * After the seed, blocks come once a second, as on a real network, instead of one per transaction: a swap then reads
 * submitted, confirming and filled in turn. Seeding itself runs on automine so it takes about a second.
 */
async function mineOnInterval(publicClient: ReturnType<typeof clients>['publicClient']) {
  await publicClient.request({ method: 'evm_setAutomine', params: [false] } as never);
  await publicClient.request({ method: 'evm_setIntervalMining', params: [1] } as never);
}

type Clients = ReturnType<typeof clients>;

/** Both TEST reporters push `mark` for `token`, so the fail-closed oracle has two fresh, agreeing reports. */
async function reportMark({ publicClient, walletClient }: Clients, oracle: Address, token: Address, mark: bigint) {
  const abi = artifact('FailClosedOracle').abi;
  for (const reporter of TEST_ORACLE_REPORTERS) {
    const hash = await walletClient.writeContract({
      account: reporter,
      chain: walletClient.chain,
      address: oracle,
      abi,
      functionName: 'report',
      args: [token, mark],
      // A fixed limit, not an estimate: estimated in one block, a report can be mined in the next, where writing the new
      // timestamp costs more than the estimate allowed (seen: OutOfGas on a re-seed). 100,000 covers both writes.
      gas: 100_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`oracle report failed: ${hash}`);
  }
}

/**
 * Makes TEST EUR's two reports stale: their `updatedAt` is set to an hour past the staleness bound before the latest
 * block, written into the oracle's storage on this anvil (feedA is slot 0, feedB slot 1; a Report's `updatedAt` is the
 * word after its price). Then checks the oracle itself now refuses the mark as Stale, so the seed never claims a stale
 * feed the contract would still price.
 */
async function makeMarkStale({ publicClient }: Clients, oracle: Address, token: Address) {
  const block = await publicClient.getBlock();
  const old = block.timestamp - BigInt(TEST_ORACLE_STALENESS_SECONDS) - 3600n;
  for (const slot of [0n, 1n]) {
    const base = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, slot])));
    await publicClient.request({
      method: 'anvil_setStorageAt',
      params: [oracle, toHex(base + 1n, { size: 32 }), toHex(old, { size: 32 })],
    } as never);
  }
  const abi = artifact('FailClosedOracle').abi;
  const refused = await publicClient.readContract({ address: oracle, abi, functionName: 'getMark', args: [token] }).then(
    () => null,
    (err: Error) => err.message,
  );
  if (!refused || !/Stale/.test(refused)) throw new Error(`TEST EUR's oracle mark should read Stale, got: ${refused ?? 'a price'}`);
}

/** TEST ETH for the impersonated relayer and reporters, so they can pay gas on this anvil. */
async function impersonate({ publicClient }: Clients, addresses: readonly Address[]) {
  for (const address of addresses) {
    await publicClient.request({ method: 'anvil_impersonateAccount', params: [address] } as never);
    await publicClient.request({ method: 'anvil_setBalance', params: [address, toHex(parseUnits('1000', 18))] } as never);
  }
}

async function seed(out: string) {
  const { publicClient, walletClient, account } = clients();
  const version = await assertStandIn(publicClient);
  await publicClient.request({ method: 'evm_setAutomine', params: [true] } as never);
  // Seeded already (the chain kept running across a stack restart): the record still names what is on the node.
  if (existsSync(out)) {
    const record = JSON.parse(readFileSync(out, 'utf8')) as {
      factory: Address;
      oracle?: Address;
      claimEscrow?: Address;
      tokens: typeof TEST_TOKENS;
    };
    const [factoryCode, tokenCode, oracleCode] = await Promise.all([
      publicClient.getCode({ address: record.factory }),
      publicClient.getCode({ address: TEST_TOKENS.USD.address }),
      record.oracle ? publicClient.getCode({ address: record.oracle }) : Promise.resolve(undefined),
    ]);
    if (factoryCode && factoryCode !== '0x' && tokenCode && tokenCode !== '0x' && oracleCode && oracleCode !== '0x') {
      // The live fee token's mark is pushed again, so a chain that outlived the staleness bound still prices it.
      await reportMark(clients(), record.oracle!, TEST_TOKENS.USD.address, TEST_FEE_MARKS.USD);
      // A chain seeded before the claim-link escrow existed gets it (and the TEST Airdrop token) now.
      const escrowCode = record.claimEscrow ? await publicClient.getCode({ address: record.claimEscrow }) : undefined;
      if (!escrowCode || escrowCode === '0x') {
        const claimEscrow = await seedClaimLinkParts(clients());
        writeFileSync(out, `${JSON.stringify({ ...record, tokens: TEST_TOKENS, claimEscrow }, null, 2)}\n`);
      }
      // A chain seeded before the order vault existed gets it now; one that has it gets fresh order marks.
      const current = JSON.parse(readFileSync(out, 'utf8')) as { orderVault?: Address; orderPool?: Address };
      const vaultCode = current.orderVault ? await publicClient.getCode({ address: current.orderVault }) : undefined;
      if (!vaultCode || vaultCode === '0x') {
        const orders = await seedOrderParts(clients(), record.oracle!);
        writeFileSync(out, `${JSON.stringify({ ...current, ...orders }, null, 2)}\n`);
      } else {
        await impersonate(clients(), [...TEST_ORDER_REPORTERS_AND_KEEPER()]);
        await setOrderMarket(clients(), record.oracle!, current.orderPool!, 1_000_000_000_000_000_000n, null);
      }
      await mineOnInterval(publicClient);
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
  // TEST Airdrop is deployed last (seedClaimLinkParts), so every address seeded before it stays where it was.
  for (const t of Object.values(TEST_TOKENS).filter((entry) => entry.symbol !== TEST_TOKENS.DROP.symbol)) {
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
  const { A, B, THIN, USD, EUR } = TEST_TOKENS;
  const pools = [
    // Two A/B pools, one better: deeper reserves and the lower fee win any quote.
    { label: 'TEST A/B deep 0.30%', a: A, b: B, feeBps: 30, amountA: '1000000', amountB: '1000000' },
    { label: 'TEST A/B shallow 1.00%', a: A, b: B, feeBps: 100, amountA: '50000', amountB: '50000' },
    // A third A/B pool left unsynced on purpose (below): its recorded reserves differ from what it holds, so route options
    // list it "unavailable: stale" (J-dex-protocol-02 #4). Small, so its recorded reserves would never win a quote anyway.
    { label: 'TEST A/B stale 0.50%', a: A, b: B, feeBps: 50, amountA: '10000', amountB: '10000', unsynced: '1000' },
    // A thin token: so little reserve that a price is not honest to show.
    { label: 'TEST A/Thin thin 0.30%', a: A, b: THIN, feeBps: 30, amountA: '0.001', amountB: '0.001' },
    // TEST USD pools, so each TEST token has a USD price on the stack: TEST Token A and TEST Token B each at 1 TEST USD.
    { label: 'TEST A/USD 0.30%', a: A, b: USD, feeBps: 30, amountA: '500000', amountB: '500000' },
    { label: 'TEST B/USD 0.30%', a: B, b: USD, feeBps: 30, amountA: '500000', amountB: '500000' },
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
    if ('unsynced' in p && p.unsynced) {
      // Tokens sent straight to the pool without sync(): its reserves no longer match its holdings. TEST only.
      await send(
        await walletClient.writeContract({
          address: p.a.address as Address,
          abi: token.abi,
          functionName: 'mint',
          args: [pool, parseUnits(p.unsynced, p.a.decimals)],
        }),
      );
    }
    seeded.push({ label: p.label, pool, feeBps: p.feeBps, token0, token1: getAddress(token1) });
  }
  // The network-fee relay (RC-dex-protocol-02): a fail-closed oracle with two TEST reporters, TEST USD freshly marked
  // and TEST EUR marked then made stale, and the relay with its published TEST markup and both tokens allowlisted.
  const all = clients();
  await impersonate(all, [TEST_FEE_RELAYER, ...TEST_ORACLE_REPORTERS]);
  const oracle = await deploy('FailClosedOracle', [
    TEST_ORACLE_REPORTERS[0],
    TEST_ORACLE_REPORTERS[1],
    TEST_ORACLE_STALENESS_SECONDS,
    TEST_ORACLE_MAX_DISAGREEMENT_BPS,
  ]);
  await reportMark(all, oracle, EUR.address, TEST_FEE_MARKS.EUR);
  await makeMarkStale(all, oracle, EUR.address);
  await reportMark(all, oracle, USD.address, TEST_FEE_MARKS.USD);
  const feeRelay = await deploy('FeeTokenRelay', [oracle, account.address, TEST_FEE_MARKUP_BPS]);
  for (const t of [USD, EUR])
    await send(
      await walletClient.writeContract({
        address: feeRelay,
        abi: artifact('FeeTokenRelay').abi,
        functionName: 'setFeeToken',
        args: [t.address, true],
      }),
    );

  const claimEscrow = await seedClaimLinkParts(all);
  const orders = await seedOrderParts(all, oracle);

  const record = {
    node: version,
    chainId,
    rpcUrl,
    tokens: TEST_TOKENS,
    contract: TEST_CONTRACT,
    factory,
    router,
    pools: seeded,
    oracle,
    feeRelay,
    feeRelayer: TEST_FEE_RELAYER,
    feeMarkupBps: TEST_FEE_MARKUP_BPS,
    claimEscrow,
    claimExpiryBounds: TEST_CLAIM_EXPIRY_BOUNDS,
    ...orders,
    test: true,
  };
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  await mineOnInterval(publicClient);
  console.log(`seeded: factory ${factory}, router ${router}, ${seeded.length} TEST pools, fee relay ${feeRelay}`);
}

/**
 * The claim-link escrow (D-swap-12) with its TEST expiry bounds, and the TEST Airdrop token at its fixed address (in no
 * pool). Returns the escrow's address. Runs on automine, inside the seed.
 */
async function seedClaimLinkParts({ publicClient, walletClient }: Clients): Promise<Address> {
  const drop = TEST_TOKENS.DROP;
  if ((await publicClient.getCode({ address: drop.address })) === undefined) {
    const a = artifact('TestToken');
    const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args: [drop.name, drop.symbol, drop.decimals] });
    const deployed = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
    const code = await publicClient.getCode({ address: deployed });
    await publicClient.request({ method: 'anvil_setCode', params: [drop.address, code] } as never);
  }
  const escrow = artifact('ClaimLinkEscrow');
  const hash = await walletClient.deployContract({
    abi: escrow.abi,
    bytecode: escrow.bytecode,
    args: [BigInt(TEST_CLAIM_EXPIRY_BOUNDS.min), BigInt(TEST_CLAIM_EXPIRY_BOUNDS.max)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`claim-link escrow deploy failed: ${hash}`);
  return receipt.contractAddress;
}

const TEST_ORDER_REPORTERS_AND_KEEPER = () => [TEST_FEE_RELAYER, ...TEST_ORACLE_REPORTERS, TEST_ORDER_KEEPER];

/** Writes one storage word on this anvil. */
async function setWord({ publicClient }: Clients, address: Address, slot: bigint, value: bigint) {
  await publicClient.request({
    method: 'anvil_setStorageAt',
    params: [address, toHex(slot, { size: 32 }), toHex(value, { size: 32 })],
  } as never);
}
/** TestToken keeps balanceOf in slot 1 (name, symbol and decimals are immutables). */
const tokenBalanceSlot = (holder: Address) =>
  BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, 1n])));

/** The pool's integer formula (ConstantProductPool._getAmountOut). */
function poolOut(x: bigint, rIn: bigint, rOut: bigint): bigint {
  const withFee = x * BigInt(10_000 - TEST_ORDER_POOL_FEE_BPS);
  return (withFee * rOut) / (rIn * 10_000n + withFee);
}

/**
 * The quote reserve at which the pool pays an order's floor (ceil(minOut * x / amountIn)) for exactly `take` of base and
 * not for one unit more, with `baseReserve` of base: the depth for one exact partial fill.
 */
export function quoteReserveForTake(take: bigint, minOut: bigint, amountIn: bigint, baseReserve: bigint): bigint {
  const floor = (x: bigint) => (minOut * x + amountIn - 1n) / amountIn;
  let lo = 1n;
  let hi = 10n ** 40n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (poolOut(take, baseReserve, mid) >= floor(take)) hi = mid;
    else lo = mid;
  }
  if (poolOut(take + 1n, baseReserve, hi) >= floor(take + 1n)) throw new Error('no reserve gives exactly that partial fill');
  return hi;
}

/**
 * Sets the TEST order market: both TEST reporters mark TEST A at `priceWad` TEST B, and the order pool's reserves (and its
 * token balances, so a swap's own sync keeps them) are written directly on this anvil. `partial` asks for a thin pool that
 * pays one order's floor for exactly `take` of TEST A; without it the pool is deep, at the same price.
 */
async function setOrderMarket(
  all: Clients,
  oracle: Address,
  pool: Address,
  priceWad: bigint,
  partial: { take: bigint; minOut: bigint; amountIn: bigint } | null,
) {
  const { A, B } = TEST_TOKENS;
  await reportMark(all, oracle, B.address, TEST_ORDER_QUOTE_MARK);
  await reportMark(all, oracle, A.address, (TEST_ORDER_QUOTE_MARK * priceWad) / 10n ** 18n);
  const baseReserve = (partial ? TEST_ORDER_THIN_DEPTH : TEST_ORDER_POOL_DEPTH) * 10n ** BigInt(A.decimals);
  const quoteReserve = partial
    ? quoteReserveForTake(partial.take, partial.minOut, partial.amountIn, baseReserve)
    : (baseReserve * priceWad * 10n ** BigInt(B.decimals)) / (10n ** 18n * 10n ** BigInt(A.decimals));
  const poolAbi = artifact('ConstantProductPool').abi;
  const token0 = getAddress((await all.publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'token0' })) as Address);
  const [r0, r1] = token0 === getAddress(A.address) ? [baseReserve, quoteReserve] : [quoteReserve, baseReserve];
  if (r0 >= 1n << 112n || r1 >= 1n << 112n) throw new Error('order pool reserves overflow uint112');
  const block = await all.publicClient.getBlock();
  // ConstantProductPool slot 0 packs reserve0 (112 bits), reserve1 (112 bits) and blockTimestampLast (32 bits).
  await setWord(all, pool, 0n, r0 | (r1 << 112n) | ((block.timestamp & 0xffffffffn) << 224n));
  await setWord(all, A.address, tokenBalanceSlot(pool), baseReserve);
  await setWord(all, B.address, tokenBalanceSlot(pool), quoteReserve);
}

/** The order vault, its TEST keeper and the TEST order pool, with fresh TEST marks at 1.00. Runs on automine. */
async function seedOrderParts(all: Clients, oracle: Address) {
  const { publicClient, walletClient } = all;
  await impersonate(all, [TEST_ORDER_KEEPER, ...TEST_ORACLE_REPORTERS]);
  const deployed = async (name: string, args: unknown[]) => {
    const a = artifact(name);
    const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
    return receipt.contractAddress;
  };
  const orderPool = await deployed('ConstantProductPool', [TEST_TOKENS.A.address, TEST_TOKENS.B.address, TEST_ORDER_POOL_FEE_BPS]);
  const orderVault = await deployed('OrderVault', [oracle, TEST_ORDER_KEEPER]);
  await setOrderMarket(all, oracle, orderPool, 10n ** 18n, null);
  return { orderVault, orderPool, orderKeeper: TEST_ORDER_KEEPER, orderPoolFeeBps: TEST_ORDER_POOL_FEE_BPS };
}

/** `orders-market <price> [<take> <minOut> <amountIn>]`, in decimal TEST B per TEST A and smallest units. */
async function ordersMarket(record: string, price: string, partial: string[]) {
  const all = clients();
  await assertStandIn(all.publicClient);
  const r = JSON.parse(readFileSync(record, 'utf8')) as { oracle: Address; orderPool: Address };
  await impersonate(all, [...TEST_ORACLE_REPORTERS]);
  const [take, minOut, amountIn] = partial.map((x) => BigInt(x));
  await setOrderMarket(all, r.oracle, r.orderPool, parseUnits(price, 18), take ? { take, minOut: minOut!, amountIn: amountIn! } : null);
  console.log(`TEST order market: TEST A at ${price} TEST B${take ? `, depth for ${take} units` : ', deep'}`);
}

/** `orders-stale`: TEST A's two reports age past the staleness bound, so the vault's price read reverts Stale. */
async function ordersStale(record: string) {
  const all = clients();
  await assertStandIn(all.publicClient);
  const r = JSON.parse(readFileSync(record, 'utf8')) as { oracle: Address };
  await makeMarkStale(all, r.oracle, TEST_TOKENS.A.address);
  console.log('TEST order market: the TEST A mark is stale');
}

/**
 * Sends TEST Airdrop to `address` from the TEST deployer, unasked (J-dex-protocol-04 #7): a token in no pool arriving in a
 * transaction the wallet did not send, which the wallet's Activity counts as spam.
 */
async function fundSpam(address: Address) {
  const { publicClient, walletClient } = clients();
  await assertStandIn(publicClient);
  const hash = await walletClient.writeContract({
    address: TEST_TOKENS.DROP.address,
    abi: artifact('TestToken').abi,
    functionName: 'mint',
    args: [address, parseUnits(SPAM_FUNDING, TEST_TOKENS.DROP.decimals)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`sent ${address}: ${SPAM_FUNDING} ${TEST_TOKENS.DROP.name}, unasked, in ${receipt.transactionHash}`);
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

/**
 * TEST funding for a wallet that holds only a stable token (J-dex-protocol-02 #11): TEST USD and nothing else, its TEST
 * ETH set to zero, so any gas it needs must be paid some other way.
 */
async function fundStable(address: Address) {
  const { publicClient, walletClient } = clients();
  await assertStandIn(publicClient);
  await publicClient.request({ method: 'anvil_setBalance', params: [address, '0x0'] } as never);
  const hash = await walletClient.writeContract({
    address: TEST_TOKENS.USD.address,
    abi: artifact('TestToken').abi,
    functionName: 'mint',
    args: [address, parseUnits(STABLE_ONLY_FUNDING, TEST_TOKENS.USD.decimals)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`funded ${address}: ${STABLE_ONLY_FUNDING} ${TEST_TOKENS.USD.name} only, no TEST ETH`);
}

const [command, arg, kind, ...rest] = process.argv.slice(2);
if (command === 'seed' && arg) await seed(arg);
else if (command === 'orders-market' && arg && kind) await ordersMarket(arg, kind, rest);
else if (command === 'orders-stale' && arg) await ordersStale(arg);
else if (command === 'fund' && arg && kind === 'stable') await fundStable(getAddress(arg));
else if (command === 'fund' && arg && kind === 'spam') await fundSpam(getAddress(arg));
else if (command === 'fund' && arg && kind === undefined) await fund(getAddress(arg));
else
  throw new Error(
    'usage: seed-test-chain.ts seed <record.json> | fund <address> [stable|spam] | orders-market <record.json> <price> [<take> <minOut> <amountIn>] | orders-stale <record.json>',
  );

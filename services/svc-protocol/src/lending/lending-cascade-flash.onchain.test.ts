/**
 * S-A4 SPEC done-bar — cascade suite + flash/reentrancy adversarial pack.
 * Public persistent testnet deploy remains Nitro RPC residual (named in tracker).
 * Skips without anvil; CI with REQUIRE_EVM_CHAIN=1 must run this.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Address, Abi, PublicClient } from 'viem';
import { loadArtifact } from '../chain/artifacts.js';

const WAD = 10n ** 18n;

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();

const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

type Suite = Awaited<ReturnType<NonNullable<typeof devChainMod>['devSuiteClients']>>;

describeOnChain('S-A4 cascade + flash adversarial on chain', () => {
  if (!devChainMod) return;

  let a: Suite;
  let reporterB: Suite;
  let b1: Suite;
  let b2: Suite;
  let keeper: Suite;
  let oracle: Address;
  let market: Address;
  let col: Address;
  let bor: Address;
  let oracleAbi: Abi;
  let marketAbi: Abi;
  let tokenAbi: Abi;

  async function write(_client: PublicClient, fn: () => Promise<`0x${string}`>) {
    const hash = await fn();
    const receipt = await a.publicClient.waitForTransactionReceipt({ hash });
    // A transaction mined as reverted must fail here, naming itself, not later as a bare "0 > 0".
    if (receipt.status !== 'success') {
      throw new Error(`transaction ${hash} reverted in block ${receipt.blockNumber} (to ${receipt.to}, from ${receipt.from})`);
    }
  }

  async function reportBoth(priceCol: bigint, priceBor: bigint) {
    for (const [asset, price] of [
      [col, priceCol],
      [bor, priceBor],
    ] as const) {
      await write(a.publicClient, () =>
        a.walletClient.writeContract({
          address: oracle,
          abi: oracleAbi,
          functionName: 'report',
          args: [asset, price],
          account: a.walletClient.account!,
          chain: a.walletClient.chain,
        }),
      );
      await write(reporterB.publicClient, () =>
        reporterB.walletClient.writeContract({
          address: oracle,
          abi: oracleAbi,
          functionName: 'report',
          args: [asset, price],
          account: reporterB.walletClient.account!,
          chain: reporterB.walletClient.chain,
        }),
      );
    }
  }

  async function fundBorrower(who: Suite, colAmount: bigint, borrowAmount: bigint) {
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: col,
        abi: tokenAbi,
        functionName: 'mint',
        args: [who.deployer, colAmount],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(who.publicClient, () =>
      who.walletClient.writeContract({
        address: col,
        abi: tokenAbi,
        functionName: 'approve',
        args: [market, colAmount],
        account: who.walletClient.account!,
        chain: who.walletClient.chain,
      }),
    );
    await write(who.publicClient, () =>
      who.walletClient.writeContract({
        address: market,
        abi: marketAbi,
        functionName: 'depositCollateral',
        args: [colAmount],
        account: who.walletClient.account!,
        chain: who.walletClient.chain,
      }),
    );
    await write(who.publicClient, () =>
      who.walletClient.writeContract({
        address: market,
        abi: marketAbi,
        functionName: 'borrow',
        args: [borrowAmount],
        account: who.walletClient.account!,
        chain: who.walletClient.chain,
      }),
    );
  }

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) {
      throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    }
    a = await devChainMod.devSuiteClients(import.meta.url);
    reporterB = await devChainMod.devSuiteClients(`${import.meta.url}#b`);
    b1 = await devChainMod.devSuiteClients(`${import.meta.url}#b1`);
    b2 = await devChainMod.devSuiteClients(`${import.meta.url}#b2`);
    keeper = await devChainMod.devSuiteClients(`${import.meta.url}#keeper`);

    const mock = loadArtifact('MockERC20');
    tokenAbi = mock.abi;
    const deployToken = async () => {
      const tx = await a.walletClient.deployContract({
        abi: mock.abi,
        bytecode: mock.bytecode,
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      });
      return (await a.publicClient.waitForTransactionReceipt({ hash: tx })).contractAddress!;
    };
    col = await deployToken();
    bor = await deployToken();

    const oc = loadArtifact('FailClosedOracle');
    oracleAbi = oc.abi;
    const ocTx = await a.walletClient.deployContract({
      abi: oc.abi,
      bytecode: oc.bytecode,
      args: [a.deployer, reporterB.deployer, 3600, 200],
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    oracle = (await a.publicClient.waitForTransactionReceipt({ hash: ocTx })).contractAddress!;

    const mk = loadArtifact('IsolatedLendingMarket');
    marketAbi = mk.abi;
    const mkTx = await a.walletClient.deployContract({
      abi: mk.abi,
      bytecode: mk.bytecode,
      args: [
        {
          collateralToken: col,
          borrowToken: bor,
          oracle,
          collateralAssetForOracle: col,
          borrowAssetForOracle: bor,
          maxLtvBps: 5000,
          liquidationThresholdBps: 8000,
          liquidationBonusBps: 500,
          closeFactorBps: 5000, // 50% — cascade must be bounded per call
          reserveFactorBps: 1000,
          baseRateBps: 200,
          slope1Bps: 400,
          slope2Bps: 8000,
          kinkBps: 8000,
        },
      ],
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    market = (await a.publicClient.waitForTransactionReceipt({ hash: mkTx })).contractAddress!;

    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor,
        abi: tokenAbi,
        functionName: 'mint',
        args: [a.deployer, 10_000n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor,
        abi: tokenAbi,
        functionName: 'approve',
        args: [market, 10_000n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: market,
        abi: marketAbi,
        functionName: 'supplyLiquidity',
        args: [5_000n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await reportBoth(100n * WAD, 100n * WAD);
  }, 180_000);

  it('cascade: two underwater borrowers — each liquidate call capped by closeFactor', async () => {
    // Re-assert marks here: on-chain files share one anvil and a sibling suite
    // can leave disagreement/stale on a colliding sender. 10/50 leaves a wide
    // margin below 50% LTV before the deliberate price crash.
    await reportBoth(100n * WAD, 100n * WAD);
    await fundBorrower(b1, 50n * WAD, 10n * WAD);
    await fundBorrower(b2, 50n * WAD, 10n * WAD);

    // Crash collateral: debtValue 10*100=1000; 50*P*0.8 < 1000 → P < 25
    await reportBoth(20n * WAD, 100n * WAD);

    const debtBefore1 = (await a.publicClient.readContract({
      address: market,
      abi: marketAbi,
      functionName: 'debtOf',
      args: [b1.deployer],
    })) as bigint;
    const debtBefore2 = (await a.publicClient.readContract({
      address: market,
      abi: marketAbi,
      functionName: 'debtOf',
      args: [b2.deployer],
    })) as bigint;
    expect(debtBefore1).toBeGreaterThan(0n);
    expect(debtBefore2).toBeGreaterThan(0n);

    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor,
        abi: tokenAbi,
        functionName: 'mint',
        args: [keeper.deployer, 200n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(keeper.publicClient, () =>
      keeper.walletClient.writeContract({
        address: bor,
        abi: tokenAbi,
        functionName: 'approve',
        args: [market, 200n * WAD],
        account: keeper.walletClient.account!,
        chain: keeper.walletClient.chain,
      }),
    );

    // Ask to repay "everything" — close factor must clip to 50%
    await write(keeper.publicClient, () =>
      keeper.walletClient.writeContract({
        address: market,
        abi: marketAbi,
        functionName: 'liquidate',
        args: [b1.deployer, 1_000n * WAD],
        account: keeper.walletClient.account!,
        chain: keeper.walletClient.chain,
      }),
    );
    await write(keeper.publicClient, () =>
      keeper.walletClient.writeContract({
        address: market,
        abi: marketAbi,
        functionName: 'liquidate',
        args: [b2.deployer, 1_000n * WAD],
        account: keeper.walletClient.account!,
        chain: keeper.walletClient.chain,
      }),
    );

    const debtAfter1 = (await a.publicClient.readContract({
      address: market,
      abi: marketAbi,
      functionName: 'debtOf',
      args: [b1.deployer],
    })) as bigint;
    const debtAfter2 = (await a.publicClient.readContract({
      address: market,
      abi: marketAbi,
      functionName: 'debtOf',
      args: [b2.deployer],
    })) as bigint;

    // Each position retains ~50% debt (close factor), not wiped in one call
    expect(debtAfter1).toBeGreaterThan(debtBefore1 / 3n);
    expect(debtAfter1).toBeLessThanOrEqual((debtBefore1 * 55n) / 100n);
    expect(debtAfter2).toBeGreaterThan(debtBefore2 / 3n);
    expect(debtAfter2).toBeLessThanOrEqual((debtBefore2 * 55n) / 100n);
  }, 30_000);

  it('flash pack: same-tx open/borrow/repay extracts no borrow-token profit', async () => {
    const trip = loadArtifact('LendingSameTxRoundTrip');
    const tx = await a.walletClient.deployContract({
      abi: trip.abi,
      bytecode: trip.bytecode,
      args: [market, col, bor],
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    const tripAddr = (await a.publicClient.waitForTransactionReceipt({ hash: tx })).contractAddress!;

    const attacker = await devChainMod.devSuiteClients(`${import.meta.url}#flash`);
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: col,
        abi: tokenAbi,
        functionName: 'mint',
        args: [attacker.deployer, 40n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor,
        abi: tokenAbi,
        functionName: 'mint',
        args: [attacker.deployer, 50n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    // healthy marks again for this borrower path (cascade left a crash mark)
    await reportBoth(100n * WAD, 100n * WAD);

    const borBefore = (await a.publicClient.readContract({
      address: bor,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [attacker.deployer],
    })) as bigint;

    await write(attacker.publicClient, () =>
      attacker.walletClient.writeContract({
        address: col,
        abi: tokenAbi,
        functionName: 'approve',
        args: [tripAddr, 40n * WAD],
        account: attacker.walletClient.account!,
        chain: attacker.walletClient.chain,
      }),
    );
    await write(attacker.publicClient, () =>
      attacker.walletClient.writeContract({
        address: bor,
        abi: tokenAbi,
        functionName: 'approve',
        args: [tripAddr, 100n * WAD],
        account: attacker.walletClient.account!,
        chain: attacker.walletClient.chain,
      }),
    );
    await write(attacker.publicClient, () =>
      attacker.walletClient.writeContract({
        address: tripAddr,
        abi: trip.abi,
        functionName: 'openBorrowRepay',
        args: [40n * WAD, 15n * WAD],
        account: attacker.walletClient.account!,
        chain: attacker.walletClient.chain,
      }),
    );

    const borAfter = (await a.publicClient.readContract({
      address: bor,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [attacker.deployer],
    })) as bigint;
    expect(borAfter).toBeLessThanOrEqual(borBefore);
  }, 30_000);

  it('flash pack: reentrancy during borrow transfer cannot open a second borrow', async () => {
    const reTok = loadArtifact('ReenteringBorrowToken');
    const mock = loadArtifact('MockERC20');
    const oc = loadArtifact('FailClosedOracle');
    const mk = loadArtifact('IsolatedLendingMarket');

    const colTx = await a.walletClient.deployContract({
      abi: mock.abi,
      bytecode: mock.bytecode,
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    const col2 = (await a.publicClient.waitForTransactionReceipt({ hash: colTx })).contractAddress!;

    const borTx = await a.walletClient.deployContract({
      abi: reTok.abi,
      bytecode: reTok.bytecode,
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    const bor2 = (await a.publicClient.waitForTransactionReceipt({ hash: borTx })).contractAddress!;

    const ocTx = await a.walletClient.deployContract({
      abi: oc.abi,
      bytecode: oc.bytecode,
      args: [a.deployer, reporterB.deployer, 3600, 200],
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    const oracle2 = (await a.publicClient.waitForTransactionReceipt({ hash: ocTx })).contractAddress!;

    for (const [asset, price] of [
      [col2, 100n * WAD],
      [bor2, 100n * WAD],
    ] as const) {
      await write(a.publicClient, () =>
        a.walletClient.writeContract({
          address: oracle2,
          abi: oc.abi,
          functionName: 'report',
          args: [asset, price],
          account: a.walletClient.account!,
          chain: a.walletClient.chain,
        }),
      );
      await write(reporterB.publicClient, () =>
        reporterB.walletClient.writeContract({
          address: oracle2,
          abi: oc.abi,
          functionName: 'report',
          args: [asset, price],
          account: reporterB.walletClient.account!,
          chain: reporterB.walletClient.chain,
        }),
      );
    }

    const mkTx = await a.walletClient.deployContract({
      abi: mk.abi,
      bytecode: mk.bytecode,
      args: [
        {
          collateralToken: col2,
          borrowToken: bor2,
          oracle: oracle2,
          collateralAssetForOracle: col2,
          borrowAssetForOracle: bor2,
          maxLtvBps: 5000,
          liquidationThresholdBps: 8000,
          liquidationBonusBps: 500,
          closeFactorBps: 5000,
          reserveFactorBps: 1000,
          baseRateBps: 200,
          slope1Bps: 400,
          slope2Bps: 8000,
          kinkBps: 8000,
        },
      ],
      account: a.walletClient.account!,
      chain: a.walletClient.chain,
    });
    const market2 = (await a.publicClient.waitForTransactionReceipt({ hash: mkTx })).contractAddress!;

    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor2,
        abi: reTok.abi,
        functionName: 'mint',
        args: [a.deployer, 1_000n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor2,
        abi: reTok.abi,
        functionName: 'approve',
        args: [market2, 1_000n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: market2,
        abi: mk.abi,
        functionName: 'supplyLiquidity',
        args: [500n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );

    const victim = await devChainMod.devSuiteClients(`${import.meta.url}#reenter`);
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: col2,
        abi: mock.abi,
        functionName: 'mint',
        args: [victim.deployer, 80n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );
    await write(victim.publicClient, () =>
      victim.walletClient.writeContract({
        address: col2,
        abi: mock.abi,
        functionName: 'approve',
        args: [market2, 80n * WAD],
        account: victim.walletClient.account!,
        chain: victim.walletClient.chain,
      }),
    );
    await write(victim.publicClient, () =>
      victim.walletClient.writeContract({
        address: market2,
        abi: mk.abi,
        functionName: 'depositCollateral',
        args: [80n * WAD],
        account: victim.walletClient.account!,
        chain: victim.walletClient.chain,
      }),
    );

    // Re-assert marks: sibling files warp the shared anvil; a stale/disagreed
    // oracle turns this borrow into Unhealthy even though 20/80 is inside 50% LTV.
    for (const [asset, price] of [
      [col2, 100n * WAD],
      [bor2, 100n * WAD],
    ] as const) {
      await write(a.publicClient, () =>
        a.walletClient.writeContract({
          address: oracle2,
          abi: oc.abi,
          functionName: 'report',
          args: [asset, price],
          account: a.walletClient.account!,
          chain: a.walletClient.chain,
        }),
      );
      await write(reporterB.publicClient, () =>
        reporterB.walletClient.writeContract({
          address: oracle2,
          abi: oc.abi,
          functionName: 'report',
          args: [asset, price],
          account: reporterB.walletClient.account!,
          chain: reporterB.walletClient.chain,
        }),
      );
    }

    // Arm: during the outbound borrow transfer, try to borrow another 20
    await write(a.publicClient, () =>
      a.walletClient.writeContract({
        address: bor2,
        abi: reTok.abi,
        functionName: 'arm',
        args: [market2, 20n * WAD],
        account: a.walletClient.account!,
        chain: a.walletClient.chain,
      }),
    );

    await write(victim.publicClient, () =>
      victim.walletClient.writeContract({
        address: market2,
        abi: mk.abi,
        functionName: 'borrow',
        args: [20n * WAD],
        account: victim.walletClient.account!,
        chain: victim.walletClient.chain,
      }),
    );

    const attempted = (await a.publicClient.readContract({
      address: bor2,
      abi: reTok.abi,
      functionName: 'reenterAttempted',
    })) as boolean;
    const succeeded = (await a.publicClient.readContract({
      address: bor2,
      abi: reTok.abi,
      functionName: 'reenterSucceeded',
    })) as boolean;
    const debt = (await a.publicClient.readContract({
      address: market2,
      abi: mk.abi,
      functionName: 'debtOf',
      args: [victim.deployer],
    })) as bigint;

    expect(attempted).toBe(true);
    expect(succeeded).toBe(false);
    // Only the outer borrow landed
    expect(debt).toBe(20n * WAD);
  }, 30_000);
});

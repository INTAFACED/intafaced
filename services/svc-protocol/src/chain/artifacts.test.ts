import { describe, expect, it } from 'vitest';
import type { AbiParameter } from 'viem';
import { loadArtifact } from './artifacts.js';
import { accountFactoryAbi, erc20ReadAbi, smartAccountAbi, tokenFactoryAbi } from './abi.js';
import { factoryAbi, poolAbi } from '../amm/abi.js';
// eslint-disable-next-line -- .mjs helper shared with scripts/compile-contracts.mjs; there is no .d.ts and none is wanted
import { collectSources, computeSourceHash, SUITES, suiteSources } from '../../scripts/contract-sources.mjs';

/**
 * THE COMMITTED BYTECODE IS THE BYTECODE THIS SOURCE PRODUCES — and the ABI
 * this service reads with is the ABI the contracts actually expose.
 *
 * Two failures this file exists to catch, both of which were structurally
 * possible until the toolchain landed and neither of which anything would have
 * noticed:
 *
 *   1. STALE ARTEFACTS. `contracts/out/` is committed so tests and deploys do
 *      not run a compiler. The cost of that is that somebody can edit a `.sol`,
 *      commit, and leave bytecode behind that no longer corresponds to any
 *      source in the tree — while `deploy-dev.ts` cheerfully deploys it.
 *      `sourceHash` is a sha256 over the exact compilation input; recomputing
 *      it here is what keeps "committed" from meaning "unverified".
 *
 *   2. A HAND-WRITTEN ABI THAT DRIFTED. `abi.ts` was written by hand, by
 *      necessity: there was no Solidity compiler in this toolchain, so nobody
 *      could generate it. Its own header says a reviewer can diff it by eye.
 *      Eyes are not a gate. A wrong output type there does not throw — viem
 *      decodes the same bytes into a different value, and a session's
 *      `validUntil` or `spentWei` comes back wrong with full confidence.
 */

type Suite = { name: string; expect: string; sources: string[] };

/** `tuple` → `(bytes32,uint48,uint128)`, recursively, with array suffixes kept. */
function canonicalType(param: AbiParameter): string {
  if (!param.type.startsWith('tuple')) return param.type;
  const components = 'components' in param ? (param.components as readonly AbiParameter[]) : [];
  return `(${components.map(canonicalType).join(',')})${param.type.slice('tuple'.length)}`;
}

function signature(params: readonly AbiParameter[]): string {
  return params.map(canonicalType).join(',');
}

describe('committed artefacts match the Solidity in this tree', () => {
  const accounts = (SUITES as Suite[]).find((s) => s.name === 'accounts');

  it('has a compiled artefact for every contract svc-protocol deploys', () => {
    for (const name of ['AccountFactory', 'SmartAccount'] as const) {
      const artefact = loadArtifact(name);
      expect(artefact.contractName).toBe(name);
      expect(artefact.bytecode.length).toBeGreaterThan(2);
      expect(artefact.deployedBytecode.length).toBeGreaterThan(2);
      // Unlinked library placeholders would deploy bytecode that reverts on the
      // first library call. There are none, and there must stay none.
      expect(artefact.bytecode).not.toContain('__$');
    }
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(accounts, collectSources()));
    for (const name of ['AccountFactory', 'SmartAccount', 'SessionKeyLib'] as const) {
      expect(loadArtifact(name).sourceHash, `${name}.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build`).toBe(
        expected,
      );
    }
  });

  it('pins the compiler and EVM version, because both change the deployed address', () => {
    const artefact = loadArtifact('AccountFactory');
    expect(artefact.solcVersion).toBe('0.8.28');
    // paris, not shanghai: no PUSH0, so this bytecode deploys on chains that
    // have not adopted Shanghai. Changing it changes every CREATE2 address.
    expect(artefact.evmVersion).toBe('paris');
    expect(artefact.optimizer).toEqual({ enabled: true, runs: 200 });
  });
});

describe('committed launch artefacts match the Solidity in this tree', () => {
  const launch = (SUITES as Suite[]).find((s) => s.name === 'launch');

  it('has a compiled artefact for both launch contracts', () => {
    for (const name of ['SovereignToken', 'TokenFactory'] as const) {
      const artefact = loadArtifact(name);
      expect(artefact.contractName).toBe(name);
      expect(artefact.bytecode.length).toBeGreaterThan(2);
      expect(artefact.deployedBytecode.length).toBeGreaterThan(2);
      expect(artefact.bytecode).not.toContain('__$');
      expect(artefact.suite).toBe('launch');
    }
  });

  /**
   * Staleness matters more here than anywhere else in this service.
   *
   * A token's CREATE2 init code IS `SovereignToken.json`'s bytecode
   * (`launch/address.ts`), so an artefact that no longer corresponds to any
   * source in the tree does not produce a build error — it produces confident,
   * wrong addresses that a creator publishes.
   */
  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(launch, collectSources()));
    for (const name of ['SovereignToken', 'TokenFactory'] as const) {
      expect(loadArtifact(name).sourceHash, `${name}.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build`).toBe(
        expected,
      );
    }
  });

  /**
   * The launch suite has its OWN sourceHash, separate from the accounts suite.
   * That is the point of compiling them apart: editing a token template must
   * not mark every account artefact stale, and vice versa.
   */
  it('hashes the launch suite independently of the accounts suite', () => {
    expect(loadArtifact('SovereignToken').sourceHash).not.toBe(loadArtifact('AccountFactory').sourceHash);
  });

  it('pins the same compiler and EVM version as the rest of the tree', () => {
    const artefact = loadArtifact('SovereignToken');
    expect(artefact.solcVersion).toBe('0.8.28');
    expect(artefact.evmVersion).toBe('paris');
    expect(artefact.optimizer).toEqual({ enabled: true, runs: 200 });
  });

  /**
   * THE PRODUCT'S CENTRAL CLAIM, CHECKED AT THE ABI.
   *
   * `token-factory-onchain.test.ts` proves it against deployed bytecode, which
   * is the stronger check and needs a chain. This one needs nothing and fails
   * the build the moment somebody adds a mint function to the template — which
   * is the edit most likely to be waved through, because it looks like a
   * feature.
   */
  it('exposes no function that could inflate supply or confer control', () => {
    const names = loadArtifact('SovereignToken')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));

    for (const forbidden of ['mint', 'burn', 'owner', 'transferOwnership', 'renounceOwnership', 'pause', 'unpause', 'upgradeTo']) {
      expect(names, `SovereignToken must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    // The control, so this cannot pass by reading an empty list.
    expect(names).toContain('totalSupply');
    expect(names).toContain('transfer');
  });
});

describe('the hand-written ABI agrees with the compiled one', () => {
  const compiled = {
    AccountFactory: loadArtifact('AccountFactory').abi,
    SmartAccount: loadArtifact('SmartAccount').abi,
    TokenFactory: loadArtifact('TokenFactory').abi,
    SovereignToken: loadArtifact('SovereignToken').abi,
  } as const;

  const cases = [
    { contract: 'AccountFactory' as const, handWritten: accountFactoryAbi },
    { contract: 'SmartAccount' as const, handWritten: smartAccountAbi },
    { contract: 'TokenFactory' as const, handWritten: tokenFactoryAbi },
    // `erc20ReadAbi` is deliberately a SUBSET — reads only. This checks the
    // entries it does declare, which is the whole job: a wrong output type here
    // does not throw, it decodes the same bytes into a different value, and a
    // creator is shown a supply that is not the supply.
    { contract: 'SovereignToken' as const, handWritten: erc20ReadAbi },
  ];

  for (const { contract, handWritten } of cases) {
    describe(contract, () => {
      for (const entry of handWritten) {
        it(`${entry.type} ${entry.name} matches the contract`, () => {
          const actual = compiled[contract].find((item) => item.type === entry.type && 'name' in item && item.name === entry.name);
          expect(actual, `${contract}.${entry.name} is not on the compiled ABI at all`).toBeDefined();
          if (!actual || !('inputs' in actual)) throw new Error('unreachable');

          expect(signature(actual.inputs), 'input types').toBe(signature(entry.inputs as readonly AbiParameter[]));

          if (entry.type === 'function') {
            if (!('outputs' in actual)) throw new Error('unreachable');
            // The one that silently corrupts values rather than throwing.
            expect(signature(actual.outputs), 'output types').toBe(signature(entry.outputs as readonly AbiParameter[]));
            expect(actual.stateMutability, 'stateMutability').toBe(entry.stateMutability);
          }

          if (entry.type === 'event') {
            const indexed = (params: readonly AbiParameter[]) => params.map((p) => ('indexed' in p ? Boolean(p.indexed) : false));
            // Topic layout, not decoration: an `indexed` flag in the wrong place
            // moves a field between topics and data, and the log stops decoding.
            expect(indexed(actual.inputs), 'indexed flags').toEqual(indexed(entry.inputs as readonly AbiParameter[]));
          }
        });
      }
    });
  }
});

describe('committed AMM artefacts match the Solidity in this tree', () => {
  const amm = (SUITES as Suite[]).find((s) => s.name === 'amm');

  it('compiles ConstantProductPool + PoolFactory (no longer pinned broken)', () => {
    expect(amm?.expect).toBe('compiles');
    for (const name of ['ConstantProductPool', 'PoolFactory'] as const) {
      const artefact = loadArtifact(name);
      expect(artefact.contractName).toBe(name);
      expect(artefact.suite).toBe('amm');
      expect(artefact.bytecode.length).toBeGreaterThan(2);
      expect(artefact.bytecode).not.toContain('__$');
    }
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(amm, collectSources()));
    for (const name of ['ConstantProductPool', 'PoolFactory'] as const) {
      expect(loadArtifact(name).sourceHash, `${name}.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build`).toBe(
        expected,
      );
    }
  });

  it('hand-written pool/factory ABI entries match the compiled contracts', () => {
    const compiledPool = loadArtifact('ConstantProductPool').abi;
    const compiledFactory = loadArtifact('PoolFactory').abi;
    for (const entry of poolAbi) {
      const actual = compiledPool.find((item) => item.type === entry.type && 'name' in item && item.name === entry.name);
      expect(actual, `ConstantProductPool.${entry.name} missing`).toBeDefined();
      if (!actual || !('inputs' in actual) || !('outputs' in actual)) throw new Error('unreachable');
      expect(signature(actual.inputs)).toBe(signature(entry.inputs as readonly AbiParameter[]));
      expect(signature(actual.outputs)).toBe(signature(entry.outputs as readonly AbiParameter[]));
      expect(actual.stateMutability).toBe(entry.stateMutability);
    }
    for (const entry of factoryAbi) {
      const actual = compiledFactory.find((item) => item.type === entry.type && 'name' in item && item.name === entry.name);
      expect(actual, `PoolFactory.${entry.name} missing`).toBeDefined();
      if (!actual || !('inputs' in actual) || !('outputs' in actual)) throw new Error('unreachable');
      expect(signature(actual.inputs)).toBe(signature(entry.inputs as readonly AbiParameter[]));
      expect(signature(actual.outputs)).toBe(signature(entry.outputs as readonly AbiParameter[]));
      expect(actual.stateMutability).toBe(entry.stateMutability);
    }
  });
});

describe('committed router artefacts match the Solidity in this tree', () => {
  const routerSuite = (SUITES as Suite[]).find((s) => s.name === 'router');

  it('compiles SovereignRouter', () => {
    expect(routerSuite?.expect).toBe('compiles');
    const artefact = loadArtifact('SovereignRouter');
    expect(artefact.contractName).toBe('SovereignRouter');
    expect(artefact.suite).toBe('router');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(routerSuite, collectSources()));
    expect(
      loadArtifact('SovereignRouter').sourceHash,
      'SovereignRouter.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build',
    ).toBe(expected);
  });
});

describe('committed vault artefacts match the Solidity in this tree', () => {
  const vaults = (SUITES as Suite[]).find((s) => s.name === 'vaults');
  const vaultNames = ['CrewVault', 'LegacyVault', 'LaunchLpLock', 'LaunchVesting', 'DeployerReputation', 'TreasuryYieldVault'] as const;

  it('compiles crew/legacy/trust/yield vaults', () => {
    expect(vaults?.expect).toBe('compiles');
    for (const name of vaultNames) {
      const artefact = loadArtifact(name);
      expect(artefact.contractName).toBe(name);
      expect(artefact.suite).toBe('vaults');
      expect(artefact.bytecode.length).toBeGreaterThan(2);
      expect(artefact.bytecode).not.toContain('__$');
    }
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(vaults, collectSources()));
    for (const name of vaultNames) {
      expect(loadArtifact(name).sourceHash, `${name}.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build`).toBe(
        expected,
      );
    }
  });
});

describe('committed privacy artefacts match the Solidity in this tree', () => {
  const privacy = (SUITES as Suite[]).find((s) => s.name === 'privacy');

  it('compiles StealthAnnouncer', () => {
    expect(privacy?.expect).toBe('compiles');
    const artefact = loadArtifact('StealthAnnouncer');
    expect(artefact.contractName).toBe('StealthAnnouncer');
    expect(artefact.suite).toBe('privacy');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(privacy, collectSources()));
    expect(loadArtifact('StealthAnnouncer').sourceHash).toBe(expected);
  });
});

describe('committed venue artefacts match the Solidity in this tree', () => {
  const venue = (SUITES as Suite[]).find((s) => s.name === 'venue');

  it('compiles SovereignVenue (not a DevVenue fixture)', () => {
    expect(venue?.expect).toBe('compiles');
    const artefact = loadArtifact('SovereignVenue');
    expect(artefact.contractName).toBe('SovereignVenue');
    expect(artefact.suite).toBe('venue');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(venue, collectSources()));
    expect(loadArtifact('SovereignVenue').sourceHash).toBe(expected);
  });
});

describe('committed entrypoint artefacts match the Solidity in this tree', () => {
  const entrypoint = (SUITES as Suite[]).find((s) => s.name === 'entrypoint');

  it('compiles EntryPointGetUserOpHash', () => {
    expect(entrypoint?.expect).toBe('compiles');
    const artefact = loadArtifact('EntryPointGetUserOpHash');
    expect(artefact.contractName).toBe('EntryPointGetUserOpHash');
    expect(artefact.suite).toBe('entrypoint');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(entrypoint, collectSources()));
    expect(loadArtifact('EntryPointGetUserOpHash').sourceHash).toBe(expected);
  });
});

describe('committed paymaster artefacts match the Solidity in this tree', () => {
  const paymaster = (SUITES as Suite[]).find((s) => s.name === 'paymaster');

  it('compiles ScopedPaymaster before nft (nft stays last)', () => {
    const names = (SUITES as Suite[]).map((s) => s.name);
    expect(names.indexOf('paymaster')).toBeGreaterThan(-1);
    expect(names.indexOf('paymaster')).toBeLessThan(names.lastIndexOf('nft'));
    expect(paymaster?.expect).toBe('compiles');
    const artefact = loadArtifact('ScopedPaymaster');
    expect(artefact.contractName).toBe('ScopedPaymaster');
    expect(artefact.suite).toBe('paymaster');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(paymaster, collectSources()));
    expect(loadArtifact('ScopedPaymaster').sourceHash).toBe(expected);
  });

  it('exposes operator policy + float withdraw, not a user-fund pause', () => {
    const names = loadArtifact('ScopedPaymaster')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));
    for (const forbidden of ['pause', 'upgradeTo', 'upgradeToAndCall', 'execute']) {
      expect(names, `ScopedPaymaster must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    for (const required of ['validatePaymasterUserOp', 'setAllowlisted', 'withdrawFloat']) {
      expect(names).toContain(required);
    }
  });
});

describe('committed RWA artefacts match the Solidity in this tree', () => {
  const rwa = (SUITES as Suite[]).find((s) => s.name === 'rwa');

  it('compiles RwaRegistry before nft (nft stays last)', () => {
    const names = (SUITES as Suite[]).map((s) => s.name);
    expect(names.indexOf('rwa')).toBeGreaterThan(-1);
    expect(names.indexOf('rwa')).toBeLessThan(names.lastIndexOf('nft'));
    expect(rwa?.expect).toBe('compiles');
    const artefact = loadArtifact('RwaRegistry');
    expect(artefact.contractName).toBe('RwaRegistry');
    expect(artefact.suite).toBe('rwa');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(rwa, collectSources()));
    expect(loadArtifact('RwaRegistry').sourceHash).toBe(expected);
  });

  it('exposes register/unlist, not an admin licence switch', () => {
    const names = loadArtifact('RwaRegistry')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));
    for (const forbidden of ['pause', 'upgradeTo', 'upgradeToAndCall', 'setLicence', 'setAdmin']) {
      expect(names, `RwaRegistry must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    for (const required of ['register', 'unlist']) {
      expect(names).toContain(required);
    }
  });
});

describe('committed card-pull artefacts match the Solidity in this tree', () => {
  const card = (SUITES as Suite[]).find((s) => s.name === 'card');

  it('compiles CardPull before nft (nft stays last)', () => {
    const names = (SUITES as Suite[]).map((s) => s.name);
    expect(names.indexOf('card')).toBeGreaterThan(-1);
    expect(names.indexOf('card')).toBeLessThan(names.lastIndexOf('nft'));
    expect(card?.expect).toBe('compiles');
    const artefact = loadArtifact('CardPull');
    expect(artefact.contractName).toBe('CardPull');
    expect(artefact.suite).toBe('card');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(card, collectSources()));
    expect(loadArtifact('CardPull').sourceHash).toBe(expected);
  });

  it('exposes pullExact/kill, not a pause or issuer mint', () => {
    const names = loadArtifact('CardPull')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));
    for (const forbidden of ['pause', 'upgradeTo', 'upgradeToAndCall', 'mint']) {
      expect(names, `CardPull must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    for (const required of ['pullExact', 'kill', 'setSettlement']) {
      expect(names).toContain(required);
    }
  });
});

describe('committed NFT artefacts match the Solidity in this tree', () => {
  const nft = (SUITES as Suite[]).find((s) => s.name === 'nft');

  it('is the last suite so a launch-NFT edit cannot stale vault/privacy bytecode', () => {
    expect((SUITES as Suite[]).at(-1)?.name).toBe('nft');
  });

  it('compiles SovereignNft + RoyaltyMarket (enforced royalty, not signalling-only)', () => {
    expect(nft?.expect).toBe('compiles');
    expect(nft?.sources).toEqual(['nft/SovereignNft.sol', 'nft/RoyaltyMarket.sol', 'amm/IERC20Minimal.sol']);
    for (const name of ['SovereignNft', 'RoyaltyMarket'] as const) {
      const artefact = loadArtifact(name);
      expect(artefact.contractName).toBe(name);
      expect(artefact.suite).toBe('nft');
      expect(artefact.bytecode.length).toBeGreaterThan(2);
      expect(artefact.bytecode).not.toContain('__$');
    }
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(nft, collectSources()));
    for (const name of ['SovereignNft', 'RoyaltyMarket'] as const) {
      expect(loadArtifact(name).sourceHash, `${name}.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build`).toBe(
        expected,
      );
    }
  });

  it('pins the same compiler and EVM version as the rest of the tree', () => {
    const artefact = loadArtifact('SovereignNft');
    expect(artefact.solcVersion).toBe('0.8.28');
    expect(artefact.evmVersion).toBe('paris');
    expect(artefact.optimizer).toEqual({ enabled: true, runs: 200 });
  });
});

describe('committed meme artefacts match the Solidity in this tree', () => {
  const meme = (SUITES as Suite[]).find((s) => s.name === 'meme');

  it('compiles MemeLaunch without retagging the vaults LaunchLpLock artefact', () => {
    expect(meme?.expect).toBe('compiles');
    const artefact = loadArtifact('MemeLaunch');
    expect(artefact.contractName).toBe('MemeLaunch');
    expect(artefact.suite).toBe('meme');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
    expect(loadArtifact('LaunchLpLock').suite).toBe('vaults');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(meme, collectSources()));
    expect(
      loadArtifact('MemeLaunch').sourceHash,
      'MemeLaunch.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build',
    ).toBe(expected);
  });

  it('exposes no owner, fee, or platform surface', () => {
    const names = loadArtifact('MemeLaunch')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));
    for (const forbidden of ['owner', 'setFee', 'feeTo', 'setOwner', 'withdraw', 'pause']) {
      expect(names, `MemeLaunch must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    expect(names).toContain('launch');
    expect(names).toContain('tokenFactory');
    expect(names).toContain('poolFactory');
  });
});

describe('committed attestation artefacts match the Solidity in this tree', () => {
  const attestations = (SUITES as Suite[]).find((s) => s.name === 'attestations');

  it('compiles RankAttestation', () => {
    expect(attestations?.expect).toBe('compiles');
    const artefact = loadArtifact('RankAttestation');
    expect(artefact.contractName).toBe('RankAttestation');
    expect(artefact.suite).toBe('attestations');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(attestations, collectSources()));
    expect(
      loadArtifact('RankAttestation').sourceHash,
      'RankAttestation.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build',
    ).toBe(expected);
  });

  it('exposes no identity, KYC, or platform-issuer surface', () => {
    const names = loadArtifact('RankAttestation')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));
    for (const forbidden of ['email', 'name', 'userId', 'kyc', 'setIssuer', 'platformIssuer', 'owner', 'pause']) {
      expect(names, `RankAttestation must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    expect(names).toContain('attest');
    expect(names).toContain('revoke');
  });
});

describe('committed launchpad artefacts match the Solidity in this tree', () => {
  const launchpad = (SUITES as Suite[]).find((s) => s.name === 'launchpad');

  it('compiles FairLaunch in its own suite (TokenFactory artefact untouched)', () => {
    expect(launchpad?.expect).toBe('compiles');
    const artefact = loadArtifact('FairLaunch');
    expect(artefact.contractName).toBe('FairLaunch');
    expect(artefact.suite).toBe('launchpad');
    expect(artefact.sourceName).toBe('launch/FairLaunch.sol');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
    expect(loadArtifact('TokenFactory').suite).toBe('launch');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(launchpad, collectSources()));
    expect(
      loadArtifact('FairLaunch').sourceHash,
      'FairLaunch.json is stale. Run: pnpm --filter @intafaced/svc-protocol contracts:build',
    ).toBe(expected);
  });

  it('hashes the launchpad suite independently of the launch (factory) suite', () => {
    expect(loadArtifact('FairLaunch').sourceHash).not.toBe(loadArtifact('TokenFactory').sourceHash);
  });

  it('pins the same compiler and EVM version as the rest of the tree', () => {
    const artefact = loadArtifact('FairLaunch');
    expect(artefact.solcVersion).toBe('0.8.28');
    expect(artefact.evmVersion).toBe('paris');
    expect(artefact.optimizer).toEqual({ enabled: true, runs: 200 });
  });

  it('exposes no pause, whitelist, fee, revoke, or admin unlock', () => {
    const names = loadArtifact('FairLaunch')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));

    for (const forbidden of ['pause', 'unpause', 'owner', 'transferOwnership', 'revoke', 'unlock', 'setWhitelist', 'whitelist']) {
      expect(names, `FairLaunch must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    expect(names).toContain('contribute');
    expect(names).toContain('finalize');
    expect(names).toContain('claim');
    expect(names).toContain('refund');
  });
});

describe('committed recovery artefacts match the Solidity in this tree', () => {
  const recovery = (SUITES as Suite[]).find((s) => s.name === 'recovery');

  it('compiles UserElectedRecovery', () => {
    expect(recovery?.expect).toBe('compiles');
    const artefact = loadArtifact('UserElectedRecovery');
    expect(artefact.contractName).toBe('UserElectedRecovery');
    expect(artefact.suite).toBe('recovery');
    expect(artefact.bytecode.length).toBeGreaterThan(2);
    expect(artefact.bytecode).not.toContain('__$');
  });

  it('records a sourceHash that still matches the .sol files on disk', () => {
    const expected = computeSourceHash(suiteSources(recovery, collectSources()));
    expect(loadArtifact('UserElectedRecovery').sourceHash).toBe(expected);
  });

  it('exposes user-elected guardian recovery and no platform admin', () => {
    const names = loadArtifact('UserElectedRecovery')
      .abi.filter((entry) => entry.type === 'function')
      .map((entry) => ('name' in entry ? entry.name : ''));

    for (const forbidden of ['pause', 'setAdmin', 'upgradeTo', 'upgradeToAndCall']) {
      expect(names, `UserElectedRecovery must not expose ${forbidden}()`).not.toContain(forbidden);
    }
    for (const required of ['addGuardian', 'removeGuardian', 'setThreshold', 'proposeRecovery', 'cancelRecovery', 'executeRecovery']) {
      expect(names).toContain(required);
    }
  });
});

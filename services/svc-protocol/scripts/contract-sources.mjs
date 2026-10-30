/**
 * The compilation INPUT — shared by the compiler and by the test that checks
 * the committed output still matches the source.
 *
 * It lives apart from `compile-contracts.mjs` for one reason: that script does
 * work at import time (it compiles), so a test cannot import it just to reuse
 * the hashing. Everything here is pure.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACTS_DIR = join(SERVICE_ROOT, 'contracts');
export const OUT_DIR = join(CONTRACTS_DIR, 'out');

/** Pinned in package.json. A floating install must be loud, not silent. */
export const EXPECTED_SOLC = '0.8.28';

/**
 * Compiler settings. Any change here changes the bytecode, which changes every
 * CREATE2 address derived from it — so they are part of the source hash.
 *
 * `paris` is deliberate. Shanghai introduced PUSH0 and several chains that
 * matter to a permissionless account layer had not adopted it; paris bytecode
 * runs everywhere later bytecode runs, and a local dev chain does not get to
 * make that decision on production's behalf.
 */
export const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  outputSelection: {
    '*': {
      '*': [
        'abi',
        'evm.bytecode.object',
        'evm.deployedBytecode.object',
        /**
         * Where the constructor splices `immutable` values into the runtime.
         *
         * Requested because without it, comparing a deployed contract against
         * `deployedBytecode` is WRONG and looks right. `SovereignToken` has
         * three immutables (`decimals`, `totalSupply`, `initialHolder`); the
         * compiler emits zero placeholders for them and the constructor writes
         * the real values in, so a byte-identical check fails for every
         * correctly deployed token. Found by deploying one and looking.
         *
         * Note this is NOT part of `computeSourceHash` — outputSelection asks
         * for more output, it does not change the bytecode — so widening it
         * leaves every committed `sourceHash` valid.
         */
        'evm.deployedBytecode.immutableReferences',
      ],
    },
  },
};

export function sha256(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

/** Every `.sol` under contracts/, keyed by a posix path relative to contracts/. */
export function collectSources(dir = CONTRACTS_DIR) {
  const sources = {};
  for (const name of readdirSync(dir).sort()) {
    if (name === 'out') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      Object.assign(sources, collectSources(full));
      continue;
    }
    if (!name.endsWith('.sol')) continue;
    const key = relative(CONTRACTS_DIR, full).split('\\').join('/');
    // Normalise line endings: this repo is developed on Windows and checked out
    // on Linux CI. A CRLF checkout must not produce a different sourceHash, or
    // the integrity test fails for a reason that has nothing to do with the code.
    sources[key] = { content: readFileSync(full, 'utf8').replace(/\r\n/g, '\n') };
  }
  return sources;
}

/**
 * One hash over a suite's whole compilation input: sources, compiler version
 * and settings. Anything that could change the bytecode is inside it, which is
 * what makes a committed artefact checkable against the tree it came from.
 */
export function computeSourceHash(sources, version = EXPECTED_SOLC) {
  return sha256(
    JSON.stringify({
      solcVersion: version,
      settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
      sources: Object.fromEntries(
        Object.entries(sources)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, value]) => [key, sha256(value.content)]),
      ),
    }),
  );
}

/**
 * Suites are compiled separately so one broken contract cannot take the rest of
 * the tree with it — and so a known breakage is PINNED rather than tolerated.
 *
 * `expect: 'fails'` is not a shrug. The suite must fail, and fail with the
 * recorded signature. If it starts compiling, or breaks differently, the build
 * goes red and somebody has to look. A warning nobody must act on is how a gate
 * stops being a gate.
 */
export const SUITES = [
  {
    name: 'accounts',
    expect: 'compiles',
    /** §17.4 — the smart account layer. This is what `svc-protocol` serves. */
    sources: ['AccountFactory.sol', 'SessionKeyLib.sol', 'SmartAccount.sol', 'interfaces/IAccount.sol'],
  },
  {
    name: 'escrow',
    expect: 'compiles',
    /**
     * S-A3 / `protocol.escrow` — sovereign (non-custodial) P2P escrow.
     * Not the ledger escrow in svc-p2p. MockERC20 is suite-local for tests.
     */
    sources: ['escrow/SovereignEscrow.sol', 'escrow/MockERC20.sol', 'amm/IERC20Minimal.sol'],
  },
  {
    name: 'passkey',
    expect: 'compiles',
    /**
     * S-A9 / `socket.p256-verifier` — P-256 owner that answers ERC-1271.
     * Own suite so an accounts edit does not stale this bytecode (and reverse).
     */
    sources: ['passkey/P256.sol', 'passkey/PasskeyOwner.sol', 'interfaces/IAccount.sol'],
  },
  {
    name: 'launch',
    expect: 'compiles',
    /**
     * §8.4 — the token factory (`launch.token-factory`).
     *
     * Its own suite rather than folded into `accounts`, for the reason the
     * `amm` entry below demonstrates: a suite is the blast radius of a broken
     * contract. It also keeps `sourceHash` separate, so editing a launch
     * template does not mark every account artefact stale, or the reverse.
     */
    sources: ['launch/SovereignToken.sol', 'launch/TokenFactory.sol'],
  },
  {
    name: 'amm',
    expect: 'compiles',
    /**
     * `protocol.amm` — constant-product pool + factory.
     *
     * Was pinned `fails` while `swapExactIn` called `external swap` by name
     * (Undeclared identifier). Fixed via private `_swap` shared by both
     * entrypoints — external ABI of `swap` unchanged for calldata builders.
     */
    sources: ['amm/ConstantProductPool.sol', 'amm/IERC20Minimal.sol', 'amm/PoolFactory.sol'],
  },
  {
    name: 'oracle',
    expect: 'compiles',
    /** S-A12 — fail-closed dual-source marks. Never reads AMM. */
    sources: ['oracle/IPriceOracle.sol', 'oracle/FailClosedOracle.sol'],
  },
  {
    name: 'lending',
    expect: 'compiles',
    /** S-A4 — isolated over-collateral market; needs oracle interface + ERC-20. */
    sources: [
      'lending/IsolatedLendingMarket.sol',
      'lending/test/LendingAdversary.sol',
      'oracle/IPriceOracle.sol',
      'amm/IERC20Minimal.sol',
      'test/MockERC20.sol',
    ],
  },
  {
    name: 'merchant',
    expect: 'compiles',
    /** S-A6 — zero-KYB merchant accept; platform never hardcoded. */
    sources: ['merchant/MerchantAccept.sol', 'amm/IERC20Minimal.sol', 'test/MockERC20.sol'],
  },
  {
    name: 'router',
    expect: 'compiles',
    /**
     * S-A5 — pool execution router; book compare is off-chain.
     * Does NOT compile ConstantProductPool into this suite (would overwrite
     * amm artefacts). Uses the inline IConstantProductPool interface only.
     */
    sources: ['router/SovereignRouter.sol', 'amm/IERC20Minimal.sol'],
  },
  {
    name: 'vaults',
    expect: 'compiles',
    /** S-L1 crew + S-L2 legacy + S-L4 lock/vest/reputation + S-L5 treasury yield. */
    sources: [
      'vaults/CrewVault.sol',
      'vaults/LegacyVault.sol',
      'vaults/TreasuryYieldVault.sol',
      'trust/LaunchLpLock.sol',
      'trust/LaunchVesting.sol',
      'trust/DeployerReputation.sol',
      'amm/IERC20Minimal.sol',
      'test/MockERC20.sol',
    ],
  },
  {
    name: 'test-chain',
    expect: 'compiles',
    /**
     * The local stack's TEST tokens (tooling/scripts/local-test-chain.mjs): name, symbol and decimals as immutables,
     * EIP-2612 + EIP-5267. Own suite so it stales nothing else. Not a product token: anyone may mint.
     */
    sources: ['test/TestToken.sol'],
  },
  {
    name: 'privacy',
    expect: 'compiles',
    /** S-L3 stealth announcement log — no identity fields. */
    sources: ['privacy/StealthAnnouncer.sol'],
  },
  {
    name: 'venue',
    expect: 'compiles',
    /**
     * S-C1 — real CLOB (not DevVenue). Own suite so a book edit does not stale
     * vault bytecode. MockERC20 is test-only; artefact name collides with
     * lending/vaults so those suites still own MockERC20.json.
     */
    sources: ['venue/SovereignVenue.sol', 'amm/IERC20Minimal.sol'],
  },
  {
    name: 'venue-decimals-fixtures',
    expect: 'compiles',
    /** T1 — constructor-set decimals so venue 6/8-dec tests do not collide with MockERC20.json. */
    sources: ['test/MockERC20Dec.sol'],
  },
  {
    name: 'entrypoint',
    expect: 'compiles',
    /**
     * S-A11 / `socket.userop-differential-test` — ERC-4337 v0.7 getUserOpHash
     * so TypeScript can be checked against the Solidity the live EntryPoint runs.
     */
    sources: ['entrypoint/EntryPointGetUserOpHash.sol'],
  },
  {
    name: 'meme',
    expect: 'compiles',
    /**
     * S-G1 / `launch.meme-factory` — compose TokenFactory + PoolFactory + LaunchLpLock.
     *
     * Factories are constructor addresses (inline interfaces) so this suite does
     * not recompile TokenFactory/PoolFactory. `new LaunchLpLock` still needs
     * LaunchLpLock.sol in the compile input; do not commit the overwritten
     * `out/LaunchLpLock.json` — vaults remains the artefact owner.
     */
    sources: ['launch/MemeLaunch.sol', 'trust/LaunchLpLock.sol', 'amm/IERC20Minimal.sol'],
  },
  {
    name: 'attestations',
    expect: 'compiles',
    /**
     * S-F1 / `blueprint.attestations` — on-chain rank standing, zero PII.
     * Subject is a commitment, never an address / name / email / user id / KYC.
     * Permissionless issuers; consumers choose whom to trust off-chain.
     */
    sources: ['attestations/RankAttestation.sol'],
  },
  {
    name: 'launchpad',
    expect: 'compiles',
    /**
     * S-G2 / `launch.launchpad` — fair launch + in-contract cliff/linear vest.
     * Own suite so editing this file cannot stale TokenFactory.json (launch suite).
     */
    sources: ['launch/FairLaunch.sol', 'amm/IERC20Minimal.sol'],
  },
  {
    name: 'recovery',
    expect: 'compiles',
    /**
     * S-A1 / `socket.social-recovery` — user-elected M-of-N ERC-1271 owner.
     * Platform is never a guardian. Own suite so an accounts edit does not
     * stale this bytecode (and reverse).
     */
    sources: ['recovery/UserElectedRecovery.sol', 'interfaces/IAccount.sol'],
  },
  {
    name: 'paymaster',
    expect: 'compiles',
    /**
     * S-A10 / `socket.paymaster-policy` — contract half. Holds a native float;
     * unfunded validation fails. Operator cannot touch user accounts.
     * Own suite so an accounts edit does not stale this bytecode (and reverse).
     */
    sources: ['paymaster/ScopedPaymaster.sol', 'interfaces/IPaymaster.sol', 'interfaces/IAccount.sol'],
  },
  {
    name: 'rwa',
    expect: 'compiles',
    /**
     * S-G4 / `launch.rwa` — licence-gated issuance registry. Zero hash refuses.
     * Licence *content* is Class X. Own suite so a vaults edit does not stale
     * this bytecode (and reverse). nft stays last.
     */
    sources: ['rwa/RwaRegistry.sol'],
  },
  {
    name: 'card',
    expect: 'compiles',
    /**
     * S-E1 / sovereign-card on-chain half — exact pull from the user's
     * SmartAccount to a user-chosen settlement. This contract never holds
     * tokens. nft stays last. Do not compile MockERC20 here.
     */
    sources: ['card/CardPull.sol', 'interfaces/ICardPull.sol', 'amm/IERC20Minimal.sol'],
  },
  {
    name: 'nft',
    expect: 'compiles',
    /**
     * S-G3 / `launch.nft` — mint, fixed-price list, English auction.
     * RoyaltyMarket pays ERC-2981 on sale; signalling-only is not this suite.
     */
    sources: ['nft/SovereignNft.sol', 'nft/RoyaltyMarket.sol', 'amm/IERC20Minimal.sol'],
  },
];

/** The exact `sources` object a suite is compiled from. */
export function suiteSources(suite, all = collectSources()) {
  const missing = suite.sources.filter((key) => !(key in all));
  if (missing.length > 0) throw new Error(`suite "${suite.name}": missing source(s) ${missing.join(', ')}`);
  return Object.fromEntries([...suite.sources].sort().map((key) => [key, all[key]]));
}

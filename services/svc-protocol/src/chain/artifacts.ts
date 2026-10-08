import { readFileSync } from 'node:fs';
import type { Abi, Hex } from 'viem';

/**
 * The compiled contracts, loaded from `contracts/out/`.
 *
 * `contracts/*.sol` used to be source nobody had ever run through a compiler —
 * `abi.ts` still says so in its header, and it was true until
 * `scripts/compile-contracts.mjs` landed. This module is the seam between the
 * committed build output and everything that needs it: the dev-chain deployer,
 * and the tests that check the TypeScript in this service against the Solidity
 * it claims to mirror.
 *
 * ── One caller IS on a request path now, and has to be ─────────────────────
 *
 * This used to say "not on any request path": the service read chain state
 * through the hand-written ABI in `abi.ts`, nothing here was imported at boot,
 * and a missing `contracts/out` could therefore only ever be a build-time
 * problem.
 *
 * `src/launch/address.ts` changes that, unavoidably. A smart account is an
 * EIP-1167 clone whose creation code is 55 bytes derivable from constants; a
 * launched token is a full contract, so its CREATE2 init code IS the compiler's
 * `bytecode` output. There is no way to predict a token address without it.
 *
 * The guarantee is preserved rather than dropped: that module calls
 * `loadArtifact` ONCE at import, so a missing artefact fails the service at
 * BOOT rather than surfacing as a 500 on a creator's first launch — or, far
 * worse, as an address derived from bytecode that is not there. Read its header
 * before adding a second request-path caller.
 *
 * The path is resolved from `import.meta.url` rather than `process.cwd()` so it
 * works the same from `src/` under vitest, from `dist/` under node, and from
 * `scripts/` under tsx — all three sit exactly two levels below the service root.
 */

export type ArtifactName =
  | 'AccountFactory'
  | 'SmartAccount'
  | 'SessionKeyLib'
  | 'SovereignToken'
  | 'TokenFactory'
  | 'ConstantProductPool'
  | 'PoolFactory'
  | 'FailClosedOracle'
  | 'IsolatedLendingMarket'
  | 'MerchantAccept'
  | 'SovereignRouter'
  | 'CrewVault'
  | 'LegacyVault'
  | 'LaunchLpLock'
  | 'LaunchVesting'
  | 'DeployerReputation'
  | 'TreasuryYieldVault'
  | 'StealthAnnouncer'
  | 'SovereignVenue'
  | 'SovereignEscrow'
  | 'MockERC20'
  | 'MockERC20Dec'
  | 'LendingSameTxRoundTrip'
  | 'ReenteringBorrowToken'
  | 'InFlightBorrower'
  | 'PasskeyOwner'
  | 'P256'
  | 'EntryPointGetUserOpHash'
  | 'SovereignNft'
  | 'RoyaltyMarket'
  | 'MemeLaunch'
  | 'RankAttestation'
  | 'FairLaunch'
  | 'UserElectedRecovery'
  | 'ScopedPaymaster'
  | 'RwaRegistry'
  | 'CardPull';

export interface ContractArtifact {
  readonly contractName: string;
  readonly sourceName: string;
  readonly suite: string;
  readonly solcVersion: string;
  readonly evmVersion: string;
  readonly optimizer: { readonly enabled: boolean; readonly runs: number };
  /** sha256 over the compilation input. `artifacts.test.ts` re-derives it. */
  readonly sourceHash: Hex;
  readonly abi: Abi;
  /** Creation code, ready for a deployment transaction. */
  readonly bytecode: Hex;
  /**
   * Runtime code as the COMPILER produced it.
   *
   * Not, in general, what `eth_getCode` returns — see `immutableReferences`.
   * Use `deployedCodeMatches()` rather than comparing this directly.
   */
  readonly deployedBytecode: Hex;
  /**
   * Where the constructor writes `immutable` values into the runtime, keyed by
   * AST id. Byte offsets into `deployedBytecode`.
   */
  readonly immutableReferences?: Readonly<Record<string, ReadonlyArray<{ start: number; length: number }>>>;
}

export class MissingArtifactError extends Error {
  constructor(name: string, cause: unknown) {
    super(
      `No compiled artefact for ${name}. Run \`pnpm --filter @intafaced/svc-protocol contracts:build\`. ` +
        `Artefacts are committed under contracts/out/ so tests and deploys do not each run a compiler.`,
      { cause },
    );
    this.name = 'MissingArtifactError';
  }
}

export function loadArtifact(name: ArtifactName): ContractArtifact {
  const url = new URL(`../../contracts/out/${name}.json`, import.meta.url);
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as ContractArtifact;
  } catch (err) {
    throw new MissingArtifactError(name, err);
  }
}

/**
 * IS THE CODE AT THIS ADDRESS THIS ARTEFACT? — the check that is wrong if you
 * write the obvious version.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `runtime === artifact.deployedBytecode` IS FALSE FOR A CORRECT DEPLOYMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Solidity `immutable` variables are not storage. The compiler emits ZERO
 * placeholders for them inside the runtime code and the constructor splices the
 * real values in, so the bytes on chain genuinely differ from the compiler's
 * `deployedBytecode` — by exactly the immutables and nothing else.
 *
 * `SovereignToken` has three (`decimals`, `totalSupply`, `initialHolder`), so a
 * byte-equality check rejects every legitimately launched token. This was
 * written the obvious way first and caught by deploying one and looking at the
 * diff: `12` where the artefact had `00` was `decimals = 18`.
 *
 * The failure mode of getting this wrong is not a broken feature, it is a
 * DISHONEST one — a "verified against the audited template" badge that is
 * permanently false would train everyone to ignore it, which is worse than not
 * having it.
 *
 * So the immutable ranges are masked on BOTH sides and everything else must
 * match byte for byte. What that still catches is the whole point: a factory
 * that deploys a different token, a template swapped after the fact, a proxy
 * where a real contract should be.
 */
export function deployedCodeMatches(artifact: ContractArtifact, runtime: string | null | undefined): boolean {
  if (!runtime || runtime === '0x') return false;

  const expected = artifact.deployedBytecode.slice(2).toLowerCase();
  const actual = runtime.slice(2).toLowerCase();
  // Length is compared before masking. An immutable never changes the size of
  // the runtime, so a different length is a different contract, full stop.
  if (expected.length !== actual.length) return false;

  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');

  for (const ranges of Object.values(artifact.immutableReferences ?? {})) {
    for (const { start, length } of ranges) {
      // Zero both sides over the range rather than skipping it, so the
      // comparison stays a single buffer equality and cannot drift out of sync
      // with the offsets.
      expectedBytes.fill(0, start, start + length);
      actualBytes.fill(0, start, start + length);
    }
  }

  return expectedBytes.equals(actualBytes);
}

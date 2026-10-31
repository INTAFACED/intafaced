import type { Hex } from 'viem';

/**
 * Which chain a row was read from: the chain id and the hash of its block 0.
 *
 * A chain id alone does not name a chain. A TEST chain (anvil) started again keeps its id but begins from a new genesis,
 * and everything read from the old one (an owner at a block, a mint's tx hash, a deployed account) is no longer true.
 * Rows that come from a chain read store the genesis hash beside the chain id, and a row whose genesis is not the
 * current chain's counts as absent: the service reads or proves it again, or refuses with a typed code.
 *
 * A row written before its table had the column carries no genesis (null). It is kept as it was: the service cannot
 * tell which chain it came from, and treating it as absent could repeat something that already happened on a
 * long-lived chain (a second badge mint). Only a row that names another genesis is set aside.
 */
export interface ChainIdentity {
  readonly chainId: number;
  /** Lower-case 0x hex, 32 bytes. */
  readonly genesisHash: Hex;
}

/** True when a stored row's genesis names a chain other than `current`. Null (written before the column) is not. */
export function fromAnotherChain(stored: string | null | undefined, current: ChainIdentity): boolean {
  return stored != null && stored.toLowerCase() !== current.genesisHash;
}

/** How long a read genesis is reused. A TEST chain started again is seen within this time. */
export const CHAIN_IDENTITY_TTL_MS = 10_000;

/**
 * The current chain's identity, read once per `ttlMs` and shared by concurrent callers. A failed read is not kept: it
 * refuses with the chain's own typed code (`ProtocolChain.genesisHash`), and the next call reads again.
 */
export function chainIdentityReader(
  chain: { readonly config: { readonly chainId: number }; genesisHash(): Promise<Hex> },
  ttlMs: number = CHAIN_IDENTITY_TTL_MS,
  now: () => number = Date.now,
): () => Promise<ChainIdentity> {
  let held: { at: number; read: Promise<ChainIdentity> } | null = null;
  return () => {
    const t = now();
    if (held && t - held.at < ttlMs) return held.read;
    const read = chain
      .genesisHash()
      .then((genesisHash) => ({ chainId: chain.config.chainId, genesisHash: genesisHash.toLowerCase() as Hex }));
    const entry = { at: t, read };
    held = entry;
    read.catch(() => {
      if (held === entry) held = null;
    });
    return read;
  };
}

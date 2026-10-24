import { isExplicitDevOrTest } from '@intafaced/config';
import { getAddress as toChecksum, hashMessage, recoverAddress, type Address, type Hex } from 'viem';

/**
 * THE FIRST-SIGNING REPRESENTATION (D-developer-compliance-03).
 *
 * Before a wallet's first signing action in the Web3 rooms, the person accepts a sanctions representation once, per
 * version. It is a recorded consent with its version and time, not a screening: the edge geo-block stays the gate.
 *
 * The record is keyed by wallet address and the visitor may be signed out, so a row is written only on proof that
 * the address itself signed the exact text of the current version. Nobody can record a consent for someone else's
 * address. The wording is counsel's and the version the owner's; either blank refuses and no signing action starts.
 */

export const REPRESENTATION_UNSET = 'compliance.representation_unset' as const;
export const REPRESENTATION_VERSION_STALE = 'compliance.representation_version_stale' as const;
export const REPRESENTATION_SIGNATURE_NOT_OWNER = 'compliance.representation_signature_not_owner' as const;

export type RepresentationRefusalCode =
  typeof REPRESENTATION_UNSET | typeof REPRESENTATION_VERSION_STALE | typeof REPRESENTATION_SIGNATURE_NOT_OWNER;

export class RepresentationRefusedError extends Error {
  constructor(
    readonly code: RepresentationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepresentationRefusedError';
  }
}

/** The owner's published representation. Null when either half is blank. */
export interface RepresentationSetting {
  readonly version: string;
  readonly text: string;
}

/**
 * Read once at boot. A version labelled TEST (the local test stack's placeholder, not counsel's text) is honoured only
 * when the raw APP_ENV is exactly `dev` or `test`; anywhere else it refuses to boot, so no wallet ever records a
 * consent to placeholder wording.
 */
export function representationFromSetting(
  version: string | undefined,
  text: string | undefined,
  rawAppEnv: string | undefined,
): RepresentationSetting | null {
  const v = version?.trim() ?? '';
  const t = text?.trim() ?? '';
  if (!v || !t) return null;
  if (/^test/i.test(v) && !isExplicitDevOrTest(rawAppEnv))
    throw new Error(
      `PROTOCOL_REPRESENTATION_VERSION is a TEST version but APP_ENV=${rawAppEnv ?? '(unset)'} is not the local test stack (APP_ENV must be exactly "dev" or "test"). Refusing to boot.`,
    );
  return { version: v, text: t };
}

export interface RepresentationRecord {
  readonly chainId: number;
  readonly address: Address;
  readonly version: string;
  readonly message: string;
  readonly signature: Hex;
  readonly acceptedAt: Date;
}

export interface RepresentationStore {
  find(chainId: number, address: Address, version: string): Promise<RepresentationRecord | null>;
  /** Inserts once per (chain, address, version) and returns the stored row: a second accept keeps the first time. */
  put(record: Omit<RepresentationRecord, 'acceptedAt'>): Promise<RepresentationRecord>;
}

/** The exact text the wallet signs. Scoped to one chain, one address and one version; it authorises nothing. */
export function representationMessage(args: { setting: RepresentationSetting; chainId: number; address: Address }): string {
  return [
    'INTAFACED — representation before signing',
    '',
    args.setting.text,
    '',
    `version: ${args.setting.version}`,
    `address: ${toChecksum(args.address)}`,
    `chain:   ${args.chainId}`,
    '',
    'Signing this records that you accepted the text above. It grants no permission and moves no funds.',
  ].join('\n');
}

function requireSetting(setting: RepresentationSetting | null): RepresentationSetting {
  if (!setting) {
    throw new RepresentationRefusedError(
      REPRESENTATION_UNSET,
      'The representation before signing is not published, so no signing action can start.',
    );
  }
  return setting;
}

export interface RepresentationStatus {
  readonly version: string;
  readonly text: string;
  readonly message: string;
  readonly accepted: boolean;
  readonly acceptedAt: Date | null;
}

export async function representationStatus(
  store: RepresentationStore,
  setting: RepresentationSetting | null,
  chainId: number,
  address: Address,
): Promise<RepresentationStatus> {
  const current = requireSetting(setting);
  const owner = toChecksum(address);
  const found = await store.find(chainId, owner, current.version);
  return {
    version: current.version,
    text: current.text,
    message: representationMessage({ setting: current, chainId, address: owner }),
    accepted: found !== null,
    acceptedAt: found?.acceptedAt ?? null,
  };
}

export async function acceptRepresentation(
  store: RepresentationStore,
  setting: RepresentationSetting | null,
  chainId: number,
  input: { address: Address; version: string; signature: Hex },
): Promise<RepresentationRecord> {
  const current = requireSetting(setting);
  if (input.version !== current.version) {
    throw new RepresentationRefusedError(
      REPRESENTATION_VERSION_STALE,
      `The representation changed (now version ${current.version}). Read it again and sign the current version.`,
    );
  }
  const owner = toChecksum(input.address);
  const message = representationMessage({ setting: current, chainId, address: owner });
  let recovered: Address | null = null;
  try {
    recovered = await recoverAddress({ hash: hashMessage(message), signature: input.signature });
  } catch {
    recovered = null;
  }
  // An externally owned wallet only: a smart-account (contract) signature does not recover and is refused here.
  if (!recovered || toChecksum(recovered) !== owner) {
    throw new RepresentationRefusedError(REPRESENTATION_SIGNATURE_NOT_OWNER, 'The signature does not come from this wallet address.');
  }
  return store.put({ chainId, address: owner, version: current.version, message, signature: input.signature });
}

/** In-memory store for tests. */
export class MemoryRepresentationStore implements RepresentationStore {
  readonly rows = new Map<string, RepresentationRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  private key(chainId: number, address: Address, version: string) {
    return `${chainId}:${toChecksum(address)}:${version}`;
  }
  async find(chainId: number, address: Address, version: string) {
    return this.rows.get(this.key(chainId, address, version)) ?? null;
  }
  async put(record: Omit<RepresentationRecord, 'acceptedAt'>) {
    const key = this.key(record.chainId, record.address, record.version);
    const existing = this.rows.get(key);
    if (existing) return existing;
    const stored = { ...record, acceptedAt: this.now() };
    this.rows.set(key, stored);
    return stored;
  }
}

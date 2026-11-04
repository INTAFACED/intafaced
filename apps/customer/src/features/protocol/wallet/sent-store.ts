/**
 * The transactions this browser asked the person's wallet to send, kept so Activity can show one before the indexer
 * reads its block (pending), and so a speed-up or cancel keeps both hashes (RC-dex-protocol-01, SAGA-2): the row says
 * which one the chain shows and never claims "replaced" or "canceled" until the chain does.
 *
 * Browser storage only, per network and wallet address; nothing about a signature is kept. A convenience: with storage
 * blocked or cleared, Activity still lists everything the indexer has read.
 */
export interface SentRecord {
  hash: string;
  /** Unix milliseconds when the wallet answered with the hash. */
  sentAt: number;
  /** What it was, in the room's words: a send, or a replacement of `replaces`. */
  kind: 'send' | 'speedUp' | 'cancel' | 'other';
  /** What it does in plain words, as the room wrote it when it was sent ("1 TEST Token A to 0x5290…"). */
  label?: string;
  /** For a speed-up or cancel: the hash it replaces at the same nonce. */
  replaces?: string;
}

const LIMIT = 50;
const keyFor = (chainId: number, address: string) => `intafaced.wallet.sent.${chainId}.${address.toLowerCase()}`;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function readSent(chainId: number, address: string): SentRecord[] {
  try {
    const raw = store()?.getItem(keyFor(chainId, address));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SentRecord =>
        typeof entry === 'object' &&
        entry !== null &&
        HASH.test((entry as SentRecord).hash) &&
        typeof (entry as SentRecord).sentAt === 'number' &&
        ['send', 'speedUp', 'cancel', 'other'].includes((entry as SentRecord).kind) &&
        ((entry as SentRecord).replaces === undefined || HASH.test((entry as SentRecord).replaces!)) &&
        ((entry as SentRecord).label === undefined || typeof (entry as SentRecord).label === 'string'),
    );
  } catch {
    return [];
  }
}

/** Adds one record (newest first, at most LIMIT kept). Silently does nothing where storage is blocked. */
export function recordSent(chainId: number, address: string, record: SentRecord): void {
  try {
    const next = [record, ...readSent(chainId, address).filter((entry) => entry.hash.toLowerCase() !== record.hash.toLowerCase())];
    store()?.setItem(keyFor(chainId, address), JSON.stringify(next.slice(0, LIMIT)));
  } catch {
    /* storage blocked: Activity still shows what the indexer read */
  }
}

import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * The embedded login's key, held on this device only (RC-dex-protocol-05). The browser makes the key; a passkey's PRF
 * output, read with a fresh assertion, derives the AES-GCM key that wraps it; only the wrapped key, its passkey's id and the
 * account address are kept, in IndexedDB. The key is never sent anywhere: the module's only network calls are the export
 * fact's status and its record, which carry the account and a signature (embedded-api.ts). With storage blocked, or a
 * passkey without PRF, the vault refuses to make a key rather than hold one in memory only.
 */
export type VaultRecord = {
  address: string;
  credentialId: string;
  /** PRF input salt and AES-GCM IV, base64url. */
  salt: string;
  iv: string;
  wrapped: string;
  /** Set once the key was shown on this device. */
  spent: boolean;
  /** The key's signature over the export message, kept until the service has the record, then cleared. Not key material. */
  exportSignature?: string;
  /** The chain the export message names (the service's, read from its status). */
  exportChainId?: number;
  createdAt: string;
};

export class VaultRefusedError extends Error {
  constructor(
    readonly code:
      | 'wallet.storage_blocked'
      | 'wallet.passkey_prf_unsupported'
      | 'wallet.passkey_cancelled'
      | 'wallet.export_spent'
      | 'wallet.vault_exists'
      | 'wallet.unwrap_failed',
    message: string,
  ) {
    super(message);
    this.name = 'VaultRefusedError';
  }
}

const DB = 'intafaced-embedded';
const STORE = 'keys';
const RECORD = 'embedded';

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
/** A copy backed by a plain ArrayBuffer, as WebCrypto and WebAuthn take it. */
const bytes = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);
const unb64 = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB, 1);
    } catch {
      return reject(new VaultRefusedError('wallet.storage_blocked', 'This browser does not let the page keep a key.'));
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onblocked = () =>
      reject(new VaultRefusedError('wallet.storage_blocked', 'Another tab holds this page’s storage. Close it and try again.'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new VaultRefusedError('wallet.storage_blocked', 'This browser does not let the page keep a key.'));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  const refused = () => new VaultRefusedError('wallet.storage_blocked', 'This browser does not let the page keep a key.');
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    // Settled only when the transaction is durable (or failed), never on the request alone; the connection then closes.
    transaction.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    transaction.onabort = transaction.onerror = () => {
      db.close();
      reject(refused());
    };
  });
}

export const readVault = (): Promise<VaultRecord | null> =>
  tx('readonly', (store) => store.get(RECORD)).then((row) => (row as VaultRecord) ?? null);
const writeVault = (record: VaultRecord) => tx('readwrite', (store) => store.put(record, RECORD));

/** The PRF output of a fresh, user-verified assertion with this passkey. */
async function prfSecret(credentialId: string, salt: Uint8Array): Promise<ArrayBuffer> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: unb64(credentialId) }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: bytes(salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    throw new VaultRefusedError('wallet.passkey_cancelled', 'The passkey check did not finish.');
  }
  const prf = (credential?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf;
  const first = prf?.results?.first;
  if (!first) throw new VaultRefusedError('wallet.passkey_prf_unsupported', 'This passkey cannot protect a key on this device.');
  return first;
}

async function wrappingKey(secret: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: new TextEncoder().encode('INTAFACED embedded login v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Makes the key, wraps it with a new passkey and keeps only the wrapped key. Returns the account address. */
export async function createVault(rpName: string): Promise<VaultRecord> {
  if (typeof indexedDB === 'undefined')
    throw new VaultRefusedError('wallet.storage_blocked', 'This browser does not let the page keep a key.');
  // Fails early, before any key exists, when storage is blocked; and never replaces a key this device already keeps.
  if (await readVault()) throw new VaultRefusedError('wallet.vault_exists', 'This device already keeps an embedded login.');
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let created: PublicKeyCredential | null;
  try {
    created = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: rpName },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'embedded-login', displayName: 'Embedded login' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: bytes(salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    throw new VaultRefusedError('wallet.passkey_cancelled', 'The passkey was not made.');
  }
  if (!created) throw new VaultRefusedError('wallet.passkey_cancelled', 'The passkey was not made.');
  const credentialId = b64(new Uint8Array(created.rawId));
  // A passkey that says it has no PRF is refused before any key exists. One that gives the secret at creation saves a
  // second prompt; one that does not is asked once more.
  const prf = (created.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }).prf;
  if (prf?.enabled === false)
    throw new VaultRefusedError('wallet.passkey_prf_unsupported', 'This passkey cannot protect a key on this device.');
  const aes = await wrappingKey(prf?.results?.first ?? (await prfSecret(credentialId, salt)), salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let key: Hex | null = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, bytes(hexToBytes(key))));
  key = null;
  const record: VaultRecord = {
    address,
    credentialId,
    salt: b64(salt),
    iv: b64(iv),
    wrapped: b64(wrapped),
    spent: false,
    createdAt: new Date().toISOString(),
  };
  await writeVault(record);
  return record;
}

/** Unwraps the key after a fresh passkey check. The caller shows it once, then calls `markSpent`. */
export async function unwrapOnce(record: VaultRecord): Promise<Hex> {
  if (record.spent) throw new VaultRefusedError('wallet.export_spent', 'This key was already exported.');
  const salt = unb64(record.salt);
  const aes = await wrappingKey(await prfSecret(record.credentialId, salt), salt);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, aes, unb64(record.wrapped)));
  } catch {
    throw new VaultRefusedError('wallet.unwrap_failed', 'This passkey does not unlock the key kept on this device.');
  }
  return bytesToHex(plain);
}

/** Marks the key shown on this device, keeping the signed export message until the service has it. */
export async function markSpent(record: VaultRecord, exported?: { signature: string; chainId: number }): Promise<VaultRecord> {
  const next: VaultRecord = {
    ...record,
    spent: true,
    ...(exported ? { exportSignature: exported.signature, exportChainId: exported.chainId } : {}),
  };
  await writeVault(next);
  return next;
}

/** Forgets the signed export message once the service has recorded the export. */
export async function markRecorded(record: VaultRecord): Promise<VaultRecord> {
  const { exportSignature: _signature, exportChainId: _chain, ...rest } = record;
  await writeVault(rest);
  return rest;
}

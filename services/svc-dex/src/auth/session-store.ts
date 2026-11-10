/**
 * What the order session must remember (D-limit-dca-01, ENGINE SIG-1): the nonces already spent, the sessions signed out
 * and, per wallet, the moment "sign out everywhere" was pressed. One JSON file, `dex.auth.json`, under the same directory
 * as the orders (`DEX_ORDER_STORE_DIR`). It holds no balance, no key and no signature. Entries are kept only until the
 * token or challenge they guard would have expired anyway, so the file stays small.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Shape {
  /** nonce -> when it stops mattering (ms) */
  nonces: Record<string, number>;
  /** session id -> when it stops mattering (ms) */
  revoked: Record<string, number>;
  /** lowercase wallet -> tokens issued before this moment (ms) are revoked */
  before: Record<string, number>;
}

export interface SessionStore {
  /** True the first time `nonce` is spent; false every later time. */
  spendNonce(nonce: string, until: number): boolean;
  revokeSession(sessionId: string, until: number): void;
  revokeWalletBefore(wallet: string, at: number): void;
  revoked(sessionId: string, wallet: string, issuedAt: number): boolean;
}

export class FileSessionStore implements SessionStore {
  private readonly path: string;
  private data: Shape;

  constructor(
    dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.path = join(dir, 'dex.auth.json');
    this.data = existsSync(this.path) ? parse(readFileSync(this.path, 'utf8')) : { nonces: {}, revoked: {}, before: {} };
  }

  spendNonce(nonce: string, until: number): boolean {
    this.prune();
    if (Object.hasOwn(this.data.nonces, nonce)) return false;
    this.data.nonces[nonce] = until;
    this.flush();
    return true;
  }

  revokeSession(sessionId: string, until: number): void {
    this.data.revoked[sessionId] = until;
    this.flush();
  }

  revokeWalletBefore(wallet: string, at: number): void {
    this.data.before[wallet.toLowerCase()] = at;
    this.flush();
  }

  revoked(sessionId: string, wallet: string, issuedAt: number): boolean {
    if (Object.hasOwn(this.data.revoked, sessionId)) return true;
    const before = this.data.before[wallet.toLowerCase()];
    return before !== undefined && issuedAt <= before;
  }

  private prune(): void {
    const at = this.now();
    for (const table of [this.data.nonces, this.data.revoked])
      for (const [k, until] of Object.entries(table)) if (until < at) delete table[k];
  }

  private flush(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(this.data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

function parse(text: string): Shape {
  const raw = JSON.parse(text) as Partial<Shape>;
  return { nonces: raw.nonces ?? {}, revoked: raw.revoked ?? {}, before: raw.before ?? {} };
}

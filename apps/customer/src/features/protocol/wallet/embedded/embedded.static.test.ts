import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RC-dex-protocol-05's static test: the embedded module's network calls are enumerated, and none of them can carry key
 * material. The only calls are the export fact's status (an account) and its record (an account and a signature). The
 * module makes no direct fetch or XHR, writes nothing to the console, and keeps the key out of browser storage except
 * wrapped.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const panel = read('./EmbeddedKeysPanel.tsx');
const vault = read('./vault.ts');

describe('the embedded module never sends its key (RC-dex-protocol-05)', () => {
  it('calls the service only for the export fact, with an account and a signature', () => {
    expect([...panel.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]).sort()).toEqual([
      'embeddedMarkExported',
      'embeddedMarkExported',
      'embeddedStatus',
    ]);
    for (const call of panel.matchAll(/api\.embeddedMarkExported\(\{([^}]*)\}\)/g))
      expect(call[1]!.replace(/\s/g, '')).toMatch(/^account:[\w.]+,signature(:[\w.]+)?$/);
    expect(panel).toMatch(/api\.embeddedStatus\(record\.address\)/);
  });

  it('makes no other network call, logs nothing and stores the key only wrapped', () => {
    for (const source of [panel, vault]) {
      expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|console\./);
      expect(source).not.toMatch(/localStorage|sessionStorage/);
    }
    // The vault writes one record, whose only key-derived field is the AES-GCM ciphertext.
    const written = /const record: VaultRecord = \{([\s\S]*?)\};/.exec(vault)?.[1] ?? '';
    const fields = written
      .split(',')
      .map((part) => part.trim().split(':')[0]!.trim())
      .filter(Boolean);
    expect(fields).toEqual(['address', 'credentialId', 'salt', 'iv', 'wrapped', 'spent', 'createdAt']);
    expect(written).toContain('wrapped: b64(wrapped)');
    // Every other write starts from a kept record and adds only the export's flag and its signed message.
    const writes = [...vault.matchAll(/writeVault\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(writes.sort()).toEqual(['next', 'record', 'rest']);
    const next = /const next: VaultRecord = \{([\s\S]*?)\};/.exec(vault)?.[1] ?? '';
    expect(next.replace(/\s/g, '')).toBe(
      '...record,spent:true,...(exported?{exportSignature:exported.signature,exportChainId:exported.chainId}:{}),',
    );
    // The unwrapped key lives in one local variable, is never written, and the vault clears its own copy after wrapping.
    expect(vault).toMatch(/key = null;/);
  });
});

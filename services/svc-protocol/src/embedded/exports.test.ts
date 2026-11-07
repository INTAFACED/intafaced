import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { embeddedExportMessage } from '@intafaced/contracts/protocol-embedded';
import { embeddedStatus, markExported, MemoryEmbeddedExportStore } from './exports.js';

const CHAIN = 84532;

describe('embedded login key export, once (RC-dex-protocol-05)', () => {
  it('records the fact once, signed by the key itself; any device then reads it as spent', async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const store = new MemoryEmbeddedExportStore();
    expect(await embeddedStatus(store, CHAIN, key.address)).toMatchObject({ exported: false, exportedAt: null });
    const signature = await key.signMessage({ message: embeddedExportMessage(key.address, CHAIN) });
    const first = await markExported(store, { chainId: CHAIN, account: key.address, signature });
    expect(first.exported).toBe(true);
    // A repeat (a retry after a crash) keeps the first time.
    const again = await markExported(store, { chainId: CHAIN, account: key.address.toLowerCase(), signature });
    expect(again.exportedAt).toBe(first.exportedAt);
    expect(await embeddedStatus(store, CHAIN, key.address.toLowerCase())).toMatchObject({ exported: true, exportedAt: first.exportedAt });
  });

  it('refuses a mark that another key signed, or for another chain', async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const store = new MemoryEmbeddedExportStore();
    const wrong = await other.signMessage({ message: embeddedExportMessage(key.address, CHAIN) });
    await expect(markExported(store, { chainId: CHAIN, account: key.address, signature: wrong })).rejects.toMatchObject({
      code: 'wallet.export_not_owner',
    });
    const otherChain = await key.signMessage({ message: embeddedExportMessage(key.address, 1) });
    await expect(markExported(store, { chainId: CHAIN, account: key.address, signature: otherChain })).rejects.toMatchObject({
      code: 'wallet.export_not_owner',
    });
    expect(store.rows.size).toBe(0);
  });
});

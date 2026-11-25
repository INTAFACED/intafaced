import { describe, expect, it, vi } from 'vitest';
import type { ProtocolEmbeddedWalletProvider, ProtocolEmbeddedWalletRecord } from '@intafaced/contracts/protocol-embedded-wallet';
import { discoverWallets, type DiscoveredWallet } from '../../../shared/eip1193';
import { runSignRequest } from '../wallet/eip1193';
import { announcedWallet } from './EmbeddedWalletAnnouncer';
import { announce, embeddedProvider, EMBEDDED_WALLET_RDNS, type Announced } from './embedded-provider';
import type { ClientFailure, ClientResult, EmbeddedWalletClient } from './provider-client';

/** J-wallet-22: the person's embedded wallet as a browser wallet (EIP-1193), every signature the provider client's. */
const ADDRESS = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const OWNER = ADDRESS.toLowerCase();
const SIG = `0x${'ab'.repeat(65)}`;
const TYPED = {
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Order: [{ name: 'size', type: 'string' }] },
  primaryType: 'Order',
  domain: { chainId: 84532 },
  message: { size: '0.001' },
};

const fail = (failure: ClientFailure) => async () => ({ ok: false as const, failure });
function client(overrides: Partial<EmbeddedWalletClient> = {}): EmbeddedWalletClient {
  const signed = async (): Promise<ClientResult<{ signature: string; address: string }>> => ({
    ok: true,
    data: { signature: SIG, address: ADDRESS },
  });
  return {
    createPasskey: fail('unsupported'),
    signMessage: vi.fn(signed),
    signTypedData: vi.fn(signed),
    exportKey: fail('unsupported'),
    addRecoveryPasskey: fail('unsupported'),
    sendTransaction: vi.fn(async () => ({ ok: true as const, data: { hash: `0x${'cd'.repeat(32)}` } })),
    read: vi.fn(async (method: string) => (method === 'eth_chainId' ? '0x14a34' : method === 'eth_getTransactionCount' ? '0x0' : '0x2a')),
    ...overrides,
  };
}
const connected = (c: EmbeddedWalletClient, chainId?: number) =>
  embeddedProvider({ client: c, walletId: 'testw_1', address: ADDRESS, authorised: true, chainId });
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: number }) => e.code,
  );

describe('the embedded wallet as an EIP-1193 provider', () => {
  it('answers its address once connected; eth_accounts never prompts and is empty before', async () => {
    const onAuthorised = vi.fn();
    const p = embeddedProvider({ client: client(), walletId: 'testw_1', address: ADDRESS, onAuthorised });
    expect(await p.request({ method: 'eth_accounts' })).toEqual([]);
    expect(await p.request({ method: 'eth_requestAccounts' })).toEqual([OWNER]);
    expect(await p.request({ method: 'eth_accounts' })).toEqual([OWNER]);
    expect(onAuthorised).toHaveBeenCalledOnce();
  });

  it('starts on the app chain and switches to any chain the room names, saying so', async () => {
    const p = connected(client());
    expect(await p.request({ method: 'eth_chainId' })).toBe('0x14a34');
    const changed = vi.fn();
    p.on?.('chainChanged', changed);
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x66eee' }] });
    expect(await p.request({ method: 'eth_chainId' })).toBe('0x66eee');
    expect(changed).toHaveBeenCalledWith('0x66eee');
    expect(await code(p.request({ method: 'wallet_switchEthereumChain', params: [{}] }))).toBe(-32602);
  });

  it('signs typed data through the client, after its passkey, for its own address only', async () => {
    const c = client();
    const p = connected(c);
    expect(await p.request({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify(TYPED)] })).toBe(SIG);
    expect(c.signTypedData).toHaveBeenCalledWith('testw_1', TYPED);
    expect(await code(p.request({ method: 'eth_signTypedData_v4', params: [`0x${'11'.repeat(20)}`, JSON.stringify(TYPED)] }))).toBe(4100);
    const before = embeddedProvider({ client: c, walletId: 'testw_1', address: ADDRESS });
    expect(await code(before.request({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify(TYPED)] }))).toBe(4100);
    expect(c.signTypedData).toHaveBeenCalledOnce();
  });

  it('a passkey that does not pass is the person’s no (4001); each other failure is a typed error, and nothing is signed', async () => {
    const cases: Array<[ClientFailure, number]> = [
      ['passkey', 4001],
      ['refused', 4100],
      ['unsupported', 4200],
      ['down', 4900],
    ];
    for (const [failure, expected] of cases) {
      const p = connected(client({ signTypedData: fail(failure), signMessage: fail(failure) }));
      expect(await code(p.request({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify(TYPED)] }))).toBe(expected);
      expect(await code(p.request({ method: 'personal_sign', params: ['0x6869', OWNER] }))).toBe(expected);
    }
  });

  it('the desk’s own signing path reads a passkey failure as rejected, and a signature as signed', async () => {
    const rejected = connected(client({ signTypedData: fail('passkey') }));
    expect(await runSignRequest(rejected, OWNER, { kind: 'typedData', typedData: TYPED })).toEqual({ status: 'rejected' });
    expect(await runSignRequest(connected(client()), OWNER, { kind: 'typedData', typedData: TYPED })).toEqual({
      status: 'signed',
      signature: SIG,
    });
  });

  it('personal_sign signs the message as text through signMessage', async () => {
    const c = client();
    expect(await connected(c).request({ method: 'personal_sign', params: ['0x6869', OWNER] })).toBe(SIG);
    expect(c.signMessage).toHaveBeenCalledWith('testw_1', 'hi');
  });

  it('a signature from another address is never handed back', async () => {
    const other = async () => ({ ok: true as const, data: { signature: SIG, address: `0x${'22'.repeat(20)}` } });
    const p = connected(client({ signTypedData: other }));
    expect(await code(p.request({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify(TYPED)] }))).toBe(-32603);
  });

  it('reads through the provider’s own connection only on its chain', async () => {
    const c = client();
    const p = connected(c);
    expect(await p.request({ method: 'eth_getBalance', params: [OWNER, 'latest'] })).toBe('0x2a');
    expect(c.read).toHaveBeenCalledWith('eth_getBalance', [OWNER, 'latest']);
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x66eee' }] });
    expect(await code(p.request({ method: 'eth_getBalance', params: [OWNER, 'latest'] }))).toBe(4901);
    const silent = connected(client({ read: async () => null }));
    expect(await code(silent.request({ method: 'eth_call', params: [{ to: OWNER, data: '0x' }, 'latest'] }))).toBe(4900);
  });

  it('sends a transaction once at the wallet’s nonce; a chosen fee or a replacement is refused, nothing sent', async () => {
    const c = client();
    const p = connected(c);
    const tx = { from: OWNER, to: `0x${'33'.repeat(20)}`, data: '0x', value: '0x0' };
    expect(await p.request({ method: 'eth_sendTransaction', params: [tx] })).toBe(`0x${'cd'.repeat(32)}`);
    expect(c.sendTransaction).toHaveBeenCalledWith('testw_1', { chainId: 84532, to: tx.to, data: '0x', value: '0x0', nonce: 0 });
    expect(
      await code(p.request({ method: 'eth_sendTransaction', params: [{ ...tx, maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' }] })),
    ).toBe(4200);
    expect(await code(p.request({ method: 'eth_sendTransaction', params: [{ ...tx, nonce: '0x1' }] }))).toBe(4200);
    expect(c.sendTransaction).toHaveBeenCalledOnce();
  });

  it('refuses every other method with 4200', async () => {
    const p = connected(client());
    for (const method of ['eth_sign', 'eth_signTransaction', 'wallet_addEthereumChain', 'eth_getCode', 'eth_sendRawTransaction'])
      expect(await code(p.request({ method }))).toBe(4200);
  });
});

describe('announcing it (EIP-6963)', () => {
  const PROVIDER: ProtocolEmbeddedWalletProvider = {
    id: 'test',
    displayName: 'TEST wallet provider',
    test: true,
    capabilities: { export: true, recovery: true },
  };
  const WALLET: ProtocolEmbeddedWalletRecord = {
    address: ADDRESS,
    providerWalletId: 'testw_announce',
    provider: 'test',
    idempotencyKey: 'wallet:embedded:p1',
    createdAt: '2026-11-25T00:00:00.000Z',
    test: true,
    holdsKey: false,
  };

  it('answers a room’s request only when the person has a wallet record, under its own name', () => {
    const target = new EventTarget();
    let answer: Announced | null = null;
    // The announcer's answer to eip6963:requestProvider (EmbeddedWalletAnnouncer): the record decides whether there is one.
    const answering = (record: ProtocolEmbeddedWalletRecord | null) => {
      answer = record ? announcedWallet(PROVIDER, record, 'INTAFACED wallet (TEST)', () => client()) : null;
    };
    target.addEventListener('eip6963:requestProvider', () => {
      if (answer) announce(target, answer);
    });
    let seen: DiscoveredWallet[] = [];
    answering(null);
    const stop = discoverWallets(target, (w) => (seen = w));
    expect(seen).toEqual([]);
    stop();
    answering(WALLET);
    const again = discoverWallets(target, (w) => (seen = w));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.info).toMatchObject({ name: 'INTAFACED wallet (TEST)', rdns: EMBEDDED_WALLET_RDNS });
    expect(seen[0]?.info.icon).toMatch(/^data:image\/svg\+xml,/);
    again();
  });

  it('keeps one provider per wallet, so its chain and connection carry across rooms; no client, no announcement', () => {
    const first = announcedWallet(PROVIDER, { ...WALLET, providerWalletId: 'testw_keep' }, 'INTAFACED wallet (TEST)', () => client());
    const second = announcedWallet(PROVIDER, { ...WALLET, providerWalletId: 'testw_keep' }, 'INTAFACED wallet (TEST)', () => client());
    expect(second).toBe(first);
    expect(announcedWallet(PROVIDER, { ...WALLET, providerWalletId: 'testw_none' }, 'INTAFACED wallet (TEST)', () => null)).toBeNull();
  });
});

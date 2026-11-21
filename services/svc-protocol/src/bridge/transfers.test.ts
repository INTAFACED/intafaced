import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_AMOUNT_INVALID,
  BRIDGE_BURN_MISMATCH,
  BRIDGE_KEY_CONFLICT,
  BRIDGE_PROVIDER_UNSET,
  BRIDGE_ROUTE_UNKNOWN,
  BRIDGE_TOO_MANY_WAITING,
  BRIDGE_TRANSFER_NOT_FOUND,
  BRIDGE_UNREACHABLE,
  type BridgeTransferState,
} from '@intafaced/contracts/protocol-bridge';
import { TEST_BRIDGE_ROUTES } from './routes.js';
import {
  BRIDGE_TOKEN_ABI,
  MAX_WAITING_PER_WALLET,
  bridgeIntentId,
  burnSubmitted,
  listTransfers,
  startTransfer,
  type Attestation,
  type BridgeChain,
  type BridgeTransferRecord,
  type BridgeTransfersDeps,
  type BridgeTransferStore,
  type SentBurn,
} from './transfers.js';

const WALLET = getAddress('0x00000000000000000000000000000000000a11ce');
const OTHER = getAddress('0x0000000000000000000000000000000000000b0b');
const TOKEN = getAddress('0x000000000000000000000000000000000000b41d');
const ATTESTATION = `0x${'11'.repeat(65)}` as Hex;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const START = { wallet: WALLET, fromChainId: 84532, toChainId: 31337, asset: 'TUSDC', amount: '1.5', clientKey: 'bridge-key-0001' };

function memoryStore(): BridgeTransferStore & { rows: BridgeTransferRecord[] } {
  const rows: BridgeTransferRecord[] = [];
  let n = 0;
  return {
    rows,
    async insert(row) {
      const prior = rows.find((r) => r.wallet === row.wallet && r.key === row.key);
      if (prior) return { ...prior };
      const stored: BridgeTransferRecord = {
        ...row,
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        state: 'awaiting_burn',
        burnTx: null,
        attestation: null,
        createdAt: new Date(Date.UTC(2026, 10, 21, 12, n)),
      };
      rows.push(stored);
      return { ...stored };
    },
    findByKey: async (wallet, key) => rows.find((r) => r.wallet === wallet && r.key === key) ?? null,
    get: async (wallet, id) => {
      const r = rows.find((x) => x.wallet === wallet && x.id === id);
      return r ? { ...r } : null;
    },
    list: async (wallet) => rows.filter((r) => r.wallet === wallet).map((r) => ({ ...r })),
    countWaiting: async (wallet) => rows.filter((r) => r.wallet === wallet && r.state === 'awaiting_burn').length,
    async advance(id, from, next) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.state !== from) return false;
      Object.assign(r, next);
      return true;
    },
  };
}

/** Two TEST chains held in memory: burns and mints by intent, and the transactions the wallet sent. */
function world() {
  const burns = new Map<Hex, Hex>();
  const mints = new Set<Hex>();
  const txs = new Map<Hex, SentBurn>();
  let attestation: Attestation = { status: 'pending' };
  let down = false;
  const reachable = <T>(value: T) => (down ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(value));
  const chain: BridgeChain = {
    burned: async (_t, id) => reachable(burns.has(id)),
    minted: async (_t, id) => reachable(mints.has(id)),
    burnTx: async (_t, id) => reachable(burns.get(id) ?? null),
    transaction: async (h) => reachable(txs.get(h) ?? null),
  };
  const store = memoryStore();
  const deps: BridgeTransfersDeps = {
    routes: () => structuredClone(TEST_BRIDGE_ROUTES) as never,
    provider: () => ({
      tokens: { TUSDC: { address: TOKEN, decimals: 6 } },
      chain: (id) => (id === 84532 || id === 31337 ? chain : null),
      attestation: async () => reachable(attestation),
    }),
    store,
  };
  /** The wallet sends `data` to the token as `from`, mined with `status`; a successful burn is recorded by intent. */
  const send = (
    n: number,
    data: Hex,
    { from = WALLET as Address, status = 'success' as SentBurn['status'], to = TOKEN as Address } = {},
  ) => {
    txs.set(hash(n), { from, to, input: data, status });
    if (status === 'success') {
      const call = decodeFunctionData({ abi: BRIDGE_TOKEN_ABI, data });
      if (call.functionName === 'burn') burns.set(call.args[0], hash(n));
    }
    return hash(n);
  };
  return {
    deps,
    store,
    send,
    txs,
    mints,
    setAttestation: (a: Attestation) => (attestation = a),
    setDown: (d: boolean) => (down = d),
  };
}

const refusal = (code: string) => expect.objectContaining({ code });

describe('bridge transfers: start', () => {
  it('stores the intent before anything is signed and answers the burn to sign, with the intent id from the business key', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    expect(w.store.rows).toHaveLength(1);
    expect(t).toMatchObject({
      state: 'awaiting_burn',
      amount: '1.5',
      token: 'TUSDC',
      provider: 'TEST provider',
      burnTx: null,
      mintCall: null,
    });
    expect(t.from).toEqual({ chainId: 84532, name: 'TEST chain' });
    expect(t.to).toEqual({ chainId: 31337, name: 'TEST chain B' });
    expect(t.intentId).toBe(bridgeIntentId(WALLET, START.clientKey));
    expect(t.burnCall).toEqual({
      chainId: 84532,
      to: TOKEN,
      data: encodeFunctionData({ abi: BRIDGE_TOKEN_ABI, functionName: 'burn', args: [t.intentId as Hex, 31337n, WALLET, 1_500_000n] }),
    });
  });

  it('answers the same transfer for the same key, never a second row, and refuses the key with other terms', async () => {
    const w = world();
    const first = await startTransfer(w.deps, START);
    expect(await startTransfer(w.deps, START)).toEqual(first);
    expect(w.store.rows).toHaveLength(1);
    await expect(startTransfer(w.deps, { ...START, amount: '2' })).rejects.toEqual(refusal(BRIDGE_KEY_CONFLICT));
  });

  it('refuses with no provider, on an unlisted route or token, and a bad amount, storing nothing', async () => {
    const w = world();
    await expect(startTransfer({ ...w.deps, provider: () => null }, START)).rejects.toEqual(refusal(BRIDGE_PROVIDER_UNSET));
    await expect(startTransfer(w.deps, { ...START, toChainId: 1 })).rejects.toEqual(refusal(BRIDGE_ROUTE_UNKNOWN));
    await expect(startTransfer(w.deps, { ...START, fromChainId: 31337, toChainId: 84532 })).rejects.toEqual(refusal(BRIDGE_ROUTE_UNKNOWN));
    await expect(startTransfer(w.deps, { ...START, asset: 'USDC' })).rejects.toEqual(refusal(BRIDGE_ROUTE_UNKNOWN));
    for (const amount of ['0', '-1', '1.0000001', 'abc', '1e6'])
      await expect(startTransfer(w.deps, { ...START, amount })).rejects.toEqual(refusal(BRIDGE_AMOUNT_INVALID));
    expect(w.store.rows).toHaveLength(0);
  });

  it(`keeps at most ${MAX_WAITING_PER_WALLET} transfers waiting for their burn per wallet`, async () => {
    const w = world();
    for (let i = 0; i < MAX_WAITING_PER_WALLET; i++) await startTransfer(w.deps, { ...START, clientKey: `bridge-key-${i}000` });
    await expect(startTransfer(w.deps, { ...START, clientKey: 'bridge-key-over' })).rejects.toEqual(refusal(BRIDGE_TOO_MANY_WAITING));
    // Another wallet is not held back by this one.
    await expect(startTransfer(w.deps, { ...START, wallet: OTHER, clientKey: 'bridge-key-over' })).resolves.toMatchObject({
      state: 'awaiting_burn',
    });
  });
});

describe('bridge transfers: the burn, the attestation and the mint', () => {
  it('moves burn submitted, then mint ready when the attestation arrives, then minted once the mint is on chain', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    const burn = w.send(1, t.burnCall!.data as Hex);
    const submitted = await burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash: burn });
    expect(submitted).toMatchObject({ state: 'burn_submitted', burnTx: burn, burnCall: null, mintCall: null });

    // No attestation yet: still burn submitted.
    expect((await listTransfers(w.deps, { wallet: WALLET })).transfers[0]).toMatchObject({ state: 'burn_submitted' });

    w.setAttestation({ status: 'ready', attestation: ATTESTATION });
    const ready = (await listTransfers(w.deps, { wallet: WALLET })).transfers[0]!;
    expect(ready.state).toBe('mint_ready');
    expect(ready.mintCall).toEqual({
      chainId: 31337,
      to: TOKEN,
      data: encodeFunctionData({
        abi: BRIDGE_TOKEN_ABI,
        functionName: 'mint',
        args: [t.intentId as Hex, 84532n, WALLET, 1_500_000n, ATTESTATION],
      }),
    });

    w.mints.add(t.intentId as Hex);
    expect((await listTransfers(w.deps, { wallet: WALLET })).transfers[0]).toMatchObject({
      state: 'minted',
      mintCall: null,
      burnCall: null,
    });
  });

  it('resumes a stored intent whose burn is on chain though its hash never reached the service, and never offers a second burn', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    // The page (or the process) stopped right after the wallet sent the burn: burnSubmitted was never called.
    const burn = w.send(2, t.burnCall!.data as Hex);
    const [row] = (await listTransfers(w.deps, { wallet: WALLET })).transfers;
    expect(row).toMatchObject({ id: t.id, state: 'burn_submitted', burnTx: burn, burnCall: null });
    // Starting again with the same key is the same transfer, past its burn.
    expect(await startTransfer(w.deps, START)).toMatchObject({ id: t.id, state: 'burn_submitted', burnCall: null });
    expect(w.store.rows).toHaveLength(1);
  });

  it('offers the same burn again while none is on chain: the stored intent burns once whenever it is signed', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    const [row] = (await listTransfers(w.deps, { wallet: WALLET })).transfers;
    expect(row).toMatchObject({ id: t.id, state: 'awaiting_burn', burnCall: t.burnCall });
  });

  it("refuses a hash that is not this wallet's burn of this intent and amount, keeping the row waiting", async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    const other = await startTransfer(w.deps, { ...START, clientKey: 'bridge-key-0002' });
    const data = t.burnCall!.data as Hex;
    const cases: Hex[] = [
      hash(99), // unknown to the chain
      w.send(10, data, { status: 'pending', from: OTHER }), // another wallet
      w.send(11, data, { status: 'pending', to: OTHER }), // another contract
      w.send(12, other.burnCall!.data as Hex, { status: 'pending' }), // another intent
      w.send(13, encodeFunctionData({ abi: BRIDGE_TOKEN_ABI, functionName: 'burn', args: [t.intentId as Hex, 31337n, WALLET, 1n] }), {
        status: 'pending',
      }), // another amount
      w.send(14, data, { status: 'reverted' }), // reverted
    ];
    for (const txHash of cases)
      await expect(burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash })).rejects.toEqual(refusal(BRIDGE_BURN_MISMATCH));
    await expect(burnSubmitted(w.deps, { wallet: OTHER, id: t.id, txHash: hash(1) })).rejects.toEqual(refusal(BRIDGE_TRANSFER_NOT_FOUND));
    expect(w.store.rows.find((r) => r.id === t.id)!.state).toBe<BridgeTransferState>('awaiting_burn');
  });

  it('keeps a pending burn as submitted and answers the same hash twice; a second, different burn is refused', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    const pending = w.send(3, t.burnCall!.data as Hex, { status: 'pending' });
    await expect(burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash: pending })).resolves.toMatchObject({ state: 'burn_submitted' });
    await expect(burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash: pending })).resolves.toMatchObject({ burnTx: pending });
    await expect(burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash: hash(4) })).rejects.toEqual(refusal(BRIDGE_BURN_MISMATCH));
  });

  it('sends a submitted burn that then reverted back to waiting for its burn', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    const burn = w.send(5, t.burnCall!.data as Hex, { status: 'pending' });
    await burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash: burn });
    w.txs.set(burn, { ...w.txs.get(burn)!, status: 'reverted' });
    expect((await listTransfers(w.deps, { wallet: WALLET })).transfers[0]).toMatchObject({
      state: 'awaiting_burn',
      burnTx: null,
      burnCall: t.burnCall,
    });
  });

  it('leaves every row as stored when a chain or the attester cannot be read, and a submit then refuses as unreachable', async () => {
    const w = world();
    const t = await startTransfer(w.deps, START);
    const burn = w.send(6, t.burnCall!.data as Hex);
    await burnSubmitted(w.deps, { wallet: WALLET, id: t.id, txHash: burn });
    w.setAttestation({ status: 'ready', attestation: ATTESTATION });
    w.setDown(true);
    expect((await listTransfers(w.deps, { wallet: WALLET })).transfers[0]).toMatchObject({ state: 'burn_submitted' });
    const next = await startTransfer(w.deps, { ...START, clientKey: 'bridge-key-0003' });
    await expect(burnSubmitted(w.deps, { wallet: WALLET, id: next.id, txHash: hash(7) })).rejects.toEqual(refusal(BRIDGE_UNREACHABLE));
  });
});

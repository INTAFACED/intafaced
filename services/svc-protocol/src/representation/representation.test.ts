import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import {
  MemoryRepresentationStore,
  representationFromSetting,
  representationMessage,
  type RepresentationSetting,
} from './representation.js';

/**
 * D-developer-compliance-03: the representation a wallet signs once per version before its first signing action,
 * through the mounted router and signed out, as the Web3 rooms call it.
 */
const CHAIN_ID = 84532;
const WALLET = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const V1: RepresentationSetting = { version: 'TEST-1', text: 'TEST representation: I am not in a restricted region.' };
const V2: RepresentationSetting = { version: 'TEST-2', text: 'TEST representation, revised.' };
const edge = createEdgeContext({ secret: 'a-representation-test-edge-secret-length', serviceName: 'svc-protocol' });

function build(setting: () => RepresentationSetting | null, store = new MemoryRepresentationStore(() => new Date('2026-10-24T07:00:00Z'))) {
  const deps = {
    chain: { config: { chainId: CHAIN_ID } },
    registry: {},
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    representation: { store, setting },
  } as unknown as ProtocolRouterDeps;
  const caller = createProtocolRouter(deps).createCaller(edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-representation' }));
  return { caller: caller.representation, store };
}

const signFor = (account: typeof WALLET, setting: RepresentationSetting, address: Address = account.address) =>
  account.signMessage({ message: representationMessage({ setting, chainId: CHAIN_ID, address }) });

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string } }).cause?.code;
  }
}

describe('representation before signing', () => {
  it('blank text or version refuses compliance.representation_unset and stores nothing', async () => {
    expect(representationFromSetting('TEST-1', '  ', 'test')).toBeNull();
    expect(representationFromSetting('', 'text', 'test')).toBeNull();
    const { caller, store } = build(() => null);
    expect(await codeOf(caller.status({ address: WALLET.address }))).toBe('compliance.representation_unset');
    const signature = await signFor(WALLET, V1);
    expect(await codeOf(caller.accept({ address: WALLET.address, version: 'TEST-1', signature }))).toBe('compliance.representation_unset');
    expect(store.rows.size).toBe(0);
  });

  it('a TEST version boots only on an explicit dev or test APP_ENV; an owner version boots anywhere', () => {
    expect(representationFromSetting('TEST-1', 'text', 'dev')).toEqual({ version: 'TEST-1', text: 'text' });
    for (const appEnv of [undefined, '', 'prod', 'staging', 'DEV'])
      expect(() => representationFromSetting('TEST-1', 'text', appEnv)).toThrow(/Refusing to boot/);
    expect(representationFromSetting('2026-11', 'text', 'prod')).toEqual({ version: '2026-11', text: 'text' });
  });

  it('not accepted yet: status returns the text, version and the exact message to sign', async () => {
    const { caller } = build(() => V1);
    const status = await caller.status({ address: WALLET.address.toLowerCase() });
    expect(status).toMatchObject({ version: 'TEST-1', text: V1.text, accepted: false, acceptedAt: null });
    expect(status.message).toBe(representationMessage({ setting: V1, chainId: CHAIN_ID, address: WALLET.address }));
    expect(status.message).toContain(`address: ${WALLET.address}`);
    expect(status.message).toContain('chain:   84532');
  });

  it('accept stores version and time once; a repeat keeps the first time', async () => {
    let clock = new Date('2026-10-24T07:00:00Z');
    const store = new MemoryRepresentationStore(() => clock);
    const { caller } = build(() => V1, store);
    const signature = await signFor(WALLET, V1);
    const first = await caller.accept({ address: WALLET.address, version: 'TEST-1', signature });
    expect(first).toEqual({ address: WALLET.address, version: 'TEST-1', acceptedAt: '2026-10-24T07:00:00.000Z' });
    clock = new Date('2026-10-24T08:00:00Z');
    const again = await caller.accept({ address: WALLET.address, version: 'TEST-1', signature });
    expect(again.acceptedAt).toBe('2026-10-24T07:00:00.000Z');
    expect(store.rows.size).toBe(1);
    expect(await caller.status({ address: WALLET.address })).toMatchObject({ accepted: true, acceptedAt: '2026-10-24T07:00:00.000Z' });
  });

  it('a new version asks again; signing the old version is refused as stale', async () => {
    let setting = V1;
    const { caller } = build(() => setting);
    await caller.accept({ address: WALLET.address, version: 'TEST-1', signature: await signFor(WALLET, V1) });
    setting = V2;
    expect(await caller.status({ address: WALLET.address })).toMatchObject({ version: 'TEST-2', accepted: false });
    expect(await codeOf(caller.accept({ address: WALLET.address, version: 'TEST-1', signature: await signFor(WALLET, V1) }))).toBe(
      'compliance.representation_version_stale',
    );
    await caller.accept({ address: WALLET.address, version: 'TEST-2', signature: await signFor(WALLET, V2) });
    expect(await caller.status({ address: WALLET.address })).toMatchObject({ version: 'TEST-2', accepted: true });
  });

  it('nobody can record a consent for another address: a foreign or malformed signature is refused and stores nothing', async () => {
    const { caller, store } = build(() => V1);
    const foreign = await signFor(OTHER, V1, WALLET.address);
    expect(await codeOf(caller.accept({ address: WALLET.address, version: 'TEST-1', signature: foreign }))).toBe(
      'compliance.representation_signature_not_owner',
    );
    // The right key over a message for another chain does not count either.
    const otherChain = await WALLET.signMessage({ message: representationMessage({ setting: V1, chainId: 1, address: WALLET.address }) });
    expect(await codeOf(caller.accept({ address: WALLET.address, version: 'TEST-1', signature: otherChain }))).toBe(
      'compliance.representation_signature_not_owner',
    );
    // A signature of the right length that recovers to nothing is refused the same way; a wrong length never passes the schema.
    expect(await codeOf(caller.accept({ address: WALLET.address, version: 'TEST-1', signature: `0x${'00'.repeat(65)}` as Hex }))).toBe(
      'compliance.representation_signature_not_owner',
    );
    await expect(caller.accept({ address: WALLET.address, version: 'TEST-1', signature: '0x1234' as Hex })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(store.rows.size).toBe(0);
  });
});

import { memoryApprovalLinks } from './address-approval.js';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { LedgerClient } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { memoryWithdrawDestinations, type UserWithdrawDestinations } from '../withdraw-destination.js';
import { RampService } from './ramp-service.js';
import { memoryWithdrawNetworks, type WithdrawNetworkSource } from './withdraw-networks.js';
import { memoryWalletProofs, type WalletProofStore } from './wallet-ownership.js';
import { memorySecurityLock } from '../security-lock.js';
import { memoryTrustedDevices } from './trusted-devices.js';
import { memoryFraudList } from './fraud-list.js';
import { memorySanctions } from './sanctions-list.js';

/** Identity's answer for the second device of the device-approval test: approved by a mailed code. */
const PROVED_DEVICE = 'bbbbbbbb-1111-4111-8111-000000000002';
const devices = memoryTrustedDevices({ [PROVED_DEVICE]: { live: true, trustedBy: 'approval', newDeviceCheck: 'on' } });

/** W-withdraw-08 through the router: who may save, rename and remove, and what a list row shows. */

const SECRET = 'a-bank-address-book-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '0xabCDeF0123456789AbcdEf0123456789aBCDEF01';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

const registryRow = (id: string, networks: string[], allowedActions: Array<'deposit' | 'withdraw' | 'trade' | 'transfer'>) => ({
  id,
  kind: 'crypto' as const,
  precision: 6,
  networks: networks.map((networkId) => ({ networkId, label: `TEST ${networkId}` })),
  defaultNetworkId: networks[0] ?? null,
  allowedActions,
  state: 'active' as const,
  revision: 1,
  updatedAt: '2026-10-23T00:00:00.000Z',
});
const REGISTRY = memoryWithdrawNetworks([
  registryRow('USDT', ['erc20', 'base'], ['deposit', 'withdraw']),
  registryRow('BTC', ['bitcoin'], ['deposit']),
]);

function callerWith(
  scopes: string[],
  mfa = true,
  networks: WithdrawNetworkSource | null = REGISTRY,
  destinations: UserWithdrawDestinations = shared,
  walletProofs: WalletProofStore = sharedProofs,
  claims: { fam?: string; dev?: string } = {},
) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    ...claims,
    scopes,
    tier: 'full',
    mfa,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  const ramps = new RampService({} as Sql, {} as LedgerClient, {
    fraudList: memoryFraudList(),
    sanctions: memorySanctions(),
    securityLock: memorySecurityLock(),
    trustedDevices: devices,
    destinations,
    addressBookCap: '2',
    withdrawNetworks: networks,
    walletProofs,
    approvalLinks: memoryApprovalLinks(),
    walletProofWindowMinutes: '30',
    walletProofValidDays: '180',
  });
  return createBankRouter({ ramps } as unknown as BankServices).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-book',
    }),
  );
}

const shared = memoryWithdrawDestinations({ addressBookCap: () => '2' });
const sharedProofs = memoryWalletProofs();
const entry = { assetId: 'USDT', network: 'erc20', ref: ADDRESS, label: 'Cold wallet' } as const;

describe('bank.ramps.destinations: the address book', () => {
  it('refuses a plain session on save and remove, and saves nothing', async () => {
    const plain = callerWith(['bank:read', 'bank:write']);
    await expect(plain.ramps.destinations.save(entry)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      plain.ramps.destinations.remove({ destinationId: '33333333-3333-4333-8333-333333333333', idempotencyKey: 'rm-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await plain.ramps.destinations.list()).toEqual([]);
  });

  it('saves with the step-up scope, lists the row masked with its network and state, and renames with bank:write', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    const saved = await stepped.ramps.destinations.save({ ...entry, tag: '777' });
    expect(saved).toMatchObject({
      assetId: 'USDT',
      network: 'erc20',
      tag: '777',
      origin: 'customer',
      state: 'pending',
      refMasked: '0xabCD…EF01',
    });
    const listed = await callerWith(['bank:read']).ramps.destinations.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ destinationId: saved.destinationId, coolingBlocker: 'bank.offramp_cooling_unset' });
    const renamed = await callerWith(['bank:read', 'bank:write']).ramps.destinations.rename({
      destinationId: saved.destinationId,
      label: 'Vault',
    });
    expect(renamed.label).toBe('Vault');
  });

  it('saves a new address waiting for approval; approving by link needs the step-up scope, asking for a link does not (W-withdraw-09)', async () => {
    const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' });
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw'], true, REGISTRY, destinations);
    const saved = await stepped.ramps.destinations.save({ ...entry, label: 'Approve me' });
    expect(saved).toMatchObject({ state: 'pending', coolingOffEndsAt: null, approvedAt: null, approvalLinkExpiresAt: null });
    await expect(
      callerWith(['bank:read', 'bank:write']).ramps.destinations.approval.confirmLink({ token: 'A'.repeat(43) }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      callerWith(['bank:read', 'bank:write'], true, REGISTRY, destinations).ramps.destinations.approval.requestMail({
        destinationId: saved.destinationId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.address_approval_link_unset' } });
  });

  it('approves from another trusted device, read from the access token: the saving one is refused, and a plain session may not (W-withdraw-09)', async () => {
    const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' });
    const SIGN_IN_A = { fam: 'aaaaaaaa-0000-4000-8000-000000000001', dev: 'aaaaaaaa-1111-4111-8111-000000000001' };
    const SIGN_IN_B = { fam: 'bbbbbbbb-0000-4000-8000-000000000002', dev: PROVED_DEVICE };
    const stepped = (claims: { fam?: string; dev?: string }) =>
      callerWith(['bank:read', 'bank:write', 'trade:withdraw'], true, REGISTRY, destinations, sharedProofs, claims);
    const saved = await stepped(SIGN_IN_A).ramps.destinations.save({ ...entry, label: 'From A' });
    await expect(destinations.savedOn({ userId: USER, destinationId: saved.destinationId })).resolves.toEqual(SIGN_IN_A);
    await expect(stepped(SIGN_IN_A).ramps.destinations.approval.onDevice({ destinationId: saved.destinationId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.address_approval_same_device' },
    });
    // A token that names no sign-in cannot be told apart, so it refuses rather than approving.
    await expect(stepped({}).ramps.destinations.approval.onDevice({ destinationId: saved.destinationId })).rejects.toMatchObject({
      cause: { code: 'bank.address_approval_device_unknown' },
    });
    await expect(
      callerWith(['bank:read', 'bank:write'], true, REGISTRY, destinations, sharedProofs, SIGN_IN_B).ramps.destinations.approval.onDevice({
        destinationId: saved.destinationId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The device is never taken from the request.
    await expect(
      stepped(SIGN_IN_A).ramps.destinations.approval.onDevice({ destinationId: saved.destinationId, fam: SIGN_IN_B.fam } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const approved = await stepped(SIGN_IN_B).ramps.destinations.approval.onDevice({ destinationId: saved.destinationId });
    expect(approved).toMatchObject({ destinationId: saved.destinationId, state: 'cooling', approvedBy: 'device' });
    expect(approved.approvedAt).not.toBeNull();
  });

  it('names the typed refusals for a taken label and a full book', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    await expect(
      stepped.ramps.destinations.save({ ...entry, ref: '0x2222222222222222222222222222222222222222', label: 'vault' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('already have a saved address') });
    await stepped.ramps.destinations.save({ ...entry, ref: '0x3333333333333333333333333333333333333333', label: 'Second' });
    await expect(
      stepped.ramps.destinations.save({ ...entry, ref: '0x4444444444444444444444444444444444444444', label: 'Third' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('address book is full at 2 addresses') });
  });

  it('removes a saved address with the step-up scope', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    const [first] = await stepped.ramps.destinations.list();
    await expect(stepped.ramps.destinations.remove({ destinationId: first!.destinationId, idempotencyKey: 'rm-book-1' })).resolves.toEqual({
      destinationId: first!.destinationId,
      removed: true,
    });
    expect(await stepped.ramps.destinations.list()).toHaveLength(1);
  });

  it('lists the assets an address may be saved for, with their networks, from the registry', async () => {
    expect(await callerWith(['bank:read']).ramps.destinations.networks()).toEqual([
      {
        assetId: 'USDT',
        precision: 6,
        networks: [
          { networkId: 'erc20', label: 'TEST erc20' },
          { networkId: 'base', label: 'TEST base' },
        ],
        defaultNetworkId: 'erc20',
      },
    ]);
    expect(await callerWith(['bank:read'], true, memoryWithdrawNetworks([])).ramps.destinations.networks()).toEqual([]);
  });

  it('refuses a network the registry does not list for the asset, and an asset that cannot be withdrawn, saving nothing', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    const before = await stepped.ramps.destinations.list();
    await expect(stepped.ramps.destinations.save({ ...entry, network: 'tron', label: 'Tron' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('USDT is not sent on tron'),
    });
    await expect(stepped.ramps.destinations.save({ ...entry, assetId: 'BTC', network: 'bitcoin', label: 'Coins' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await stepped.ramps.destinations.list()).toEqual(before);
  });

  it('checks the registry on the entry as it is stored, so a lower-case asset or a capitalised network is the same entry', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    const saved = await stepped.ramps.destinations.save({
      ...entry,
      assetId: 'usdt',
      network: 'Base',
      ref: '0x5555555555555555555555555555555555555555',
      label: 'Cased',
    });
    expect(saved).toMatchObject({ assetId: 'USDT', network: 'base' });
    await stepped.ramps.destinations.remove({ destinationId: saved.destinationId, idempotencyKey: 'rm-cased' });
  });

  it('refuses to save while the registry cannot be read, and says so, rather than accepting any network', async () => {
    const down: WithdrawNetworkSource = {
      withdrawable: async () => {
        throw new Error('ledger timed out');
      },
    };
    for (const source of [down, null]) {
      const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw'], true, source);
      await expect(stepped.ramps.destinations.save({ ...entry, label: 'Later' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      await expect(stepped.ramps.destinations.networks()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
  });
});

describe('bank.ramps.destinations: a changed character and a look-alike address (W-withdraw-03)', () => {
  // The same start and end as ADDRESS as the book shows it (0xabCD…EF01), a different middle: the poisoning shape.
  const LOOKALIKE = `0xabcd${'0'.repeat(32)}ef01`;
  // ADDRESS with the case of one letter flipped: its checksum no longer matches.
  const TAMPERED = '0xAbCDeF0123456789AbcdEf0123456789aBCDEF01';
  const book = () => memoryWithdrawDestinations({ addressBookCap: () => '5' });

  it('checks an address before the confirmation: a mismatched checksum, not an address, and the saved entry it shows like', async () => {
    const destinations = book();
    const stepped = callerWith(['bank:read', 'trade:withdraw'], true, REGISTRY, destinations);
    const reader = callerWith(['bank:read'], true, REGISTRY, destinations);
    expect(await reader.ramps.destinations.check({ ref: ADDRESS })).toEqual({ address: 'ok', lookalike: null, fraudListed: false });
    const saved = await stepped.ramps.destinations.save(entry);
    expect(await reader.ramps.destinations.check({ ref: ADDRESS.toLowerCase() })).toEqual({
      address: 'ok',
      lookalike: null,
      fraudListed: false,
    });
    expect(await reader.ramps.destinations.check({ ref: TAMPERED })).toEqual({
      address: 'checksum_mismatch',
      lookalike: null,
      fraudListed: false,
    });
    expect(await reader.ramps.destinations.check({ ref: '0x1234' })).toEqual({ address: 'invalid', lookalike: null, fraudListed: false });
    expect(await reader.ramps.destinations.check({ ref: ` ${LOOKALIKE} ` })).toEqual({
      address: 'ok',
      lookalike: { destinationId: saved.destinationId, label: 'Cold wallet', refMasked: '0xabCD…EF01' },
      fraudListed: false,
    });
  });

  it('refuses to save a mismatched checksum, saving nothing', async () => {
    const destinations = book();
    const stepped = callerWith(['bank:read', 'trade:withdraw'], true, REGISTRY, destinations);
    await expect(stepped.ramps.destinations.save({ ...entry, ref: TAMPERED })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('do not match its checksum'),
    });
    expect(await stepped.ramps.destinations.list()).toEqual([]);
  });

  it('refuses a look-alike until the customer confirms they checked it, then saves it as its own entry', async () => {
    const destinations = book();
    const stepped = callerWith(['bank:read', 'trade:withdraw'], true, REGISTRY, destinations);
    await stepped.ramps.destinations.save(entry);
    for (const confirmLookalike of [undefined, false]) {
      await expect(
        stepped.ramps.destinations.save({
          ...entry,
          ref: LOOKALIKE,
          label: 'Look-alike',
          ...(confirmLookalike === undefined ? {} : { confirmLookalike }),
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('starts and ends like your saved address "Cold wallet"'),
      });
    }
    expect(await stepped.ramps.destinations.list()).toHaveLength(1);
    const confirmed = await stepped.ramps.destinations.save({ ...entry, ref: LOOKALIKE, label: 'Look-alike', confirmLookalike: true });
    // The confirmation is recorded on the new entry, not on the one it looks like.
    expect(confirmed).toMatchObject({ label: 'Look-alike', refMasked: '0xabcd…ef01', lookalikeConfirmedAt: expect.any(String) });
    const rows = await stepped.ramps.destinations.list();
    expect(rows.find((row) => row.label === 'Cold wallet')).toMatchObject({ lookalikeConfirmedAt: null });
    expect(await stepped.ramps.destinations.list()).toHaveLength(2);
    // Saved once after confirming, the same entry again is that entry, not a new warning.
    await expect(stepped.ramps.destinations.save({ ...entry, ref: LOOKALIKE, label: 'Look-alike' })).resolves.toMatchObject({
      destinationId: confirmed.destinationId,
    });
    expect(await callerWith(['bank:read'], true, REGISTRY, destinations).ramps.destinations.check({ ref: LOOKALIKE })).toEqual({
      address: 'ok',
      lookalike: null,
      fraudListed: false,
    });
  });

  it('records a look-alike confirmation only from its own check, never from what a caller passes in', async () => {
    const destinations = book();
    const ramps = new RampService({} as Sql, {} as LedgerClient, {
      fraudList: memoryFraudList(),
      sanctions: memorySanctions(),
      securityLock: memorySecurityLock(),
      destinations,
      addressBookCap: '5',
      withdrawNetworks: REGISTRY,
      walletProofs: memoryWalletProofs(),
      approvalLinks: memoryApprovalLinks(),
    });
    const plain = await ramps.saveDestination({
      userId: USER,
      ...entry,
      lookalikeOf: '33333333-3333-4333-8333-333333333333',
    });
    expect(plain.lookalikeConfirmedAt).toBeNull();
  });

  it('does not call the same address in another case, or saved again, a look-alike', async () => {
    const destinations = book();
    const stepped = callerWith(['bank:read', 'trade:withdraw'], true, REGISTRY, destinations);
    const first = await stepped.ramps.destinations.save(entry);
    expect(await stepped.ramps.destinations.save(entry)).toMatchObject({ destinationId: first.destinationId });
    await expect(
      stepped.ramps.destinations.save({ ...entry, network: 'base', ref: ADDRESS.toLowerCase(), label: 'On Base' }),
    ).resolves.toMatchObject({
      network: 'base',
    });
  });
});

describe('bank.ramps.destinations.ownership: prove a saved wallet (W-withdraw-17)', () => {
  // Well-known public development key (the first account of common local EVM chains). Holds nothing; TEST only.
  const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const sign = (message: string) => {
    const body = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
    const joined = new Uint8Array(prefix.length + body.length);
    joined.set(prefix);
    joined.set(body, prefix.length);
    const rec = secp256k1.sign(keccak_256(joined), Buffer.from(KEY, 'hex'), { prehash: false, format: 'recovered' });
    const out = new Uint8Array(65);
    out.set(rec.subarray(1), 0);
    out[64] = rec[0]! + 27;
    return `0x${Buffer.from(out).toString('hex')}`;
  };

  it('needs bank:write, lists the entry pending then verified, and refuses an unknown proof as not found', async () => {
    const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' });
    const proofs = memoryWalletProofs();
    const as = (scopes: string[]) => callerWith(scopes, true, REGISTRY, destinations, proofs);
    const saved = await as(['bank:read', 'trade:withdraw']).ramps.destinations.save({ ...entry, ref: WALLET, label: 'TEST private' });
    expect(saved.ownership).toEqual({ state: 'none', verifiedAt: null, validUntil: null, offerExpiresAt: null });

    await expect(as(['bank:read']).ramps.destinations.ownership.start({ destinationId: saved.destinationId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const writer = as(['bank:read', 'bank:write']);
    const started = await writer.ramps.destinations.ownership.start({ destinationId: saved.destinationId });
    expect((await writer.ramps.destinations.list())[0]!.ownership.state).toBe('pending');

    await expect(writer.ramps.destinations.ownership.verify({ proofId: started.proofId, signature: 'nope' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'bank.wallet_proof_signature_invalid' },
    });
    await expect(
      writer.ramps.destinations.ownership.verify({ proofId: '44444444-4444-4444-8444-444444444444', signature: sign(started.message) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const done = await writer.ramps.destinations.ownership.verify({ proofId: started.proofId, signature: sign(started.message) });
    expect(done).toMatchObject({ destinationId: saved.destinationId, state: 'verified' });
    const row = (await writer.ramps.destinations.list())[0]!;
    expect(row.ownership).toMatchObject({ state: 'verified', verifiedAt: done.verifiedAt, validUntil: done.validUntil });
    // A rename keeps the proof on the row it answers with.
    const renamed = await writer.ramps.destinations.rename({ destinationId: saved.destinationId, label: 'TEST renamed' });
    expect(renamed.ownership.state).toBe('verified');
  });

  it('refuses to start while the owner proof window is blank (PRECONDITION_FAILED)', async () => {
    const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' });
    const saved = await destinations.save({ userId: USER, ...entry, ref: WALLET, label: 'TEST private' });
    const ramps = new RampService({} as Sql, {} as LedgerClient, {
      fraudList: memoryFraudList(),
      sanctions: memorySanctions(),
      securityLock: memorySecurityLock(),
      destinations,
      withdrawNetworks: REGISTRY,
      walletProofs: memoryWalletProofs(),
      approvalLinks: memoryApprovalLinks(),
      walletProofWindowMinutes: '',
      walletProofValidDays: '180',
    });
    const raw = encodePrincipal({
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    const caller = createBankRouter({ ramps } as unknown as BankServices).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-proof',
      }),
    );
    await expect(caller.ramps.destinations.ownership.start({ destinationId: saved.destinationId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.wallet_proof_window_unset' },
    });
  });
});

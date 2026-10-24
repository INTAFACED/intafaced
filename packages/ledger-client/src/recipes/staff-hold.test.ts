import { describe, expect, it } from 'vitest';
import { userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { staffHoldAccount, staffHoldConfirmAccount, type StaffHoldReleaseCause } from './staff-hold.js';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const ASSET = 'USD';
const APPROVED: StaffHoldReleaseCause = { kind: 'approval', approvalId: 'appr-1' };

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function funded(amount = '100'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: CUSTOMER, assetId: ASSET, amount: amt(amount), rail: 'bank-sandbox', railRef: 'dep-1' }));
  return ledger;
}

const place = (amount = '40', holdNo: string | number = 7) =>
  recipes.staffHoldPlace({ holdNo, userId: CUSTOMER, assetId: ASSET, amount: amt(amount) });
const release = (amount: string, releaseNo: string | number, cause: StaffHoldReleaseCause = APPROVED) =>
  recipes.staffHoldRelease({ holdNo: 7, releaseNo, cause, userId: CUSTOMER, assetId: ASSET, amount: amt(amount) });
const confirm = (amount: string, attempt: string | number = 1, confirmAccount = 'seized-funds') =>
  recipes.staffHoldConfirm({
    holdNo: 7,
    attempt,
    approvalId: 'appr-2',
    confirmAccount,
    userId: CUSTOMER,
    assetId: ASSET,
    amount: amt(amount),
  });

const available = () => userAvailable(CUSTOMER, ASSET);
const held = () => staffHoldAccount(CUSTOMER, ASSET, 7);

describe('staff holds on funds (ops ENGINE LC-8, LC-9)', () => {
  it('a hold of 40.00 on 100.00 leaves 60.00 available and 100.00 in total, under ops:hold:<holdNo>', async () => {
    const ledger = await funded();
    const post = place();
    expect(post.idempotencyKey).toBe('ops:hold:7');
    expect(post.module).toBe('ops');
    expect(held().purpose).toBe('ops:hold:7');
    await ledger.post(post);
    expect(await bal(ledger, available())).toBe('60');
    expect(await bal(ledger, held())).toBe('40');
  });

  it('a retried place posts once', async () => {
    const ledger = await funded();
    await ledger.post(place());
    await ledger.post(place());
    expect(await bal(ledger, available())).toBe('60');
    expect(await bal(ledger, held())).toBe('40');
  });

  it('refuses a hold larger than available and moves nothing', async () => {
    const ledger = await funded();
    await expect(ledger.post(place('100.01'))).rejects.toThrow();
    expect(await bal(ledger, available())).toBe('100');
    expect(await bal(ledger, held())).toBe('0');
  });

  it('a partial release of 15.00 leaves 25.00 held; a retry reuses the stored release number and posts once', async () => {
    const ledger = await funded();
    await ledger.post(place());
    const post = release('15', 1);
    expect(post.idempotencyKey).toBe('ops:hold-release:7:1');
    expect(post.meta).toEqual({ holdNo: '7', releaseNo: '1', cause: 'approval', approvalId: 'appr-1' });
    await ledger.post(post);
    await ledger.post(release('15', 1));
    expect(await bal(ledger, available())).toBe('75');
    expect(await bal(ledger, held())).toBe('25');
  });

  it('the expiry worker releases without an approver and says so in the meta', () => {
    const post = release('40', 1, { kind: 'expiry' });
    expect(post.meta).toEqual({ holdNo: '7', releaseNo: '1', cause: 'expiry' });
  });

  it('confirm moves the remaining 25.00 once to the owner-named ops:hold-confirm account', async () => {
    const ledger = await funded();
    await ledger.post(place());
    await ledger.post(release('15', 1));
    const post = confirm('25');
    expect(post.idempotencyKey).toBe('ops:hold-confirm:7:1');
    expect(post.meta).toMatchObject({ approvalId: 'appr-2', confirmAccount: 'seized-funds' });
    await ledger.post(post);
    await ledger.post(post);
    const destination = staffHoldConfirmAccount('seized-funds', ASSET);
    expect(destination).toMatchObject({ ownerType: 'module', ownerId: 'ops:hold-confirm:seized-funds', kind: 'available' });
    expect(await bal(ledger, held())).toBe('0');
    expect(await bal(ledger, destination)).toBe('25');
    expect(await bal(ledger, available())).toBe('75');
  });

  it('releases plus confirms never exceed the placed amount: the empty hold refuses the loser', async () => {
    const ledger = await funded();
    await ledger.post(place());
    await ledger.post(confirm('40'));
    await expect(ledger.post(release('40', 1))).rejects.toThrow();
    await expect(ledger.post(confirm('0.01', 2))).rejects.toThrow();
    expect(await bal(ledger, held())).toBe('0');
    expect(await bal(ledger, available())).toBe('60');
  });

  it('a release larger than what is held is refused and moves nothing', async () => {
    const ledger = await funded();
    await ledger.post(place());
    await expect(ledger.post(release('40.01', 1))).rejects.toThrow();
    expect(await bal(ledger, held())).toBe('40');
  });

  it('refuses a non-positive amount on every leg', () => {
    expect(() => place('0')).toThrow(InvalidEntryError);
    expect(() => release('0', 1)).toThrow(InvalidEntryError);
    expect(() => confirm('0')).toThrow(InvalidEntryError);
  });

  it('numbers must come from a stored sequence: a positive integer, so no colon can reach a key', () => {
    for (const bad of ['', ' ', '0', '-1', '1.5', 'a:b', '07', 'x']) {
      expect(() => place('40', bad), `holdNo ${JSON.stringify(bad)}`).toThrow(InvalidEntryError);
      expect(() => release('1', bad), `releaseNo ${JSON.stringify(bad)}`).toThrow(InvalidEntryError);
      expect(() => confirm('1', bad), `attempt ${JSON.stringify(bad)}`).toThrow(InvalidEntryError);
    }
    expect(() => place('40', 1.5)).toThrow(InvalidEntryError);
    expect(place('40', 12).idempotencyKey).toBe('ops:hold:12');
  });

  it('a staff release names its approver; a release with no cause is refused', () => {
    expect(() => release('1', 1, { kind: 'approval', approvalId: ' ' })).toThrow(InvalidEntryError);
    expect(() =>
      recipes.staffHoldRelease({
        holdNo: 7,
        releaseNo: 1,
        cause: undefined as unknown as StaffHoldReleaseCause,
        userId: CUSTOMER,
        assetId: ASSET,
        amount: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
  });

  it('confirm needs the approver and only goes to an owner-named ops:hold-confirm slug', () => {
    expect(() =>
      recipes.staffHoldConfirm({
        holdNo: 7,
        attempt: 1,
        approvalId: '',
        confirmAccount: 'seized-funds',
        userId: CUSTOMER,
        assetId: ASSET,
        amount: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
    for (const bad of ['', 'Seized', 'fees:trade', 'a b', '-x', 'x'.repeat(64)]) {
      expect(() => confirm('1', 1, bad), `confirmAccount ${JSON.stringify(bad)}`).toThrow(InvalidEntryError);
    }
  });

  it('refuses a blank customer or asset', () => {
    expect(() => recipes.staffHoldPlace({ holdNo: 1, userId: ' ', assetId: ASSET, amount: amt('1') })).toThrow(InvalidEntryError);
    expect(() => recipes.staffHoldPlace({ holdNo: 1, userId: CUSTOMER, assetId: '', amount: amt('1') })).toThrow(InvalidEntryError);
  });
});

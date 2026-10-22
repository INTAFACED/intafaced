import { describe, expect, it } from 'vitest';
import {
  ASSET_AMOUNT_EXCEEDS_PRECISION,
  ASSET_DEFAULT_NETWORK_NOT_LISTED,
  ASSET_EDIT_INVALID,
  ASSET_EDIT_NOT_PENDING,
  ASSET_EDIT_SAME_APPROVER,
  ASSET_PRECISION_INVALID,
  ASSET_PRECISION_UNSET,
  assetAllows,
  assetsListInputSchema,
  assetsListOutputSchema,
  checkAssetEditApproval,
  parseAssetEdit,
  registryAssetSchema,
  toAssetUnits,
} from './asset-registry.js';

/** TEST data only: no figure here is an owner setting. */
const edit = {
  id: 'TESTCOIN',
  kind: 'crypto',
  precision: 8,
  networks: [
    { networkId: 'test-net-a', label: 'TEST network A' },
    { networkId: 'test-net-b', label: 'TEST network B' },
  ],
  defaultNetworkId: 'test-net-a',
  allowedActions: ['deposit', 'withdraw', 'trade'],
  state: 'active',
  reason: 'TEST listing',
};

describe('parseAssetEdit', () => {
  it('accepts a complete edit', () => {
    const r = parseAssetEdit(edit);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['blank string', ''],
    ['whitespace string', '  '],
  ])('refuses a %s precision as unset, never defaulted', (_label, precision) => {
    const input: Record<string, unknown> = { ...edit, precision };
    if (precision === undefined) delete input.precision;
    const r = parseAssetEdit(input);
    expect(r).toMatchObject({ ok: false, code: ASSET_PRECISION_UNSET });
  });

  it.each([[-1], [19], [2.5], ['8']])('refuses an out-of-range or non-integer precision %s', (precision) => {
    expect(parseAssetEdit({ ...edit, precision })).toMatchObject({ ok: false, code: ASSET_PRECISION_INVALID });
  });

  it('refuses a default network that is not one of the networks', () => {
    expect(parseAssetEdit({ ...edit, defaultNetworkId: 'test-net-z' })).toMatchObject({
      ok: false,
      code: ASSET_DEFAULT_NETWORK_NOT_LISTED,
    });
  });

  it('refuses duplicate networks, duplicate actions, a blank reason and unknown fields', () => {
    const dupNet = { ...edit, networks: [edit.networks[0], edit.networks[0]] };
    expect(parseAssetEdit(dupNet)).toMatchObject({ ok: false, code: ASSET_EDIT_INVALID });
    expect(parseAssetEdit({ ...edit, allowedActions: ['trade', 'trade'] })).toMatchObject({ ok: false, code: ASSET_EDIT_INVALID });
    expect(parseAssetEdit({ ...edit, reason: '  ' })).toMatchObject({ ok: false, code: ASSET_EDIT_INVALID });
    expect(parseAssetEdit({ ...edit, scale: 8 })).toMatchObject({ ok: false, code: ASSET_EDIT_INVALID });
    expect(parseAssetEdit('TESTCOIN')).toMatchObject({ ok: false, code: ASSET_EDIT_INVALID });
  });

  it('allows an asset with no network and no default', () => {
    expect(parseAssetEdit({ ...edit, kind: 'fiat', networks: [], defaultNetworkId: null }).ok).toBe(true);
  });
});

describe('checkAssetEditApproval (four-eyes)', () => {
  it('waits for a second operator: the proposer cannot approve their own edit', () => {
    expect(checkAssetEditApproval({ proposedBy: 'op-1', status: 'pending_approval' }, 'op-1')).toMatchObject({
      ok: false,
      code: ASSET_EDIT_SAME_APPROVER,
    });
  });

  it('accepts a different operator on a pending edit', () => {
    expect(checkAssetEditApproval({ proposedBy: 'op-1', status: 'pending_approval' }, 'op-2')).toEqual({ ok: true, value: true });
  });

  it.each([['applied'], ['rejected']] as const)('refuses to decide a proposal that is already %s', (status) => {
    expect(checkAssetEditApproval({ proposedBy: 'op-1', status }, 'op-2')).toMatchObject({ ok: false, code: ASSET_EDIT_NOT_PENDING });
  });
});

describe('registry rows', () => {
  const row = { ...edit, reason: undefined, updatedAt: '2026-10-22T00:00:00.000Z' };
  delete (row as Record<string, unknown>).reason;

  it('keeps a retired asset listed with its state, and it allows nothing new', () => {
    const retired = registryAssetSchema.parse({ ...row, state: 'retired' });
    const out = assetsListOutputSchema.parse({ assets: [retired] });
    expect(out.assets[0]?.state).toBe('retired');
    expect(assetAllows(retired, 'deposit')).toBe(false);
  });

  it('allows only listed actions on an active asset; halted allows none', () => {
    const active = registryAssetSchema.parse(row);
    expect(assetAllows(active, 'withdraw')).toBe(true);
    expect(assetAllows(active, 'transfer')).toBe(false);
    expect(assetAllows({ ...active, state: 'halted' }, 'withdraw')).toBe(false);
  });

  it('refuses a row whose precision is missing', () => {
    const { precision: _p, ...noPrecision } = row;
    expect(registryAssetSchema.safeParse(noPrecision).success).toBe(false);
  });

  it('list filters are optional and strict', () => {
    expect(assetsListInputSchema.parse({})).toEqual({});
    expect(assetsListInputSchema.safeParse({ state: 'gone' }).success).toBe(false);
  });
});

describe('toAssetUnits', () => {
  it('scales a decimal string to the asset precision as bigint', () => {
    expect(toAssetUnits('1.5', 8)).toEqual({ ok: true, value: 150000000n });
    expect(toAssetUnits('12', 0)).toEqual({ ok: true, value: 12n });
    expect(toAssetUnits('0.10', 1)).toEqual({ ok: true, value: 1n });
    expect(toAssetUnits('123456789012345678901234567890.123456789012345678', 18)).toEqual({
      ok: true,
      value: 123456789012345678901234567890123456789012345678n,
    });
  });

  it('refuses more places than the asset has instead of rounding', () => {
    expect(toAssetUnits('1.005', 2)).toMatchObject({ ok: false, code: ASSET_AMOUNT_EXCEEDS_PRECISION });
  });

  it('refuses a malformed amount and an out-of-range precision', () => {
    for (const bad of ['-1', '1e3', '', '01', '1.']) {
      expect(toAssetUnits(bad, 8)).toMatchObject({ ok: false, code: ASSET_EDIT_INVALID });
    }
    expect(toAssetUnits('1', 19)).toMatchObject({ ok: false, code: ASSET_PRECISION_INVALID });
  });
});

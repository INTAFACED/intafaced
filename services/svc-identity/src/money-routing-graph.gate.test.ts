import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D26-P1-I1 / D-S-11 — structural seal for the identity money-routing graph.
 *
 * Product-complete is ownership + cross-leak ban + trade ownership consult.
 * These gates keep the data model from growing a KYC/sanctions bypass column
 * and keep the door/recipe surfaces wired so a future edit cannot quietly
 * drop them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');
const monorepo = join(serviceRoot, '../..');

const BANNED_SUB_ACCOUNT_COLUMNS = [
  'tier',
  'kyc_tier',
  'jurisdiction',
  'region',
  'sanctions',
  'compliance_status',
  'balance',
  'available',
  'hold',
];

describe('money-routing graph gate (D26-P1-I1)', () => {
  it('sub_accounts schema has no tier/jurisdiction/balance columns (SPEC-SUBACCOUNTS §0 / §5)', () => {
    const schema = readFileSync(join(serviceRoot, 'src/db/schema.ts'), 'utf8');
    const start = schema.indexOf('export const subAccounts');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = schema.slice(start).toLowerCase();
    for (const col of BANNED_SUB_ACCOUNT_COLUMNS) {
      expect(block, `sub_accounts must not define ${col}`).not.toMatch(new RegExp(`['"\`]${col}['"\`]|\\b${col}:`));
    }
    // Bookkeeping columns that must remain.
    expect(block).toMatch(/parentuserid|parent_user_id/);
    expect(block).toMatch(/\brevoked\b/);
  });

  it('init + revoke migrations never add tier/jurisdiction columns to sub_accounts', () => {
    const init = readFileSync(join(serviceRoot, 'drizzle/0000_identity_init.sql'), 'utf8').toLowerCase();
    const revoke = readFileSync(join(serviceRoot, 'drizzle/0002_sub_accounts_revoke.sql'), 'utf8').toLowerCase();
    const subInit = init.slice(init.indexOf('create table if not exists "identity"."sub_accounts"'));
    // Column definitions only — comments may say "balances" without adding a column.
    expect(subInit).toMatch(/"parent_user_id"/);
    expect(subInit).not.toMatch(/"tier"/);
    expect(subInit).not.toMatch(/"jurisdiction"/);
    expect(subInit).not.toMatch(/"balance"/);
    expect(revoke).not.toMatch(/add column[^;]*tier/i);
    expect(revoke).not.toMatch(/add column[^;]*jurisdiction/i);
    expect(revoke).toMatch(/"revoked"/);
  });

  it('AuthService exposes ownership + transfer doors and the live-partition cap', () => {
    const src = readFileSync(join(serviceRoot, 'src/auth/auth-service.ts'), 'utf8');
    expect(src).toMatch(/async assertSubAccountOwned\(/);
    expect(src).toMatch(/async assertSubAccountTransferDoor\(/);
    expect(src).toMatch(/auth\.sub_account_limit/);
    expect(src).toMatch(/DEFAULT_MAX_SUB_ACCOUNTS/);
    // Transfer door must compose the single-row door — no drifted second check.
    expect(src).toMatch(/assertSubAccountOwned\(userId, fromId\)/);
    expect(src).toMatch(/assertSubAccountOwned\(userId, toId\)/);
  });

  it('tRPC mounts assertOwned + assertTransferDoor under subAccounts', () => {
    const src = readFileSync(join(serviceRoot, 'src/router.ts'), 'utf8');
    expect(src).toMatch(/assertOwned:\s*scopedProcedure/);
    expect(src).toMatch(/assertTransferDoor:\s*scopedProcedure/);
    expect(src).toMatch(/assertSubAccountOwned/);
    expect(src).toMatch(/assertSubAccountTransferDoor/);
  });

  it('S2S ownership snapshot stays mounted for svc-trade placeOrder gate', () => {
    const src = readFileSync(join(serviceRoot, 'src/index.ts'), 'utf8');
    expect(src).toMatch(/\/internal\/sub-accounts\/:subAccountId/);
    expect(src).toMatch(/getSubAccountOwnership/);
  });

  it('S2S API key ownership snapshot stays mounted for the place gate', () => {
    const src = readFileSync(join(serviceRoot, 'src/index.ts'), 'utf8');
    expect(src).toMatch(/\/internal\/api-keys\/:keyId/);
    expect(src).toMatch(/getApiKeyOwnership/);
  });

  it('S2S session ownership snapshot stays mounted for the place gate', () => {
    const src = readFileSync(join(serviceRoot, 'src/index.ts'), 'utf8');
    expect(src).toMatch(/\/internal\/sessions\/:sessionId/);
    expect(src).toMatch(/getSessionOwnership/);
  });

  it('ledger transfer recipe remains the only identity.sub_account.transfer journal shape', () => {
    const recipe = readFileSync(join(monorepo, 'packages/ledger-client/src/recipes/sub-accounts.ts'), 'utf8');
    expect(recipe).toMatch(/identity\.sub_account\.transfer/);
    // Both legs go through subAccountAvailable — never a user/house helper.
    expect(recipe).toMatch(/subAccountAvailable\(input\.fromSubAccountId/);
    expect(recipe).toMatch(/subAccountAvailable\(input\.toSubAccountId/);
    expect(recipe).not.toMatch(/\buserAvailable\s*\(/);
    expect(recipe).not.toMatch(/\bhouseFees\s*\(/);
    expect(recipe).not.toMatch(/\buserHold\s*\(/);
  });

  it('svc-trade placeOrder still consults identity ownership before storing the label', () => {
    const trade = readFileSync(join(monorepo, 'services/svc-trade/src/spot/trade-service.ts'), 'utf8');
    const ownership = readFileSync(join(monorepo, 'services/svc-trade/src/spot/sub-account-ownership.ts'), 'utf8');
    expect(ownership).toMatch(/assertSubAccountOwned/);
    expect(ownership).toMatch(/\/internal\/sub-accounts\//);
    expect(trade).toMatch(/assertSubAccountOwned\(this\.subAccounts/);
  });
});

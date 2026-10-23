/**
 * The currencies on an account (BK-acct-01): add one, remove one, list them.
 *
 * A currency on an account is its primary space, the label over the customer's `userAvailable` ledger account for that
 * asset. Adding one makes that label (once: the primary index allows one per customer and asset) and removing one hides
 * it. Neither writes to the ledger and neither moves value.
 *
 * Which assets may be added is the owner's list (`BANK_ACCOUNT_CURRENCIES`). A blank list refuses an add with
 * `bank.account_currencies_unset`, and the list read says so instead of inventing one. Removing needs no list.
 *
 * A currency is in use, and removing it refuses `bank.currency_in_use`, while any of the customer's ledger accounts in
 * that asset is not zero (the available balance, a hold, money reserved for an open order or an earn position) or a
 * named space uses the asset. The customer is offered Send and Convert to empty it first.
 */
import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { accountKey, formatAmount, userAvailable } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { SpaceService } from '../spaces/space-service.js';

const ASSET = /^[A-Z0-9]{2,16}$/;

export interface CurrenciesOptions {
  /** Owner-published, comma separated asset ids. Blank or unset refuses an add. */
  readonly currencies?: string | undefined;
}

export interface AccountCurrency {
  readonly assetId: string;
  /** The primary space that is this currency on the account. */
  readonly spaceId: string;
  /** The main balance in it, straight from the ledger. */
  readonly balance: string;
}

export interface CurrencySet {
  readonly currencies: AccountCurrency[];
  /** What the owner lets the customer add and they do not hold yet, or null with the reason when there is no list. */
  readonly addable: string[] | null;
  readonly addableBlocker: 'bank.account_currencies_unset' | null;
}

const unset = () =>
  new BankError('The owner has not published which currencies an account can hold, so none can be added', 'bank.account_currencies_unset');

export class CurrencyService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'balance' | 'balances'>,
    private readonly spaces: SpaceService,
    private readonly options: CurrenciesOptions = {},
  ) {}

  /** The owner's list, in the order given, without repeats. Blank, unreadable or empty refuses. */
  allowed(): string[] {
    const raw = this.options.currencies?.trim() ?? '';
    const ids = raw === '' ? [] : [...new Set(raw.split(',').map((c) => c.trim().toUpperCase()))];
    if (ids.length === 0 || ids.some((id) => !ASSET.test(id))) throw unset();
    return ids;
  }

  async list(userId: string): Promise<CurrencySet> {
    // Money that arrived in an asset with no label, or in one the customer removed, shows as a currency again first.
    await this.spaces.ensureHeldPrimaries(userId);
    const rows = await this.sql<Array<{ id: string; asset_id: string }>>`
      SELECT id, asset_id FROM bank.spaces
       WHERE user_id = ${userId} AND kind = 'primary' AND archived_at IS NULL AND removed_at IS NULL
       ORDER BY asset_id ASC
    `;
    // One ledger read for every main balance: a primary space is the customer's `userAvailable` account in its asset.
    const main = new Map<string, bigint>();
    for (const b of await this.ledger.balances('user', userId)) {
      if (accountKey(b.account) === accountKey(userAvailable(userId, b.account.assetId))) main.set(b.account.assetId, b.amount);
    }
    const currencies: AccountCurrency[] = rows.map((row) => ({
      assetId: row.asset_id,
      spaceId: row.id,
      balance: formatAmount(main.get(row.asset_id) ?? 0n),
    }));
    let allowed: string[];
    try {
      allowed = this.allowed();
    } catch (err) {
      if (err instanceof BankError && err.code === 'bank.account_currencies_unset') {
        return { currencies, addable: null, addableBlocker: 'bank.account_currencies_unset' };
      }
      throw err;
    }
    const held = new Set(currencies.map((c) => c.assetId));
    return { currencies, addable: allowed.filter((id) => !held.has(id)), addableBlocker: null };
  }

  /** Put a currency on the account. Adding one that is already there is the same answer, and one space. */
  async add(userId: string, assetId: string): Promise<AccountCurrency> {
    const id = assetId.trim().toUpperCase();
    if (!this.allowed().includes(id)) throw new BankError(`${id} is not a currency an account can hold`, 'bank.asset_unknown');
    const space = await this.spaces.ensurePrimary(userId, id);
    await this.spaces.restoreCurrency(userId, id);
    return { assetId: id, spaceId: space.id, balance: formatAmount(await this.spaces.balanceOf(space)) };
  }

  /**
   * Take a currency off the account. Refuses `bank.currency_in_use` while it holds anything (see the file comment).
   * Removing one that is not on the account is the same answer as removing it again.
   */
  async remove(userId: string, assetId: string): Promise<{ assetId: string; removed: true }> {
    const id = assetId.trim().toUpperCase();
    if (!ASSET.test(id)) throw new BankError(`${id} is not a currency an account can hold`, 'bank.asset_unknown');
    // Under the customer's space lock, so a space created in this currency at the same moment either lands first and
    // refuses this, or lands after and puts the currency back. Money that arrives after the check is not lost: the
    // next read of the account shows a funded currency again (`ensureHeldPrimaries`).
    return this.spaces.underSpaceLock(userId, async (tx) => {
      const accounts = (await this.ledger.balances('user', userId)).filter((b) => b.account.assetId === id && b.amount !== 0n);
      if (accounts.length > 0) throw inUse(id);
      const named = await tx<Array<{ id: string; archived: boolean }>>`
        SELECT id, archived_at IS NOT NULL AS archived FROM bank.spaces WHERE user_id = ${userId} AND asset_id = ${id} AND kind = 'named'
      `;
      for (const space of named) {
        if (!space.archived) throw inUse(id);
        if ((await this.spaces.balanceOf({ id: space.id, userId, assetId: id, kind: 'named' })) !== 0n) throw inUse(id);
      }
      await tx`
        UPDATE bank.spaces SET removed_at = now(), updated_at = now()
         WHERE user_id = ${userId} AND asset_id = ${id} AND kind = 'primary' AND removed_at IS NULL
      `;
      return { assetId: id, removed: true as const };
    });
  }
}

function inUse(assetId: string): BankError {
  return new BankError(
    `${assetId} still holds money, a hold, an open order or a space. Send or convert it first, then remove it`,
    'bank.currency_in_use',
  );
}

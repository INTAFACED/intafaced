import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { PartnerAccountRef, PartnerBank, PartnerCustody } from '../partner/partner-bank.js';
import { recoverPersonalSignAddress } from '../ramps/wallet-ownership.js';

/**
 * MOVES BETWEEN A PERSON'S OWN SPENDING AND TRADING ACCOUNTS (J-derivatives-25 #2 #3, BK-ownmove-01).
 *
 * The spending money is the partner bank's (OWNER 226), the trading money the venue's; INTAFACED holds neither. A move in
 * is two legs, each sent once under its own key:
 *
 *   1. The partner bank's transfer out of the person's main balance to the person's own wallet, on chain. svc-bank asks
 *      the partner to move it from the main balance (`bank.transfer.own-move:<moveId>:1`) and to send that amount to the
 *      wallet (the same key): the partner deduplicates both, so a retry after a crash anywhere sends nothing more.
 *   2. The wallet's own signed deposit to the venue account. Only the person's wallet sends it; svc-bank records its
 *      transfer once it is signed (`recordDeposit`), so the room can show the move whole and never asks the wallet twice.
 *
 * Before anything is kept or sent: the amount is above zero, the wallet signed this move's own message (`ownMoveMessage`),
 * the owner's destination sanctions list clears the wallet, and the amount is at most what the partner reports in the
 * main balance (`bank.own_move_above_free`, naming the partner's figure). Asking again with the same id and the same terms
 * is the same move, answered as it stands (and finished if it was cut off); other terms are `bank.own_move_conflict`.
 *
 * If this crashes after the row is kept and before the partner moved, the move reads `opening`, and asking again sends it
 * under the same key. After the partner moved and before its transfer was recorded, asking again gets the partner's
 * first answer for both. Nothing is stranded: the partner moved the money once or not at all. The ledger posts nothing.
 */

/** The partner's own account a move to a wallet leaves the main balance into, before it sends it on chain. */
export const PARTNER_CHAIN_OUT_OWNER = 'partner:chain-out';
export function partnerChainOutAccount(assetId: string): PartnerAccountRef {
  return { userId: PARTNER_CHAIN_OUT_OWNER, assetId, spaceId: null };
}

/** The partner's send of a move to the person's wallet on chain, once per key; the transfer's hash back. */
export type OwnMoveDelivery = (input: { key: string; to: string; assetId: string; amount: string }) => Promise<string>;

export interface OwnMove {
  readonly id: string;
  readonly direction: 'in';
  readonly assetId: string;
  readonly amount: Amount;
  readonly wallet: string;
  readonly status: 'opening' | 'sent';
  readonly partnerRef: string | null;
  readonly deliveryTx: string | null;
  readonly depositTx: string | null;
  readonly createdAt: Date;
  readonly sentAt: Date | null;
  readonly depositAt: Date | null;
  /** Whose figures the partner leg is: the partner's label (TEST on the TEST partner). */
  readonly partner: string;
  /** The partner's fee for its leg as it reports it, or null: "not known", never 0. */
  readonly partnerFee: Amount | null;
}

interface Row {
  id: string;
  user_id: string;
  direction: 'in';
  asset_id: string;
  amount: string;
  wallet: string;
  status: 'opening' | 'sent';
  partner_ref: string | null;
  delivery_tx: string | null;
  deposit_tx: string | null;
  created_at: Date;
  sent_at: Date | null;
  deposit_at: Date | null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;

/** The business key both of the partner's instructions for one move go under. */
export function ownMoveKey(moveId: string): string {
  return `bank.transfer.own-move:${moveId.toLowerCase()}:1`;
}

/** What the wallet signs to prove it is the person's and to name the one move it is for. */
export function ownMoveMessage(input: { moveId: string; wallet: string; assetId: string; amount: string }): string {
  return [
    'INTAFACED move to your trading account',
    `Move: ${input.moveId.toLowerCase()}`,
    `Wallet: ${input.wallet.toLowerCase()}`,
    `Amount: ${input.amount} ${input.assetId}`,
    'Signing this proves you control this wallet, so your partner bank can send this amount to it. It moves no funds and approves nothing else.',
  ].join('\n');
}

export interface OwnMoveServiceOptions {
  readonly custody: PartnerCustody;
  /** The partner's send to a wallet. Unset: every move in refuses `bank.own_move_rail_unset`, and nothing is kept. */
  readonly deliver: OwnMoveDelivery | null;
  /** The owner's destination sanctions list; throws its own refusal for a listed address, or any while unset. */
  readonly screenWallet: (address: string) => void;
  /** The partner's fee for its leg, or null when it does not say. */
  readonly partnerFee: (userId: string) => Amount | null;
}

export class OwnMoveService {
  constructor(
    private readonly sql: Sql,
    private readonly options: OwnMoveServiceOptions,
  ) {}

  /** Move from spending into trading: the partner's send to the person's own wallet, under the move's own key. */
  async toWallet(
    userId: string,
    input: { moveId: string; assetId: string; amount: string; wallet: string; walletSignature: string },
  ): Promise<OwnMove> {
    const amount = parseAmount(input.amount);
    if (amount <= 0n) throw new BankError('The amount to move must be above zero. Nothing was sent.', 'bank.validation_failed');
    const moveId = input.moveId.toLowerCase();
    const wallet = input.wallet.trim().toLowerCase();
    const assetId = input.assetId;
    if (!ADDRESS.test(wallet)) throw new BankError('The wallet must be an EVM address. Nothing was sent.', 'bank.validation_failed');
    const signer = recoverPersonalSignAddress(
      ownMoveMessage({ moveId, wallet, assetId, amount: formatAmount(amount) }),
      input.walletSignature,
    );
    if (signer !== wallet) {
      throw new BankError(
        'The wallet to send to must sign this move to prove it is yours. Nothing was sent or kept.',
        'bank.wallet_delivery_unproven',
      );
    }
    this.options.screenWallet(wallet);
    const bank = this.partnerBank(userId);
    const deliver = this.options.deliver;
    if (!deliver) {
      throw new BankError(
        'Your partner bank has no way to send to a wallet connected here, so nothing can move to your trading account. Nothing was sent.',
        'bank.own_move_rail_unset',
      );
    }

    const prior = await this.row(moveId);
    if (prior) {
      if (prior.user_id !== userId || prior.asset_id !== assetId || parseAmount(prior.amount) !== amount || prior.wallet !== wallet) {
        throw new BankError('This move was already asked with other terms. Nothing was sent.', 'bank.own_move_conflict');
      }
      if (prior.status === 'sent') return this.view(prior, userId, bank);
    } else {
      // The partner's free figure first: above it, nothing is kept and nothing is sent.
      const free = await bank.balance(mainAccount(userId, assetId));
      if (free.amount === null || free.amount < amount) {
        const said = free.amount === null ? 'does not report a figure for' : `reports ${formatAmount(free.amount)} ${assetId} free in`;
        throw new BankError(
          `${free.label} ${said} your account, so ${formatAmount(amount)} ${assetId} cannot move. Nothing was sent.`,
          'bank.own_move_above_free',
        );
      }
      await this.sql`
        INSERT INTO bank.own_moves (id, user_id, direction, asset_id, amount, wallet, status)
        VALUES (${moveId}, ${userId}, 'in', ${assetId}, ${formatAmount(amount)}, ${wallet}, 'opening')
        ON CONFLICT (id) DO NOTHING
      `;
      const kept = await this.row(moveId);
      if (!kept || kept.user_id !== userId || kept.asset_id !== assetId || parseAmount(kept.amount) !== amount || kept.wallet !== wallet) {
        throw new BankError('This move was already asked with other terms. Nothing was sent.', 'bank.own_move_conflict');
      }
      if (kept.status === 'sent') return this.view(kept, userId, bank);
    }

    const key = ownMoveKey(moveId);
    let moved;
    try {
      moved = await bank.move({ key, from: mainAccount(userId, assetId), to: partnerChainOutAccount(assetId), amount });
    } catch (err) {
      if (err instanceof BankError && err.code === 'bank.partner_insufficient_funds') {
        throw new BankError(`${err.message.replace(/ Nothing was moved\.$/, '')} Nothing was sent.`, 'bank.own_move_above_free');
      }
      throw err;
    }
    const tx = (await deliver({ key, to: wallet, assetId, amount: formatAmount(amount) })).toLowerCase();
    if (!TX.test(tx))
      throw new BankError('The partner answered no transfer for this move. Ask again to finish it.', 'bank.partner_reply_lost');
    const [sent] = await this.sql<Row[]>`
      UPDATE bank.own_moves SET status = 'sent', partner_ref = ${moved.id}, delivery_tx = ${tx}, sent_at = now()
      WHERE id = ${moveId} AND status = 'opening'
      RETURNING *
    `;
    return this.view(sent ?? (await this.row(moveId))!, userId, bank);
  }

  /** The wallet's own signed deposit to the venue for a sent move, recorded once; another transfer is a conflict. */
  async recordDeposit(userId: string, input: { moveId: string; depositTx: string }): Promise<OwnMove> {
    const moveId = input.moveId.toLowerCase();
    const tx = input.depositTx.trim().toLowerCase();
    if (!TX.test(tx)) throw new BankError('A deposit is a transaction hash.', 'bank.validation_failed');
    const row = await this.row(moveId);
    if (!row || row.user_id !== userId) throw new BankError('No such move of yours.', 'bank.own_move_not_found');
    if (row.status !== 'sent') {
      throw new BankError(
        'The partner has not sent this move to your wallet yet, so there is nothing to deposit.',
        'bank.own_move_conflict',
      );
    }
    if (row.deposit_tx === tx) return this.view(row, userId, this.partnerBank(userId));
    if (row.deposit_tx !== null) {
      throw new BankError(
        'This move’s deposit was already sent with another transaction. Nothing more was recorded.',
        'bank.own_move_conflict',
      );
    }
    const [kept] = await this.sql<Row[]>`
      UPDATE bank.own_moves SET deposit_tx = ${tx}, deposit_at = now()
      WHERE id = ${moveId} AND deposit_tx IS NULL
      RETURNING *
    `;
    const now = kept ?? (await this.row(moveId))!;
    if (now.deposit_tx !== tx) {
      throw new BankError(
        'This move’s deposit was already sent with another transaction. Nothing more was recorded.',
        'bank.own_move_conflict',
      );
    }
    return this.view(now, userId, this.partnerBank(userId));
  }

  /** One of the person's moves, or null. */
  async get(userId: string, moveId: string): Promise<OwnMove | null> {
    const row = await this.row(moveId.toLowerCase());
    if (!row || row.user_id !== userId) return null;
    return this.view(row, userId, this.options.custody.bankFor(userId));
  }

  /** The person's moves, newest first. */
  async list(userId: string, limit: number): Promise<OwnMove[]> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM bank.own_moves WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    const bank = this.options.custody.bankFor(userId);
    return rows.map((row) => this.view(row, userId, bank));
  }

  private partnerBank(userId: string): PartnerBank {
    const bank = this.options.custody.bankFor(userId);
    if (!bank) {
      throw new BankError(
        'This person’s bank money is not held at the partner bank, so nothing can move from it. Nothing was sent.',
        'bank.partner_unset',
      );
    }
    return bank;
  }

  private async row(moveId: string): Promise<Row | null> {
    const [row] = await this.sql<Row[]>`SELECT * FROM bank.own_moves WHERE id = ${moveId}`;
    return row ?? null;
  }

  private view(row: Row, userId: string, bank: PartnerBank | null): OwnMove {
    return {
      id: row.id,
      direction: row.direction,
      assetId: row.asset_id,
      amount: parseAmount(String(row.amount)),
      wallet: row.wallet,
      status: row.status,
      partnerRef: row.partner_ref,
      deliveryTx: row.delivery_tx,
      depositTx: row.deposit_tx,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      depositAt: row.deposit_at,
      partner: bank?.label ?? 'not known',
      partnerFee: this.options.partnerFee(userId),
    };
  }
}

function mainAccount(userId: string, assetId: string): PartnerAccountRef {
  return { userId, assetId, spaceId: null };
}

import { LedgerError, formatAmount, recipes, venueBuilderAccount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { compare, min, sub, ZERO } from '@intafaced/ledger-client/money';
import type {
  PreparedVenueAction,
  UserVenue,
  UserVenueAccount,
  UserVenueWithdrawal,
  VenueSignature,
  WithdrawIntent,
} from '@intafaced/venue-contracts';

/**
 * MOVE OWN FUNDS: OUR COLLECTED BUILDER FEES, FROM OUR BUILDER ACCOUNT AT THE VENUE TO A WALLET WE CONTROL, ABOVE A FLOAT
 * (launch money model, the "Move own funds" posting; OWNER 288 Q4: "Claimed on a schedule and moved to a wallet INTAFACED
 * controls, above a float"). J-campaigns-03 pays rewards from that wallet.
 *
 * One run, one venue:
 * - With a sweep open, it reads that withdrawal back from the venue by its nonce. Not there: the same stored, signed bytes
 *   are sent again (never a fresh action). Pending: it waits. Failed: the venue returned the funds, and nothing is posted.
 *   Done: `ownFundsMove` posts once, keyed by the chain transaction the venue names, with what arrived going to our wallet
 *   and the venue's fee and the network fee, as its record states them, as the move's costs. A record that names no
 *   transaction, or a fee it does not know, holds the sweep for a person: nothing is guessed.
 * - With none open, it sweeps what our builder account holds above the float: the smaller of the venue's own free balance
 *   and what our book shows there, so the book can always take the move. The float stays behind and pays the venue's
 *   withdrawal fee, so it must be at least that fee. The withdrawal is prepared, signed with our builder key and stored
 *   under its business key BEFORE it is sent.
 *
 * The float, the schedule (how often a run happens), the wallet and the builder key are the owner's; any one blank and the
 * run waits, naming it. If this crashes after the send, the stored row is read back on the next run: no second withdrawal.
 */
export const OWN_FUNDS_ASSET = 'USDC';

export type OwnFundsSweepState = 'sent' | 'held' | 'posted' | 'failed';

export interface OwnFundsSweepRow {
  /** Business key: `own-funds-sweep:<venueId>:<n>`. */
  readonly key: string;
  readonly venueId: string;
  readonly prepared: PreparedVenueAction;
  readonly signature: VenueSignature;
  readonly state: OwnFundsSweepState;
  /** Why it is held, or why the venue refused it. */
  readonly reason: string | null;
  readonly txHash: string | null;
  readonly ledgerTxId: string | null;
}

export interface OwnFundsSweepStore {
  /** The venue's open sweep (`sent` or `held`), if any. At most one is open per venue. */
  open(venueId: string): Promise<OwnFundsSweepRow | null>;
  /** How many sweeps this venue has ever had: the next key's number. */
  count(venueId: string): Promise<number>;
  /** Stored before the send. Refuses a second open sweep for the venue. */
  insert(row: OwnFundsSweepRow): Promise<void>;
  update(key: string, patch: Partial<Pick<OwnFundsSweepRow, 'state' | 'reason' | 'txHash' | 'ledgerTxId'>>): Promise<void>;
}

/** Our wallet: the ledger's own-funds place name, and its address on the chain the venue pays out on. */
export interface OwnFundsWallet {
  /** The place id, e.g. `test-chain:rewards`: its first segment names the network that carries the payment. */
  readonly walletId: string;
  readonly address: string;
}

export interface OwnFundsSweepDeps {
  readonly venue: UserVenue;
  /** Our builder address at the venue: the account the builder fees were claimed into. */
  readonly builder: string;
  /** Signs the withdrawal as our builder address; `null` when the owner has not given the builder key. */
  readonly signer: { readonly address: string; sign(typedData: unknown): Promise<string> } | null;
  /** The owner's float, left at the venue; `null` is unset. */
  readonly float: Amount | null;
  readonly wallet: OwnFundsWallet | null;
  readonly store: OwnFundsSweepStore;
  readonly ledger: Pick<LedgerClient, 'post' | 'balance'>;
}

export type OwnFundsSweepRun =
  | {
      readonly status: 'waiting';
      readonly reason:
        | 'trade.own_funds_float_unset'
        | 'trade.own_funds_wallet_unset'
        | 'trade.builder_signer_unset'
        | 'trade.builder_signer_mismatch'
        | 'trade.builder_address_unset';
    }
  | { readonly status: 'nothing_above_float'; readonly held: Amount }
  | { readonly status: 'sent' | 'resent' | 'pending'; readonly key: string }
  | { readonly status: 'refused'; readonly key: string; readonly code: string }
  | { readonly status: 'failed'; readonly key: string }
  | { readonly status: 'held'; readonly key: string; readonly reason: string }
  | { readonly status: 'posted'; readonly key: string; readonly ledgerTxId: string; readonly moved: string };

const ADDRESS = /^0x[0-9a-f]{40}$/;

export async function sweepOwnFunds(deps: OwnFundsSweepDeps): Promise<OwnFundsSweepRun> {
  const builder = deps.builder.trim().toLowerCase();
  if (!ADDRESS.test(builder)) return { status: 'waiting', reason: 'trade.builder_address_unset' };
  if (deps.float === null) return { status: 'waiting', reason: 'trade.own_funds_float_unset' };
  if (deps.wallet === null) return { status: 'waiting', reason: 'trade.own_funds_wallet_unset' };
  if (deps.signer === null) return { status: 'waiting', reason: 'trade.builder_signer_unset' };
  if (deps.signer.address.toLowerCase() !== builder) return { status: 'waiting', reason: 'trade.builder_signer_mismatch' };

  const venueId = deps.venue.venue.id;
  const account: UserVenueAccount = { venueId, owner: builder, subAccount: null };
  const open = await deps.store.open(venueId);
  if (open) return settleOpen(deps, deps.wallet, account, open);

  const free = (await deps.venue.balances(account)).value.find((b) => b.asset === OWN_FUNDS_ASSET)?.free ?? ZERO;
  // Our book's own figure for the place is negative: its size is what we hold there.
  const book = -(await deps.ledger.balance(venueBuilderAccount(venueId, OWN_FUNDS_ASSET))).amount;
  const held = min(free, book);
  if (compare(held, deps.float) <= 0) return { status: 'nothing_above_float', held };
  const amount = sub(held, deps.float);

  const key = `own-funds-sweep:${venueId}:${(await deps.store.count(venueId)) + 1}`;
  const intent: WithdrawIntent = {
    kind: 'withdraw',
    asset: OWN_FUNDS_ASSET,
    amount,
    destination: deps.wallet.address.toLowerCase(),
    withdrawalKey: key,
  };
  const prepared = await deps.venue.prepare(account, { role: 'owner', address: builder }, intent);
  const signature: VenueSignature = { digest: prepared.digest, signature: await deps.signer.sign(prepared.typedData), signedBy: builder };
  await deps.store.insert({ key, venueId, prepared, signature, state: 'sent', reason: null, txHash: null, ledgerTxId: null });
  const outcome = await deps.venue.submit(prepared, signature);
  if (outcome.definite && !outcome.accepted) {
    await deps.store.update(key, { state: 'failed', reason: outcome.refusal.code });
    return { status: 'refused', key, code: outcome.refusal.code };
  }
  return { status: 'sent', key };
}

async function settleOpen(
  deps: OwnFundsSweepDeps,
  wallet: OwnFundsWallet,
  account: UserVenueAccount,
  row: OwnFundsSweepRow,
): Promise<OwnFundsSweepRun> {
  const read = (await deps.venue.withdrawal(account, row.prepared.nonce)).value;
  if (read === null) {
    // The venue has no withdrawal with this nonce: the first send never landed. The same signed bytes go again.
    const outcome = await deps.venue.submit(row.prepared, row.signature);
    if (outcome.definite && !outcome.accepted) {
      await deps.store.update(row.key, { state: 'failed', reason: outcome.refusal.code });
      return { status: 'refused', key: row.key, code: outcome.refusal.code };
    }
    return { status: 'resent', key: row.key };
  }
  if (read.status === 'pending') return { status: 'pending', key: row.key };
  if (read.status === 'failed') {
    await deps.store.update(row.key, { state: 'failed', reason: 'venue.withdrawal_failed' });
    return { status: 'failed', key: row.key };
  }
  const move = moveOf(deps.venue.venue.id, wallet, read);
  if ('held' in move) {
    if (row.state !== 'held' || row.reason !== move.held) await deps.store.update(row.key, { state: 'held', reason: move.held });
    return { status: 'held', key: row.key, reason: move.held };
  }
  try {
    const tx = await deps.ledger.post(move.post);
    await deps.store.update(row.key, { state: 'posted', reason: null, txHash: move.txHash, ledgerTxId: tx.id });
    return { status: 'posted', key: row.key, ledgerTxId: tx.id, moved: formatAmount(read.amount) };
  } catch (error) {
    // The money has moved and the book did not take it (the posting freeze, a book that shows less than the venue paid, or
    // an answer lost on the way): the sweep stays open with the code, and the next run posts the same key again, which the
    // ledger answers with the first transaction if it had landed.
    const code = error instanceof LedgerError ? error.code : 'ledger.answer_lost';
    await deps.store.update(row.key, { state: 'held', reason: code, txHash: move.txHash });
    return { status: 'held', key: row.key, reason: code };
  }
}

/** The move a done withdrawal records, or why it can't be posted as read. */
function moveOf(
  venueId: string,
  wallet: OwnFundsWallet,
  read: UserVenueWithdrawal,
): { readonly post: ReturnType<typeof recipes.ownFundsMove>; readonly txHash: string } | { readonly held: string } {
  if (!read.txHash) return { held: 'trade.own_funds_sweep_tx_unreported' };
  if (!read.fee.known || !read.networkFee.known) return { held: 'trade.own_funds_sweep_fee_unknown' };
  if (read.destination !== null && read.destination !== wallet.address.toLowerCase()) {
    return { held: 'trade.own_funds_sweep_destination_mismatch' };
  }
  const network = wallet.walletId.split(':')[0]!;
  const arrived = sub(read.amount, read.networkFee.value);
  if (compare(arrived, ZERO) <= 0) return { held: 'trade.own_funds_sweep_nothing_arrived' };
  const costs = [
    ...(compare(read.fee.value, ZERO) > 0 ? [{ kind: 'venue-withdrawal-fee' as const, paidTo: venueId, amount: read.fee.value }] : []),
    ...(compare(read.networkFee.value, ZERO) > 0 ? [{ kind: 'network-fee' as const, paidTo: network, amount: read.networkFee.value }] : []),
  ];
  // What left the venue account is the amount and its fee; the book takes the same, as what arrived plus the costs.
  return {
    txHash: read.txHash,
    post: recipes.ownFundsMove({
      from: { kind: 'venue-builder-account', venueId },
      to: { kind: 'treasury-wallet', walletId: wallet.walletId },
      assetId: OWN_FUNDS_ASSET,
      amount: arrived,
      reference: read.txHash,
      costs,
    }),
  };
}

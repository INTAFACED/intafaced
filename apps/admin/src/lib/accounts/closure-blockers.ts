/**
 * What still holds an account open, in words, from the blockers identity returns with `identity.close_blocked`. The
 * codes come from the bank, trading and P2P closure checks; one this console does not know is shown by its code.
 */
const LABEL: Readonly<Record<string, string>> = {
  balance_remaining: 'asset with a balance',
  open_loan: 'open loan',
  active_card: 'card not closed',
  active_schedule: 'active scheduled payment',
  pending_ramp: 'pending deposit or withdrawal',
  earn_position: 'earn position',
  open_order: 'open order',
  open_position: 'open position',
  convert_hold: 'convert in progress',
  open_offer: 'open P2P offer',
  open_trade: 'open P2P trade',
  open_dispute: 'open P2P dispute',
};

export function describeBlockers(blockers: readonly { code: string; count: number }[] | undefined): string | null {
  if (!blockers || blockers.length === 0) return null;
  return blockers.map((b) => (Object.hasOwn(LABEL, b.code) ? `${b.count} × ${LABEL[b.code]}` : `${b.count} × ${b.code}`)).join(', ');
}

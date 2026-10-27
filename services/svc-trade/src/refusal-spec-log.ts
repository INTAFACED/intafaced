/**
 * Spec ids for trade refusals. Customer text must not carry these.
 * One line per code per process, on stderr, when a refusal is built.
 */

const logged = new Set<string>();

export const REFUSAL_SPEC_NOTES = {
  'trade.copy_fee_share_blank': 'DIRECTION §8 / D26-P0-02 leader_share_bps',
  'trade.copy_jurisdiction_blank': 'DIRECTION §8 / D26-P0-15 served-jurisdiction list',
  'trade.copy_pnl_fee_forbidden': 'SPEC-SOVEREIGN §3 P&L-linked copy fees forbidden',
  'trade.copy_ranking_forbidden': 'SPEC-SOVEREIGN §4 returns-ranked leaderboards forbidden',
  'trade.otc_desk_law_blank': 'DIRECTION §8 RFQ spreads, staked-tier threshold, and principal-vs-maker',
  'trade.rfq_allocation_refused': 'PTX-M12-R04/R08 allocation',
  'trade.rfq_give_up_refused': 'PTX-M12-R08 give-up',
  'trade.otc_settle_refused': 'SOCKET §13 socket.otc-maker-routing',
  'trade.otc_no_reference_price': 'SOCKET §13 socket.otc-mid-feed',
  'trade.options_settlement_law_unset': 'D26-P0-05 SOCKET §13 socket.options-settlement-asset-law',
  'trade.options_fixing_unconfigured': 'D7 TRADE_OPTIONS_SETTLEMENT_FIXING',
  'trade.unsettled_asset_class_listing': 'D26-P0-05 socket.forex-settlement fiat settle rails',
  'trade.fee_schedule_blank': 'PTX-M21 fee/rebate schedule',
  'trade.rebate_recipe_unavailable': 'SP-fees-vip-01 / ENGINE DEC-7 signed-fee ledger recipe',
  'trade.min_fee_recipe_unavailable': 'SP-fees-vip-01 amount-level fee recipe',
  'trade.leverage_too_high': 'DIRECTION §1 sealed 10× cap',
  'trade.insurance_fund_empty': 'DIRECTION:33 empty insurance fund blocks real-money futures list',
  ProfitSourceConfigError: 'DIRECTION §8 item 6 / DIRECTION §3 TRADE_FUTURES_PROFIT_SOURCE',
  paperListPolicy: 'Nitro product N3 exclude paper markets from the public list',
} as const;

export type RefusalSpecCode = keyof typeof REFUSAL_SPEC_NOTES;

export function logRefusalSpec(code: RefusalSpecCode): void {
  if (logged.has(code)) return;
  const spec = REFUSAL_SPEC_NOTES[code];
  logged.add(code);
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'trade.refusal.spec', code, spec })}\n`);
}

/** Tests only. Production keeps the once-per-process guard. */
export function resetRefusalSpecLogForTests(): void {
  logged.clear();
}

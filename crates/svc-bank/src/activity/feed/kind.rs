//! Which ledger `module`/`reason` is which kind of line a person sees (`activity-kind.ts`): one table, unknown is
//! `other`, never dropped. The book's convention is "debit increases the account", so on the person's `available`
//! accounts a debit is money in and a credit money out. And the tax effect of each kind (`tax-effects.ts`): the
//! owner's map is blank, so the view refuses by name; `BANK_TAX_EFFECTS=test` puts a TEST map in its place on a dev or
//! test stack only.

/// `ACTIVITY_KINDS`, in the contract's order.
pub const KINDS: [&str; 16] = [
    "deposit",
    "welcome_funds",
    "transfer_in",
    "transfer_out",
    "trade",
    "convert",
    "fee",
    "payment",
    "withdrawal",
    "space_move",
    "order_hold",
    "order_release",
    "earn",
    "staking",
    "reward",
    "other",
];

/// `KIND_BY_MODULE_REASON`: `module/reason` to kind, exact; `transfer` is resolved to in or out by direction.
pub const BY_MODULE_REASON: &[(&str, &str)] = &[
    ("ledger/deposit.credited", "deposit"),
    ("ledger/deposit.reversed", "deposit"),
    ("ledger/withdraw.held", "withdrawal"),
    ("ledger/withdraw.settled", "withdrawal"),
    ("ledger/withdraw.reversed", "withdrawal"),
    ("bank/bank.transfer.manual", "transfer"),
    ("bank/bank.transfer.scheduled", "transfer"),
    ("identity/identity.sub_account.transfer", "space_move"),
    ("trade/trade.fill", "trade"),
    ("trade/trade.fill.mm_maker", "trade"),
    ("trade/trade.fill.buyback", "trade"),
    ("trade/futures.margin.lock", "trade"),
    ("trade/futures.margin.add", "trade"),
    ("trade/futures.margin.release", "trade"),
    ("trade/futures.loss.realized", "trade"),
    ("trade/futures.profit.realized", "trade"),
    ("trade/futures.funding.paid", "trade"),
    ("trade/order.hold", "order_hold"),
    ("trade/order.hold.amend", "order_hold"),
    ("trade/order.hold.released", "order_release"),
    ("trade/order.hold.mm", "other"),
    ("trade/order.hold.mm.released", "other"),
    ("trade/order.hold.buyback", "other"),
    ("trade/order.hold.buyback.released", "other"),
    ("trade/mm.seed.funded", "other"),
    ("trade/futures.insurance.topup", "other"),
    ("p2p/p2p.escrow.lock", "trade"),
    ("p2p/p2p.escrow.release", "trade"),
    ("p2p/p2p.escrow.refund", "trade"),
    ("pay/payment.captured", "payment"),
    ("pay/pay.settled", "payment"),
    ("pay/payment.refunded", "payment"),
    ("pay/payment.refund.reversed", "payment"),
    ("pay/pay.chargeback.opened", "payment"),
    ("pay/pay.chargeback.shortfall.covered", "payment"),
    ("pay/pay.chargeback.won", "payment"),
    ("pay/pay.chargeback.shortfall.recovered", "payment"),
    ("market/market.purchase", "payment"),
    ("market/market.listing_fee", "fee"),
    ("market/market.premium_placement", "fee"),
    ("bank/bank.business.approval.settled", "payment"),
    ("bank/bank.business.payroll.settled", "payment"),
    ("bank/bank.business.approval.held", "other"),
    ("bank/bank.business.approval.released", "other"),
    ("bank/bank.earn.deposited", "earn"),
    ("bank/bank.earn.withdrawn", "earn"),
    ("bank/bank.earn.interest", "earn"),
    ("bank/bank.earn.pool.funded", "other"),
    ("bank/loan.collateral.locked", "other"),
    ("bank/loan.collateral.released", "other"),
    ("bank/loan.drawn", "other"),
    ("bank/loan.repaid", "other"),
    ("bank/loan.liquidated", "other"),
    ("bank/loan.bad_debt.covered", "other"),
    ("bank/loan.reserve.funded", "other"),
    ("token/token.stake", "staking"),
    ("token/token.unstake", "staking"),
    ("token/token.emission", "other"),
    ("token/token.burn", "other"),
    ("token/token.fee.swept", "other"),
    ("token/token.yield.distributed", "reward"),
    ("token/bank.card.cashback", "reward"),
];

/// `KIND_BY_REASON`: the reason alone, for postings whose module is the caller's (`feeCharge`).
pub const BY_REASON: [(&str, &str); 1] = [("fee.charged", "fee")];

/// `KIND_BY_REASON_PREFIX`.
pub const BY_REASON_PREFIX: [(&str, &str); 2] = [("reward", "reward"), ("token.yield", "reward")];

/// `WELCOME_FUNDS_RAILS`.
pub const WELCOME_FUNDS_RAILS: [&str; 1] = ["local-test"];

/// `directionOf`: debit is in, credit is out.
pub fn direction_of(direction: &str) -> &'static str {
    if direction == "debit" { "in" } else { "out" }
}

fn row_of(module: &str, reason: &str) -> &'static str {
    let key = format!("{module}/{reason}");
    BY_MODULE_REASON
        .iter()
        .find(|(k, _)| *k == key)
        .or_else(|| BY_REASON.iter().find(|(r, _)| *r == reason))
        .or_else(|| {
            BY_REASON_PREFIX
                .iter()
                .find(|(prefix, _)| reason.starts_with(prefix))
        })
        .map_or("other", |(_, kind)| kind)
}

/// `classify`.
pub fn classify(
    module: &str,
    reason: &str,
    direction: &str,
    rail: Option<&str>,
    product: Option<&str>,
) -> &'static str {
    let row = row_of(module, reason);
    if row == "transfer" {
        return if direction == "debit" {
            "transfer_in"
        } else {
            "transfer_out"
        };
    }
    if row == "trade"
        && product == Some("convert")
        && format!("{module}/{reason}") == "trade/trade.fill.mm_maker"
    {
        return "convert";
    }
    if row == "deposit" && rail.is_some_and(|r| WELCOME_FUNDS_RAILS.contains(&r)) {
        return "welcome_funds";
    }
    row
}

/// `ACTIVITY_KIND_LABELS`: the words a screen shows for each kind.
pub fn label(kind: &str) -> &'static str {
    match kind {
        "deposit" => "Deposit",
        "welcome_funds" => "Welcome test funds",
        "transfer_in" => "Transfer received",
        "transfer_out" => "Transfer sent",
        "trade" => "Trade",
        "convert" => "Convert",
        "fee" => "Fee",
        "payment" => "Payment",
        "withdrawal" => "Withdrawal",
        "space_move" => "Moved between Spaces",
        "order_hold" => "Set aside for an order",
        "order_release" => "Returned from an order",
        "earn" => "Earn",
        "staking" => "Staking",
        "reward" => "Reward",
        _ => "Other",
    }
}

/// The kind as one of [`KINDS`] (for a kind read from the input, which the schema already held to the list).
pub fn known(kind: &str) -> Option<&'static str> {
    KINDS.iter().copied().find(|k| *k == kind)
}

/// `TAX_EFFECT_BY_KIND`: the owner's and counsel's call, blank.
pub const OWNER_TAX_EFFECTS: [(&str, &str); 0] = [];

/// `TEST_TAX_EFFECT_BY_KIND`: made up for test stacks, not a tax treatment anyone decided.
pub const TEST_TAX_EFFECTS: [(&str, &str); 16] = [
    ("deposit", "neutral"),
    ("welcome_funds", "income"),
    ("transfer_in", "neutral"),
    ("transfer_out", "neutral"),
    ("trade", "disposal"),
    ("convert", "disposal"),
    ("fee", "neutral"),
    ("payment", "disposal"),
    ("withdrawal", "neutral"),
    ("space_move", "neutral"),
    ("order_hold", "neutral"),
    ("order_release", "neutral"),
    ("earn", "income"),
    ("staking", "neutral"),
    ("reward", "income"),
    ("other", "neutral"),
];

/// `TaxEffectMap`: `label` is `TEST` for the test stacks' stand-in, none for the owner's own map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxEffects {
    pub effects: Vec<(String, String)>,
    pub label: Option<&'static str>,
}

/// `TestTaxEffectsRefusedError`'s words.
pub const TEST_TAX_EFFECTS_REFUSED: &str = "BANK_TAX_EFFECTS=test is a TEST tax-effect map made up for test stacks; it runs only with APP_ENV exactly dev or test.";

/// `taxEffectsFor`: the owner's map once set; else the TEST one when chosen on a dev or test stack; else none, which
/// refuses by name. The TEST map chosen anywhere else refuses to start.
pub fn tax_effects_for(
    setting: &str,
    app_env: Option<&str>,
    node_env: Option<&str>,
    owner: &[(&str, &str)],
) -> Result<Option<TaxEffects>, String> {
    if setting == "test"
        && (!matches!(app_env, Some("dev" | "test")) || node_env == Some("production"))
    {
        return Err(TEST_TAX_EFFECTS_REFUSED.to_owned());
    }
    let own = |m: &[(&str, &str)]| -> Vec<(String, String)> {
        m.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    if !owner.is_empty() {
        return Ok(Some(TaxEffects {
            effects: own(owner),
            label: None,
        }));
    }
    if setting == "test" {
        return Ok(Some(TaxEffects {
            effects: own(&TEST_TAX_EFFECTS),
            label: Some("TEST"),
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn c(module: &str, reason: &str, direction: &str) -> &'static str {
        classify(module, reason, direction, None, None)
    }

    #[test]
    fn every_table_row_resolves_to_a_declared_kind() {
        for (key, row) in BY_MODULE_REASON {
            assert!(*row == "transfer" || KINDS.contains(row), "{key}");
        }
        for kind in KINDS {
            assert!(!label(kind).is_empty());
        }
        assert_eq!(label("welcome_funds"), "Welcome test funds");
    }

    #[test]
    fn transfers_resolve_by_direction() {
        assert_eq!(c("bank", "bank.transfer.manual", "debit"), "transfer_in");
        assert_eq!(
            c("bank", "bank.transfer.scheduled", "credit"),
            "transfer_out"
        );
        assert_eq!(
            c("identity", "identity.sub_account.transfer", "debit"),
            "space_move"
        );
    }

    #[test]
    fn fee_charged_is_a_fee_under_any_caller_module() {
        for module in ["trade", "pay", "bank", "anything"] {
            assert_eq!(c(module, "fee.charged", "credit"), "fee");
        }
    }

    #[test]
    fn an_unknown_module_reason_is_other_never_dropped_or_thrown() {
        assert_eq!(c("newmod", "something.new", "debit"), "other");
        assert_eq!(c("", "", "credit"), "other");
    }

    #[test]
    fn a_hold_is_order_hold_a_release_is_order_release_fills_stay_trade_other_stays_other() {
        assert_eq!(c("trade", "order.hold", "credit"), "order_hold");
        assert_eq!(c("trade", "order.hold.amend", "credit"), "order_hold");
        assert_eq!(c("trade", "order.hold.released", "debit"), "order_release");
        assert_eq!(c("trade", "trade.fill", "debit"), "trade");
        assert_eq!(c("trade", "order.hold.mm", "credit"), "other");
    }

    #[test]
    fn earn_staking_and_rewards_are_named_a_reward_reason_the_table_has_not_met_yet_is_still_a_reward()
     {
        assert_eq!(c("bank", "bank.earn.interest", "debit"), "earn");
        assert_eq!(c("token", "token.stake", "credit"), "staking");
        assert_eq!(c("token", "token.yield.distributed", "debit"), "reward");
        assert_eq!(c("bank", "reward.referral", "debit"), "reward");
        assert_eq!(c("x", "token.yield.weekly", "debit"), "reward");
        assert_eq!(c("bank", "bank.earn.pool.funded", "debit"), "other");
    }

    #[test]
    fn a_deposit_is_deposit_welcome_funds_only_on_the_local_test_rail() {
        let d = |rail| classify("ledger", "deposit.credited", "debit", rail, None);
        assert_eq!(d(Some("local-test")), "welcome_funds");
        assert_eq!(d(Some("crypto-native")), "deposit");
        assert_eq!(d(None), "deposit");
        assert_eq!(
            classify(
                "ledger",
                "deposit.reversed",
                "credit",
                Some("local-test"),
                None
            ),
            "welcome_funds"
        );
    }

    #[test]
    fn a_convert_fill_is_convert_only_when_the_ledger_says_its_product_is_convert() {
        let f = |reason, product| classify("trade", reason, "debit", None, product);
        assert_eq!(f("trade.fill.mm_maker", Some("convert")), "convert");
        assert_eq!(f("trade.fill.mm_maker", None), "trade");
        assert_eq!(f("trade.fill", Some("convert")), "trade");
        assert_eq!(
            classify("trade", "order.hold", "credit", None, Some("convert")),
            "order_hold"
        );
    }

    #[test]
    fn direction_debit_increases_the_account_in_credit_decreases_it_out() {
        assert_eq!(direction_of("debit"), "in");
        assert_eq!(direction_of("credit"), "out");
    }

    #[test]
    fn is_blank_by_default_so_the_view_refuses_by_name() {
        assert_eq!(
            tax_effects_for("off", Some("dev"), None, &OWNER_TAX_EFFECTS),
            Ok(None)
        );
    }

    #[test]
    fn gives_the_test_map_labelled_test_on_a_dev_or_test_stack_only() {
        for env in ["dev", "test"] {
            let m = tax_effects_for("test", Some(env), None, &OWNER_TAX_EFFECTS)
                .unwrap()
                .unwrap();
            assert_eq!(m.label, Some("TEST"));
            assert_eq!(m.effects.len(), KINDS.len());
            assert_eq!(
                m.effects
                    .iter()
                    .find(|(k, _)| k == "welcome_funds")
                    .unwrap()
                    .1,
                "income"
            );
        }
    }

    #[test]
    fn refuses_to_start_with_the_test_map_anywhere_else() {
        for (app, node) in [
            (None, None),
            (Some("prod"), None),
            (Some("staging"), None),
            (Some("DEV"), None),
            (Some("dev"), Some("production")),
        ] {
            assert_eq!(
                tax_effects_for("test", app, node, &OWNER_TAX_EFFECTS),
                Err(TEST_TAX_EFFECTS_REFUSED.to_owned())
            );
        }
    }

    #[test]
    fn takes_the_owners_map_once_it_is_set_unlabelled_with_or_without_the_switch() {
        let owner = [("trade", "disposal")];
        for setting in ["off", "test"] {
            let m = tax_effects_for(setting, Some("dev"), None, &owner)
                .unwrap()
                .unwrap();
            assert_eq!(m.label, None);
            assert_eq!(m.effects, vec![("trade".to_owned(), "disposal".to_owned())]);
        }
    }
}

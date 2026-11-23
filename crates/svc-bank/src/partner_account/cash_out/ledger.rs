//! The ledger as a cash-out reads and posts it: the available balance, the four recipes a ledger-held cash-out
//! posts (`withdrawHold`, `withdrawSettle`, `withdrawReverse` and `deposit` from `packages/ledger-client`), and a
//! look-up by a recipe's idempotency key.
//!
//! A cash-out never assembles entries: it names a recipe and its inputs ([`Recipe`]), and svc-ledger builds the entries
//! from `packages/ledger-client/src/recipes/` on its `postRecipe` door, as every slice posts ([`HttpLedger`], over
//! `spaces::ports::LedgerHttp`). A door built without the service's environment is handed [`Unwired`], which refuses
//! every read and post as an opaque failure: what the TypeScript answers with no ledger that answers.

use service_kit::money::{Amount, format_amount};

use crate::errors::Refusal;

/// One recipe of `packages/ledger-client`, named with its inputs. The entries are the recipe's, never built here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recipe {
    /// `withdrawHold`: `available` into this withdrawal's own hold.
    WithdrawHold(Withdrawal),
    /// `withdrawSettle`: the hold to the rail boundary.
    WithdrawSettle(Withdrawal),
    /// `withdrawReverse`: the hold back to `available`.
    WithdrawReverse(Withdrawal),
    /// `deposit`: from the rail boundary into `available`.
    Deposit {
        user_id: String,
        asset_id: String,
        amount: Amount,
        rail: String,
        rail_ref: String,
    },
}

/// `WithdrawInput` (no fee: a cash-out's hold carries none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Withdrawal {
    pub user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub rail: String,
    pub withdrawal_id: String,
}

impl Recipe {
    /// The recipe's name in `packages/ledger-client/src/recipes/index.ts`.
    pub fn name(&self) -> &'static str {
        match self {
            Recipe::WithdrawHold(_) => "withdrawHold",
            Recipe::WithdrawSettle(_) => "withdrawSettle",
            Recipe::WithdrawReverse(_) => "withdrawReverse",
            Recipe::Deposit { .. } => "deposit",
        }
    }

    /// The idempotency key the recipe builds.
    pub fn idempotency_key(&self) -> String {
        match self {
            Recipe::WithdrawHold(w) => format!("withdraw.hold:{}", w.withdrawal_id),
            Recipe::WithdrawSettle(w) => format!("withdraw.settle:{}", w.withdrawal_id),
            Recipe::WithdrawReverse(w) => format!("withdraw.reverse:{}", w.withdrawal_id),
            Recipe::Deposit { rail, rail_ref, .. } => format!("deposit:{rail}:{rail_ref}"),
        }
    }

    /// The recipe's inputs as its wire names them (amounts as decimal strings).
    pub fn inputs(&self) -> Vec<(&'static str, String)> {
        match self {
            Recipe::WithdrawHold(w) | Recipe::WithdrawSettle(w) | Recipe::WithdrawReverse(w) => {
                vec![
                    ("userId", w.user_id.clone()),
                    ("assetId", w.asset_id.clone()),
                    ("amount", format_amount(w.amount)),
                    ("rail", w.rail.clone()),
                    ("withdrawalId", w.withdrawal_id.clone()),
                ]
            }
            Recipe::Deposit {
                user_id,
                asset_id,
                amount,
                rail,
                rail_ref,
            } => vec![
                ("userId", user_id.clone()),
                ("assetId", asset_id.clone()),
                ("amount", format_amount(*amount)),
                ("rail", rail.clone()),
                ("railRef", rail_ref.clone()),
            ],
        }
    }
}

/// Why a post did not land.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostError {
    /// `InsufficientFundsError`: the account it draws on holds less.
    InsufficientFunds,
    /// Anything else, as the ledger client throws it.
    Failed(Refusal),
}

/// What a cash-out asks of svc-ledger (`Pick<LedgerClient, 'post' | 'getTxByKey'>` and `ramps.availableOf`).
pub trait Ledger: Send + Sync {
    /// `ledger.balance(userAvailable(userId, assetId)).amount`.
    fn available(&self, user_id: &str, asset_id: &str) -> Result<Amount, Refusal>;
    /// `ledger.post(recipe)`: the transaction id it booked (the first one, for a key already booked).
    fn post(&self, recipe: &Recipe) -> Result<String, PostError>;
    /// `ledger.getTxByKey(key)?.id`.
    fn tx_by_key(&self, key: &str) -> Result<Option<String>, Refusal>;
}

/// No svc-ledger door the Rust bank may post through yet: every read and post fails, as an opaque failure.
pub struct Unwired;

const UNWIRED: &str = "svc-bank in Rust: no svc-ledger door takes svc-bank's reads and recipes yet";

impl Ledger for Unwired {
    fn available(&self, _user_id: &str, _asset_id: &str) -> Result<Amount, Refusal> {
        Err(Refusal::Other(UNWIRED.to_owned()))
    }

    fn post(&self, _recipe: &Recipe) -> Result<String, PostError> {
        Err(PostError::Failed(Refusal::Other(UNWIRED.to_owned())))
    }

    fn tx_by_key(&self, _key: &str) -> Result<Option<String>, Refusal> {
        Err(Refusal::Other(UNWIRED.to_owned()))
    }
}

/// svc-ledger over its doors (`balance`, `postRecipe`, `getTxByKey`), signed as svc-bank.
pub struct HttpLedger(pub Box<dyn crate::spaces::ports::Ledger>);

impl Ledger for HttpLedger {
    fn available(&self, user_id: &str, asset_id: &str) -> Result<Amount, Refusal> {
        self.0
            .balance(&crate::spaces::ports::LedgerAccount::user_available(
                user_id, asset_id,
            ))
            .map_err(Refusal::Other)
    }

    fn post(&self, recipe: &Recipe) -> Result<String, PostError> {
        let input = service_kit::json::Json::Object(
            recipe
                .inputs()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), service_kit::json::Json::str(v)))
                .collect(),
        );
        match self
            .0
            .post_recipe(recipe.name(), &input, &recipe.idempotency_key())
        {
            Ok(tx) => Ok(tx.id),
            Err(f) if f.insufficient() => Err(PostError::InsufficientFunds),
            Err(f) => Err(PostError::Failed(crate::transfers::moves::post_refusal(&f))),
        }
    }

    fn tx_by_key(&self, key: &str) -> Result<Option<String>, Refusal> {
        self.0
            .tx_by_key(key)
            .map(|tx| tx.map(|t| t.id))
            .map_err(Refusal::Other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::spaces::ports::{LedgerAccount, LedgerBalance, LedgerTx, PostFailure};
    use service_kit::json::Json;

    /// svc-ledger's recipe door as the post sees it: each call recorded, answered in turn.
    struct Recipes(
        Arc<Mutex<Vec<(String, String, String)>>>,
        Mutex<Vec<Result<&'static str, PostFailure>>>,
    );

    impl crate::spaces::ports::Ledger for Recipes {
        fn balance(&self, _: &LedgerAccount) -> Result<Amount, String> {
            Err("not read here".to_owned())
        }
        fn balances(&self, _: &str, _: &str) -> Result<Vec<LedgerBalance>, String> {
            Err("not read here".to_owned())
        }
        fn assets(&self) -> Result<Vec<Json>, String> {
            Err("not read here".to_owned())
        }
        fn post_recipe(
            &self,
            recipe: &str,
            input: &Json,
            key: &str,
        ) -> Result<LedgerTx, PostFailure> {
            self.0
                .lock()
                .unwrap()
                .push((recipe.to_owned(), input.compact(), key.to_owned()));
            self.1.lock().unwrap().remove(0).map(|id| LedgerTx {
                id: id.to_owned(),
                key: key.to_owned(),
                posted_at: service_kit::time::Instant(0),
                entries: Vec::new(),
            })
        }
    }

    #[test]
    #[allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    fn a_cash_out_posts_its_recipe_by_name_and_key_and_keeps_a_short_balance_apart() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let ledger = HttpLedger(Box::new(Recipes(
            calls.clone(),
            Mutex::new(vec![
                Ok("tx-1"),
                Err(PostFailure::Coded {
                    code: "ledger.insufficient_funds".to_owned(),
                    message: "short".to_owned(),
                    attempts: 1,
                }),
                Err(PostFailure::Unknown("timeout".to_owned())),
            ]),
        )));
        let hold = Recipe::WithdrawHold(Withdrawal {
            user_id: "u".into(),
            asset_id: "USDT".into(),
            amount: Amount::UNIT,
            rail: "payout-sim".into(),
            withdrawal_id: "cash-out:x".into(),
        });
        assert_eq!(ledger.post(&hold), Ok("tx-1".to_owned()));
        assert_eq!(ledger.post(&hold), Err(PostError::InsufficientFunds));
        assert!(matches!(ledger.post(&hold), Err(PostError::Failed(_))));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "withdrawHold");
        assert_eq!(calls[0].2, "withdraw.hold:cash-out:x");
        assert_eq!(
            calls[0].1,
            r#"{"userId":"u","assetId":"USDT","amount":"0.000000000000000001","rail":"payout-sim","withdrawalId":"cash-out:x"}"#
        );
    }

    #[test]
    fn each_recipe_is_keyed_as_the_ledger_client_keys_it() {
        let w = Withdrawal {
            user_id: "u".into(),
            asset_id: "USDT".into(),
            amount: Amount::UNIT,
            rail: "payout-sim".into(),
            withdrawal_id: "cash-out:x".into(),
        };
        assert_eq!(
            Recipe::WithdrawHold(w.clone()).idempotency_key(),
            "withdraw.hold:cash-out:x"
        );
        assert_eq!(
            Recipe::WithdrawSettle(w.clone()).idempotency_key(),
            "withdraw.settle:cash-out:x"
        );
        assert_eq!(
            Recipe::WithdrawReverse(w).idempotency_key(),
            "withdraw.reverse:cash-out:x"
        );
        let d = Recipe::Deposit {
            user_id: "u".into(),
            asset_id: "USDT".into(),
            amount: Amount::UNIT,
            rail: "payout-sim".into(),
            rail_ref: "cash-out-return:x".into(),
        };
        assert_eq!(d.idempotency_key(), "deposit:payout-sim:cash-out-return:x");
        assert_eq!(d.name(), "deposit");
    }
}

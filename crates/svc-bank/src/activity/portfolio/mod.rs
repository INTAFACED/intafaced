//! Part `portfolio` of the activity slice: `portfolio.*` (`router/portfolio.router.ts`, `portfolio/`), the seven reads
//! of the person's own holdings. Every call is read only and self only: the owner is the verified principal and no
//! input names anyone else.
//!
//! - `valuation`: the one total-value rule and the holdings projection.
//! - `allocation`: the priced holdings by class and by available / locked.
//! - `candles`: svc-trade's public candles and the close at a moment.
//! - `history`: value over time, holdings change, their grid, and svc-ledger's `holdingsHistory`.
//! - `tickers`: svc-trade's public tickers and markets.
//! - `service`: `PortfolioService` over its ports.
//!
//! Every call but `balanceEntries` answers through the main router's guard (`guard`); `balanceEntries` answers through
//! the activity feed's own mapping (`activityFailure`).

pub mod allocation;
pub mod candles;
pub mod history;
pub mod service;
pub mod tickers;
pub mod valuation;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::{Deps, user_of};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::spaces::ports::Ledger;
use crate::spaces::space::{self, Money, pg};
use service::{EntriesInput, Fail, FeeReads, Named, Service, SpaceLister, SummaryInput};

/// What the door holds for this part (`index.ts`'s `portfolio` options): svc-trade's tickers and candles, and
/// svc-ledger's holdings history. The balances and the asset registry are svc-ledger's reads slice `spaces` holds;
/// the entries behind a balance read `historyPage` through the slice's `entry_pages`.
pub struct Wiring {
    pub tickers: Box<dyn tickers::TickerSource>,
    pub history: Box<dyn history::HoldingsHistory>,
    pub closes: Box<dyn candles::CloseSource>,
}

impl Wiring {
    /// Nothing wired: every price, history and candle read fails, as an unreachable source would.
    pub fn none() -> Wiring {
        Wiring {
            tickers: Box::new(tickers::NoTickers),
            history: Box::new(history::NoHistory),
            closes: Box::new(candles::NoCloses),
        }
    }
}

/// This part's wiring from the environment: `httpTickerSource` and `httpCloseSeries` at `TRADE_URL`,
/// `createLedgerHoldingsHistory` at `LEDGER_URL`, each signed or bounded as `index.ts` builds it.
pub fn wiring(b: &super::Build<'_>) -> Result<Wiring, String> {
    let trade = b.env.str("TRADE_URL").unwrap_or("http://localhost:4004");
    Ok(Wiring {
        tickers: Box::new(tickers::HttpTickers::new(trade, (b.fetch)(), None)),
        history: Box::new(history::LedgerHoldings(b.ledger())),
        closes: Box::new(candles::HttpCloses::new(
            trade,
            (b.fetch)(),
            crate::door::system_now,
        )),
    })
}

/// svc-bank's own Spaces (`SpaceService.namedSpaces`, `allNamedSpaces`): a funded archived Space's balance is the
/// ledger's, or the partner's when it holds the person's money.
struct StoreSpaces<'a> {
    store: &'a Store,
    money: &'a Money<'a>,
}

fn named(s: space::Space) -> Named {
    Named {
        id: s.id,
        user_id: s.user_id,
        kind: s.kind,
        name: s.name,
    }
}

impl SpaceLister for StoreSpaces<'_> {
    fn named_spaces(&self, user_id: &str) -> Result<Vec<Named>, Refusal> {
        Ok(space::named_spaces(self.store, self.money, user_id)?
            .into_iter()
            .map(named)
            .collect())
    }

    fn all_named_spaces(&self, user_id: &str) -> Result<Vec<Named>, Refusal> {
        Ok(space::all_named_spaces(self.store, user_id)?
            .into_iter()
            .map(named)
            .collect())
    }
}

/// `PersonalPayService.feesFor`: a posted personal send the person is either side of charged no fee ("0"); svc-bank's
/// own table, read as the TypeScript reads it.
struct StoreFees<'a>(&'a Store);

impl FeeReads for StoreFees<'_> {
    fn fees_for(
        &self,
        user_id: &str,
        tx_ids: &[String],
    ) -> Result<HashMap<String, String>, String> {
        if tx_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = space::with(self.0, |c| {
            c.query(
                "SELECT ledger_tx_id FROM bank.personal_transfers \
                 WHERE status = 'posted' AND ledger_tx_id = ANY($1) \
                 AND (from_user_id = $2 OR to_user_id = $2)",
                &[&tx_ids, &user_id],
            )
            .map_err(|e| pg(&e))
        })
        .map_err(|r| format!("{r:?}"))?;
        Ok(rows
            .iter()
            .map(|r| (r.get::<_, String>(0), "0".to_owned()))
            .collect())
    }
}

fn text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

/// `throwBankProcedure`'s status for the codes `balanceEntries` can meet; any other is `BAD_REQUEST`.
fn procedure_status(code: &str) -> &'static str {
    match code {
        "portfolio.entries_do_not_sum" | "bank.activity_lookup_bounded" => "PRECONDITION_FAILED",
        _ => "BAD_REQUEST",
    }
}

/// `activityFailure`, as `balanceEntries` meets it: a `BankError` as `throwBankProcedure` throws it (the operator's
/// sentence and its code), the bounded lookup, the unavailable history, and anything else as the feed's opaque failure.
fn activity_failure(f: Fail) -> TrpcError {
    const BOUNDED: &str = "Activity lookup stopped before the end of your history. Try again.";
    match f {
        Fail::Refused(Refusal::Trpc(e)) => e,
        Fail::Refused(Refusal::Bank(e)) => TrpcError::caused(
            procedure_status(e.row.code),
            format!("{} ({})", e.message, e.row.code),
            e.row.code,
        ),
        Fail::Bounded => TrpcError::caused(
            "PRECONDITION_FAILED",
            format!("{BOUNDED} (bank.activity_lookup_bounded)"),
            "bank.activity_lookup_bounded",
        ),
        Fail::Unavailable => TrpcError::plain(
            "SERVICE_UNAVAILABLE",
            "Activity is not available right now. Try again in a minute.",
        ),
        Fail::Refused(Refusal::Other(_)) => TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            "Something went wrong. Please try again.",
        ),
    }
}

fn guard(r: Refusal) -> TrpcError {
    to_trpc(r, || {
        service_kit::approvals::random_uuid().unwrap_or_default()
    })
}

/// This part's answer to one of its calls; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    let path = ctx.call.path;
    if !path.starts_with("portfolio.") {
        return None;
    }
    let user = user_of(ctx);
    let input = &ctx.input;
    let store = d.store();
    let ledger: &dyn Ledger = d.door.spaces().ledger.as_ref();
    let custody = d.door.partner().custody(store);
    let money = Money {
        ledger,
        custody: &custody,
        now: ctx.now,
    };
    let spaces = StoreSpaces {
        store,
        money: &money,
    };
    let fees = StoreFees(store);
    let p = &d.w.portfolio;
    let svc = Service {
        ledger,
        spaces: &spaces,
        tickers: p.tickers.as_ref(),
        pages: d.w.entry_pages.as_ref(),
        history: p.history.as_ref(),
        closes: p.closes.as_ref(),
        fees: &fees,
        now: ctx.now,
    };
    let out = match path {
        "portfolio.summary" => svc
            .summary(
                user,
                &SummaryInput {
                    asset_id: text(input, "assetId"),
                    value_in: text(input, "valueIn"),
                    display_currency: text(input, "displayCurrency"),
                    scope: text(input, "scope"),
                },
            )
            .map_err(guard),
        "portfolio.allocation" => svc.allocation(user).map(|a| a.json()).map_err(guard),
        "portfolio.valueOverTime" => svc
            .value_over_time(
                user,
                text(input, "from").unwrap_or_default(),
                text(input, "to"),
            )
            .map(|v| v.json())
            .map_err(guard),
        "portfolio.holdingsChange" => svc
            .holdings_change(
                user,
                text(input, "from").unwrap_or_default(),
                text(input, "to"),
            )
            .map(|v| v.json())
            .map_err(guard),
        "portfolio.balanceAccounts" => svc.accounts(user).map_err(guard),
        "portfolio.balanceBreakdown" => svc
            .balance_breakdown(
                user,
                text(input, "scope").unwrap_or("all"),
                text(input, "accountId"),
                text(input, "assetId"),
            )
            .map_err(guard),
        "portfolio.balanceEntries" => {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "the schema holds it to an integer from 1 to 200"
            )]
            let limit = input
                .get("limit")
                .as_number()
                .map_or(service::BALANCE_ENTRIES_DEFAULT_LIMIT, |n| n as usize);
            svc.balance_entries(
                user,
                &EntriesInput {
                    asset_id: text(input, "assetId").unwrap_or_default(),
                    account_id: text(input, "accountId"),
                    cursor: text(input, "cursor"),
                    limit,
                },
            )
            .map_err(activity_failure)
        }
        _ => return None,
    };
    Some(out)
}

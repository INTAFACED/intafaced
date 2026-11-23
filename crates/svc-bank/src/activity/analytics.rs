//! Part `analytics` of the activity slice: `analytics.*` (`router/analytics.router.ts`, `analytics/spend.ts`,
//! `analytics/budgets.ts`, `analytics/ledger-history.ts`).
//!
//! SPEND ANALYTICS (§8.1) are computed from the ledger, every time: a fold over svc-ledger's `history` for each space
//! the person ever held in one asset, or over the partner's own record for a person the partner holds money for. There
//! is no running total anywhere. A budget is a POLICY row (`bank.budgets`): the person's monthly target for one category
//! and the share of it at which they want an alert; what was spent is the fold, read each time. The alert shows once
//! per month (`bank.budget_alert_notices`). Nothing here moves money.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::Deps;
use super::pages::HISTORY;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::partner::custody::Held;
use crate::partner::{FEES_OWNER, MovesQuery, PAY_INS_OWNER, PAYOUTS_OWNER, refuse};
use crate::spaces::ports::{LedgerAccount, LedgerHttp};
use crate::spaces::space::{self, COLS, Money, Space, pg, with};

/// `SPEND_CATEGORIES`, in their order: every summary lists every one.
pub const SPEND_CATEGORIES: [&str; 9] = [
    "transfers",
    "trading",
    "p2p",
    "fees",
    "withdrawals",
    "earn",
    "deposits",
    "rewards",
    "other",
];

/// `BUDGET_CATEGORIES`: deposits are money in, never spending, so no budget can be set on them.
pub const BUDGET_CATEGORIES: [&str; 8] = [
    "transfers",
    "trading",
    "p2p",
    "fees",
    "withdrawals",
    "earn",
    "rewards",
    "other",
];

/// `categorise`: a ledger reason code's spend category; an unrecognised reason lands in `other`, never dropped.
pub fn categorise(reason: &str) -> &'static str {
    if reason.starts_with("bank.transfer") {
        return "transfers";
    }
    if reason.starts_with("bank.earn")
        || reason.starts_with("token.stake")
        || reason.starts_with("token.unstake")
    {
        return "earn";
    }
    if reason.starts_with("trade.") || reason.starts_with("order.") {
        return "trading";
    }
    if reason.starts_with("p2p.") {
        return "p2p";
    }
    if reason.starts_with("fee.") || reason.ends_with(".fee") {
        return "fees";
    }
    if reason.starts_with("withdraw.") {
        return "withdrawals";
    }
    if reason.starts_with("deposit") {
        return "deposits";
    }
    if reason.starts_with("reward") || reason.starts_with("token.yield") {
        return "rewards";
    }
    "other"
}

// ---------------------------------------------------------------------------------------------------------------
// The read port over svc-ledger's history (`LedgerHistory`).

/// One entry on one account (`LedgerEntryRecord`), as much of it as the fold reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub reason: String,
    /// `direction === 'credit'`: a credit reduces the account, value leaving (§4.2). Anything else is a debit.
    pub credit: bool,
    pub amount: Amount,
}

/// `LedgerHistory.entriesFor`: every entry on one account posted in `[from, to)`. An `Err` is a read that failed;
/// never an empty answer in its place ("you spent nothing" and "we could not ask" must not look alike).
pub trait History: Send + Sync {
    fn entries_for(
        &self,
        account: &LedgerAccount,
        from: Instant,
        to: Instant,
    ) -> Result<Vec<Entry>, String>;
}

/// Nothing wired: every read fails.
pub struct NoHistory;

impl History for NoHistory {
    fn entries_for(&self, _: &LedgerAccount, _: Instant, _: Instant) -> Result<Vec<Entry>, String> {
        Err("svc-bank in Rust: no ledger history is wired".to_owned())
    }
}

/// `createLedgerHistory`: svc-ledger's `/trpc/history`, signed as svc-bank, with the history budget (8 s an attempt,
/// one retry, 12 s in all). The body is `{account, from, to}`.
pub struct LedgerHistory(pub LedgerHttp);

/// One wire entry as `createLedgerHistory` maps it and the fold reads it: the amount through the scaled integer (a
/// malformed one fails the read), the reason a string (`categorise` reads every one).
pub fn entry_of(e: &Json) -> Result<Entry, String> {
    let Json::Object(_) = e else {
        return Err("svc-ledger history: an entry is not an object".to_owned());
    };
    let amount = match e.get("amount") {
        Some(Json::String(s)) => parse_amount(s)?,
        _ => return Err("svc-ledger history: amount is not a decimal string".to_owned()),
    };
    let reason = match e.get("reason") {
        Some(Json::String(s)) => s.clone(),
        _ => return Err("svc-ledger history: reason is not a string".to_owned()),
    };
    Ok(Entry {
        reason,
        credit: e.get("direction") == Some(&Json::str("credit")),
        amount,
    })
}

impl History for LedgerHistory {
    fn entries_for(
        &self,
        account: &LedgerAccount,
        from: Instant,
        to: Instant,
    ) -> Result<Vec<Entry>, String> {
        let body = Json::obj([
            ("account", account.json()),
            ("from", Json::str(from.iso())),
            ("to", Json::str(to.iso())),
        ]);
        let answer = self
            .0
            .call_with("/trpc/history", &body, HISTORY)
            .map_err(|f| f.message)?;
        let Json::Array(rows) = answer else {
            return Err("svc-ledger history: the answer is not a list".to_owned());
        };
        rows.iter().map(entry_of).collect()
    }
}

/// What the door holds for this part, built once at start-up (`index.ts`'s `history`).
pub struct Wiring {
    pub history: Box<dyn History>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring {
            history: Box::new(NoHistory),
        }
    }
}

/// This part's wiring from the environment: svc-ledger's history, as `index.ts` builds it (never the TEST fault).
pub fn wiring(b: &super::Build<'_>) -> Result<Wiring, String> {
    Ok(Wiring {
        history: Box::new(LedgerHistory(b.ledger())),
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The fold (`SpendAnalytics.spendSummary`).

/// `SpendSummary`, its figures as scaled integers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub asset_id: String,
    pub from: Instant,
    pub to: Instant,
    /// Every category in `SPEND_CATEGORIES`' order: value that left, and for `deposits` also value that arrived under a
    /// deposit reason (not part of `total_outflow`).
    pub by_category: Vec<(&'static str, Amount)>,
    pub total_outflow: Amount,
    pub total_inflow: Amount,
    pub movements: i64,
}

impl Summary {
    /// `outflowByCategory[category] ?? '0'`.
    pub fn outflow(&self, category: &str) -> Amount {
        self.by_category
            .iter()
            .find(|(c, _)| *c == category)
            .map_or(Amount::ZERO, |(_, a)| *a)
    }
}

/// The running fold: what left by category, what arrived, and how many lines.
#[derive(Debug, Default)]
pub struct Fold {
    outflow: Vec<(&'static str, Amount)>,
    deposit_inflow: Amount,
    total_outflow: Amount,
    total_inflow: Amount,
    movements: i64,
}

impl Fold {
    fn out(&mut self, category: &'static str, amount: Amount) {
        self.total_outflow += amount;
        match self.outflow.iter_mut().find(|(c, _)| *c == category) {
            Some((_, a)) => *a += amount,
            None => self.outflow.push((category, amount)),
        }
    }

    /// One ledger entry on one of the person's spaces.
    pub fn entry(&mut self, e: &Entry) {
        self.movements += 1;
        if e.credit {
            self.out(categorise(&e.reason), e.amount);
        } else {
            self.total_inflow += e.amount;
            // A deposit arrives as a debit. It is not spending, and it is not a reward.
            if categorise(&e.reason) == "deposits" {
                self.deposit_inflow += e.amount;
            }
        }
    }

    /// One line of the partner's record for `user_id`. A move between the person's own spaces nets to nothing.
    pub fn partner_move(&mut self, user_id: &str, m: &crate::partner::Move) {
        if m.from.user_id == m.to.user_id {
            return;
        }
        self.movements += 1;
        if m.from.user_id == user_id {
            let category = if m.to.user_id == PAYOUTS_OWNER {
                "withdrawals"
            } else if m.to.user_id == FEES_OWNER {
                "fees"
            } else {
                "transfers"
            };
            self.out(category, m.amount);
        } else {
            self.total_inflow += m.amount;
            if m.from.user_id == PAY_INS_OWNER {
                self.deposit_inflow += m.amount;
            }
        }
    }

    /// The summary, its parts checked against the total that left.
    pub fn summary(self, asset_id: &str, from: Instant, to: Instant) -> Result<Summary, Refusal> {
        let by_category = SPEND_CATEGORIES
            .iter()
            .map(|c| {
                let left = self
                    .outflow
                    .iter()
                    .find(|(k, _)| k == c)
                    .map_or(Amount::ZERO, |(_, a)| *a);
                (
                    *c,
                    if *c == "deposits" {
                        left + self.deposit_inflow
                    } else {
                        left
                    },
                )
            })
            .collect();
        let summed: Amount = self.outflow.iter().map(|(_, a)| a).sum();
        if summed != self.total_outflow {
            return Err(Refusal::Other(format!(
                "Spend breakdown does not reconcile: parts {} vs total {}",
                format_amount(summed),
                format_amount(self.total_outflow)
            )));
        }
        Ok(Summary {
            asset_id: asset_id.to_owned(),
            from,
            to,
            by_category,
            total_outflow: self.total_outflow,
            total_inflow: self.total_inflow,
            movements: self.movements,
        })
    }
}

const WINDOW: usize = 200;
const MAX_MOVES: usize = 10_000;

/// `partnerMovesBetween`: the partner's lines for the person in one asset in `[from, to)`, newest first, pay-ins
/// included, read a window at a time; more than 10,000 refuses `bank.statement_too_large`.
fn partner_moves_between(
    p: &Held<'_>,
    user_id: &str,
    asset: &str,
    from: Instant,
    to: Instant,
) -> Result<Vec<crate::partner::Move>, Refusal> {
    let mut out = Vec::new();
    let mut before: Option<String> = None;
    let mut scanned = 0;
    while scanned < MAX_MOVES {
        let window = p.moves(
            user_id,
            &MovesQuery {
                limit: WINDOW,
                before: before.clone(),
                asset_id: Some(asset.to_owned()),
                pay_ins: true,
            },
        );
        for m in &window {
            if m.moved_at.0 < from.0 {
                return Ok(out);
            }
            if m.moved_at.0 < to.0 {
                out.push(m.clone());
            }
        }
        if window.len() < WINDOW {
            return Ok(out);
        }
        before = window.last().map(|m| m.id.clone());
        scanned += WINDOW;
    }
    Err(refuse(
        "bank.statement_too_large",
        format!("More than {MAX_MOVES} lines are in this range. Narrow the dates."),
    ))
}

/// `historySpaces`: the live primary space plus every named space ever held in the asset, archived or not, funded or
/// not. `namedSpaces(userId, assetId)` is read whole, as the TypeScript reads it: its funded-archived balance reads run
/// (and fail the summary when they fail), though only its primary is kept.
fn history_spaces(
    d: &Deps<'_>,
    money: &Money<'_>,
    user_id: &str,
    asset: &str,
) -> Result<Vec<Space>, Refusal> {
    let store = d.store();
    let live = with(store, |c| {
        c.query(
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND archived_at IS NULL \
                 ORDER BY kind DESC, name ASC"
            ),
            &[&user_id, &asset],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Space::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    space::funded_archived(store, money, user_id, Some(asset))?;
    let named = with(store, |c| {
        c.query(
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'named' \
                 ORDER BY asset_id ASC, name ASC, id ASC"
            ),
            &[&user_id, &asset],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Space::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    Ok(live
        .into_iter()
        .filter(|s| s.kind != "named")
        .chain(named)
        .collect())
}

/// `spendSummary`: a person's spending across every space they hold in one asset over `[from, to)`. Transfers between
/// their own spaces show as an outflow from one and an inflow to another, and net to zero across the set.
pub fn spend_summary(
    d: &Deps<'_>,
    user_id: &str,
    asset: &str,
    from: Instant,
    to: Instant,
) -> Result<Summary, Refusal> {
    let custody = d.door.partner().custody(d.store());
    let money = Money {
        ledger: d.door.spaces().ledger.as_ref(),
        custody: &custody,
        now: d.now,
    };
    let mut fold = Fold::default();
    // A person the partner holds money for: the same fold, over the partner's record. The ledger has no line for them.
    if let Some(p) = custody.bank_for(user_id) {
        for m in partner_moves_between(&p, user_id, asset, from, to)? {
            fold.partner_move(user_id, &m);
        }
    } else {
        for s in history_spaces(d, &money, user_id, asset)? {
            for e in
                d.w.analytics
                    .history
                    .entries_for(&s.ledger_account(), from, to)
                    .map_err(Refusal::Other)?
            {
                fold.entry(&e);
            }
        }
    }
    fold.summary(asset, from, to)
}

// ---------------------------------------------------------------------------------------------------------------
// Budgets and month comparison (`BudgetService`).

/// `BudgetProgress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub asset_id: String,
    pub category: String,
    pub period: String,
    pub target: Amount,
    pub spent: Amount,
    pub progress_bps: i64,
    pub alert_bps: i32,
    /// `new`, `seen`, or none below the share.
    pub alert: Option<&'static str>,
    pub alert_shown_at: Option<Instant>,
}

impl Progress {
    /// `present`, in the router's output order.
    fn json(&self) -> Json {
        Json::obj([
            ("assetId", Json::str(self.asset_id.clone())),
            ("category", Json::str(self.category.clone())),
            ("period", Json::str(self.period.clone())),
            ("target", Json::str(format_amount(self.target))),
            ("spent", Json::str(format_amount(self.spent))),
            ("progressBps", Json::int(self.progress_bps)),
            ("alertBps", Json::int(i64::from(self.alert_bps))),
            ("alert", self.alert.map_or(Json::Null, Json::str)),
            (
                "alertShownAt",
                self.alert_shown_at
                    .map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ])
    }
}

/// `periodOf`: the UTC month, `YYYY-MM`.
pub fn period_of(at: Instant) -> String {
    at.iso().chars().take(7).collect()
}

/// `MONTH`: `YYYY-MM` with a month 01 to 12.
fn is_month(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7
        && b.get(..4).is_some_and(|y| y.iter().all(u8::is_ascii_digit))
        && b.get(4) == Some(&b'-')
        && matches!(
            (b.get(5), b.get(6)),
            (Some(b'0'), Some(b'1'..=b'9')) | (Some(b'1'), Some(b'0'..=b'2'))
        )
}

/// `monthRange`: the month's first instant and the next month's (exclusive, as every history range is).
pub fn month_range(period: &str) -> Result<(Instant, Instant), Refusal> {
    let bad = || Refusal::Other(format!("{period} is not a month"));
    let (y, m) = period.split_once('-').ok_or_else(bad)?;
    let (y, m): (i64, u32) = (y.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let at = |y: i64, m: u32| js_date(&format!("{y:04}-{m:02}-01T00:00:00.000Z")).ok_or_else(bad);
    Ok((at(y, m)?, at(ny, nm)?))
}

fn signed(v: Amount) -> String {
    if v < Amount::ZERO {
        format!("-{}", format_amount(-v))
    } else {
        format_amount(v)
    }
}

/// `Number((spent * 10_000n) / target)`: floored basis points (both are at least zero).
fn bps(spent: Amount, target: Amount) -> Result<i64, Refusal> {
    let over = || Refusal::Other("budget progress is out of range".to_owned());
    let q = spent
        .scaled()
        .checked_mul(10_000)
        .ok_or_else(over)?
        .checked_div(target.scaled())
        .ok_or_else(over)?;
    i64::try_from(q).map_err(|_| over())
}

/// `list`: every budget the person set in one asset, with this month's spend as the fold makes it.
pub fn list(d: &Deps<'_>, user_id: &str, asset: &str) -> Result<Vec<Progress>, Refusal> {
    let period = period_of(d.now);
    let store = d.store();
    let rows = with(store, |c| {
        c.query(
            "SELECT category, target::text AS target, alert_bps FROM bank.budgets \
             WHERE user_id = $1 AND asset_id = $2 ORDER BY category",
            &[&user_id, &asset],
        )
        .map_err(|e| pg(&e))
    })?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let (from, _) = month_range(&period)?;
    let summary = spend_summary(d, user_id, asset, from, d.now)?;
    let shown = with(store, |c| {
        c.query(
            "SELECT category, floor(extract(epoch from shown_at) * 1000)::int8 FROM bank.budget_alert_notices \
             WHERE user_id = $1 AND asset_id = $2 AND period = $3",
            &[&user_id, &asset, &period],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut out = Vec::new();
    for row in &rows {
        let category: String = row.try_get(0).map_err(|e| pg(&e))?;
        let target = parse_amount(&row.try_get::<_, String>(1).map_err(|e| pg(&e))?)
            .map_err(Refusal::Other)?;
        let alert_bps: i32 = row.try_get(2).map_err(|e| pg(&e))?;
        let spent = summary.outflow(&category);
        let progress_bps = bps(spent, target)?;
        let seen = shown
            .iter()
            .find(|s| s.get::<_, String>(0) == category)
            .map(|s| Instant(s.get(1)));
        let reached = progress_bps >= i64::from(alert_bps);
        out.push(Progress {
            asset_id: asset.to_owned(),
            category,
            period: period.clone(),
            target,
            spent,
            progress_bps,
            alert_bps,
            alert: reached.then_some(if seen.is_some() { "seen" } else { "new" }),
            alert_shown_at: seen,
        });
    }
    Ok(out)
}

fn invalid(message: &str) -> Refusal {
    refuse("bank.budget_invalid", message)
}

/// `set`: sets or changes the person's budget for one category: a positive target and an alert share they chose.
pub fn set(
    d: &Deps<'_>,
    user_id: &str,
    asset: &str,
    category: &str,
    target: &str,
    alert_bps: f64,
) -> Result<Progress, Refusal> {
    if !BUDGET_CATEGORIES.contains(&category) {
        return Err(invalid(&format!(
            "{category} is not a spend category a budget can be set on"
        )));
    }
    let target = parse_amount(target).map_err(Refusal::Other)?;
    if target <= Amount::ZERO {
        return Err(invalid("A budget target is more than zero"));
    }
    if alert_bps.fract() != 0.0 || alert_bps <= 0.0 || alert_bps > 10_000.0 {
        return Err(invalid(
            "An alert share is between 1 and 10,000 basis points",
        ));
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number from 1 to 10,000"
    )]
    let alert = alert_bps as i32;
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.budgets (user_id, asset_id, category, target, alert_bps) \
             VALUES ($1, $2, $3, $4::text::numeric, $5) \
             ON CONFLICT (user_id, asset_id, category) \
             DO UPDATE SET target = EXCLUDED.target, alert_bps = EXCLUDED.alert_bps, updated_at = now()",
            &[&user_id, &asset, &category, &format_amount(target), &alert],
        )
        .map_err(|e| pg(&e))
    })?;
    of(list(d, user_id, asset)?, category)
}

/// The one budget of `category` in a list just read (`.find(...)!`).
fn of(all: Vec<Progress>, category: &str) -> Result<Progress, Refusal> {
    all.into_iter()
        .find(|b| b.category == category)
        .ok_or_else(|| Refusal::Other(format!("no budget for {category} after it was read")))
}

/// `alertShown`: records that this month's alert for one budget was shown, once.
pub fn alert_shown(
    d: &Deps<'_>,
    user_id: &str,
    asset: &str,
    category: &str,
) -> Result<Progress, Refusal> {
    let period = period_of(d.now);
    let Some(budget) = list(d, user_id, asset)?
        .into_iter()
        .find(|b| b.category == category)
    else {
        return Err(refuse(
            "bank.budget_unset",
            format!("No budget is set for {category}"),
        ));
    };
    if budget.alert.is_none() {
        return Ok(budget);
    }
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.budget_alert_notices (user_id, asset_id, category, period) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, asset_id, category, period) DO NOTHING",
            &[&user_id, &asset, &category, &period],
        )
        .map_err(|e| pg(&e))
    })?;
    of(list(d, user_id, asset)?, category)
}

/// `leftToSpend`: this month's targets less this month's spend across the person's budgets in one asset.
pub fn left_to_spend(d: &Deps<'_>, user_id: &str, asset: &str) -> Result<Json, Refusal> {
    let budgets = list(d, user_id, asset)?;
    let Some(first) = budgets.first() else {
        return Err(refuse(
            "bank.budget_unset",
            "Left to spend needs a budget, and none is set",
        ));
    };
    let target: Amount = budgets.iter().map(|b| b.target).sum();
    let spent: Amount = budgets.iter().map(|b| b.spent).sum();
    Ok(Json::obj([
        ("assetId", Json::str(asset)),
        ("period", Json::str(first.period.clone())),
        ("target", Json::str(format_amount(target))),
        ("spent", Json::str(format_amount(spent))),
        ("left", Json::str(signed(target - spent))),
    ]))
}

fn months_refused() -> Refusal {
    refuse(
        "bank.compare_months",
        "A comparison takes two to twelve different months",
    )
}

/// `compare`: two to twelve months side by side, each category's outflow per month and its change.
pub fn compare(
    d: &Deps<'_>,
    user_id: &str,
    asset: &str,
    months: &[String],
) -> Result<Json, Refusal> {
    let current = period_of(d.now);
    let distinct = months
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if months.len() < 2 || months.len() > 12 || distinct != months.len() {
        return Err(months_refused());
    }
    if months.iter().any(|m| !is_month(m) || *m > current) {
        return Err(refuse(
            "bank.compare_months",
            "Each month is YYYY-MM and none is in the future",
        ));
    }
    let mut summaries = Vec::new();
    for month in months {
        let (from, to) = month_range(month)?;
        let end = if *month == current { d.now } else { to };
        summaries.push(spend_summary(d, user_id, asset, from, end)?);
    }
    let categories = BUDGET_CATEGORIES
        .iter()
        .map(|c| {
            let by_month: Vec<Amount> = summaries.iter().map(|s| s.outflow(c)).collect();
            let change = by_month.last().copied().unwrap_or(Amount::ZERO)
                - by_month.first().copied().unwrap_or(Amount::ZERO);
            Json::obj([
                ("category", Json::str(*c)),
                (
                    "byMonth",
                    Json::Array(
                        by_month
                            .iter()
                            .map(|a| Json::str(format_amount(*a)))
                            .collect(),
                    ),
                ),
                ("change", Json::str(signed(change))),
            ])
        })
        .collect();
    let totals = |f: fn(&Summary) -> Amount| {
        Json::Array(
            summaries
                .iter()
                .map(|s| Json::str(format_amount(f(s))))
                .collect(),
        )
    };
    Ok(Json::obj([
        ("assetId", Json::str(asset)),
        (
            "months",
            Json::Array(months.iter().map(|m| Json::str(m.clone())).collect()),
        ),
        ("categories", Json::Array(categories)),
        ("totalOutflow", totals(|s| s.total_outflow)),
        ("totalInflow", totals(|s| s.total_inflow)),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// The calls (`createAnalyticsRouter`).

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn date(v: &Value, key: &str) -> Result<Instant, Refusal> {
    js_date(text(v, key)).ok_or_else(|| Refusal::Other(format!("{key} is no date")))
}

/// The spend summary as `analytics.spend` answers it (the router drops `userId`).
fn spend_json(s: &Summary) -> Json {
    Json::obj([
        ("assetId", Json::str(s.asset_id.clone())),
        ("from", Json::str(s.from.iso())),
        ("to", Json::str(s.to.iso())),
        (
            "outflowByCategory",
            Json::Object(
                s.by_category
                    .iter()
                    .map(|(c, a)| ((*c).to_owned(), Json::str(format_amount(*a))))
                    .collect(),
            ),
        ),
        ("totalOutflow", Json::str(format_amount(s.total_outflow))),
        ("totalInflow", Json::str(format_amount(s.total_inflow))),
        (
            "net",
            Json::str(format_amount(s.total_inflow - s.total_outflow)),
        ),
        ("movements", Json::int(s.movements)),
    ])
}

/// This part's answer to one of its calls, each inside the router's `guard`.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    let path = ctx.call.path;
    if !matches!(
        path,
        "analytics.spend"
            | "analytics.budgets"
            | "analytics.setBudget"
            | "analytics.budgetAlertShown"
            | "analytics.leftToSpend"
            | "analytics.compare"
    ) {
        return None;
    }
    let user = super::user_of(ctx);
    let input = &ctx.input;
    let asset = text(input, "assetId");
    let out: Result<Json, Refusal> = (|| match path {
        "analytics.spend" => {
            let (from, to) = (date(input, "from")?, date(input, "to")?);
            Ok(spend_json(&spend_summary(d, user, asset, from, to)?))
        }
        "analytics.budgets" => Ok(Json::Array(
            list(d, user, asset)?.iter().map(Progress::json).collect(),
        )),
        "analytics.setBudget" => Ok(set(
            d,
            user,
            asset,
            text(input, "category"),
            text(input, "target"),
            input.get("alertBps").as_number().unwrap_or(f64::NAN),
        )?
        .json()),
        "analytics.budgetAlertShown" => {
            Ok(alert_shown(d, user, asset, text(input, "category"))?.json())
        }
        "analytics.leftToSpend" => left_to_spend(d, user, asset),
        _ => {
            let months: Vec<String> = input
                .get("months")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|m| m.as_str().unwrap_or_default().to_owned())
                .collect();
            compare(d, user, asset, &months)
        }
    })();
    Some(out.map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    const ZERO: Amount = Amount::ZERO;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn entry(reason: &str, direction: &str, amount: &str) -> Entry {
        Entry {
            reason: reason.to_owned(),
            credit: direction == "credit",
            amount: amt(amount),
        }
    }

    /// `summarise`: the fold over one primary space's entries.
    fn summarise(entries: &[Entry]) -> Summary {
        let mut f = Fold::default();
        for e in entries {
            f.entry(e);
        }
        f.summary("USDT", Instant(0), Instant(1)).unwrap()
    }

    // spend-categorise.test.ts

    #[test]
    fn sends_every_deposit_reason_to_deposits() {
        assert!(SPEND_CATEGORIES.contains(&"deposits"));
        assert!(SPEND_CATEGORIES.contains(&"rewards"));
        assert_eq!(categorise("deposit.credited"), "deposits");
        assert_eq!(categorise("deposit"), "deposits");
        assert_eq!(categorise("deposit.pending"), "deposits");
    }

    #[test]
    fn keeps_reward_and_token_yield_in_rewards() {
        assert_eq!(categorise("reward"), "rewards");
        assert_eq!(categorise("reward.paid"), "rewards");
        assert_eq!(categorise("token.yield"), "rewards");
        assert_eq!(categorise("token.yield.paid"), "rewards");
        assert_eq!(categorise("bank.earn.deposited"), "earn");
    }

    #[test]
    fn puts_a_deposit_credited_inflow_in_deposits_not_rewards() {
        // `recipes.deposit` books the arrival as a debit on the person's available account.
        let s = summarise(&[entry("deposit.credited", "debit", "1000")]);
        assert_eq!(s.outflow("deposits"), amt("1000"));
        assert_eq!(s.outflow("rewards"), ZERO);
        assert_eq!(s.total_inflow, amt("1000"));
        assert_eq!(s.total_outflow, ZERO);
    }

    #[test]
    fn puts_a_deposit_credited_outflow_in_deposits_not_rewards() {
        let s = summarise(&[entry("deposit.credited", "credit", "5")]);
        assert_eq!(s.outflow("deposits"), amt("5"));
        assert_eq!(s.outflow("rewards"), ZERO);
        assert_eq!(s.total_outflow, amt("5"));
    }

    #[test]
    fn keeps_a_reward_outflow_in_rewards() {
        let reward = summarise(&[entry("reward.paid", "credit", "5")]);
        assert_eq!(reward.outflow("rewards"), amt("5"));
        assert_eq!(reward.outflow("deposits"), ZERO);
        let yield_paid = summarise(&[entry("token.yield.paid", "credit", "5")]);
        assert_eq!(yield_paid.outflow("rewards"), amt("5"));
        assert_eq!(yield_paid.outflow("deposits"), ZERO);
    }

    #[test]
    fn reports_an_empty_deposits_bucket_as_the_decimal_string_0() {
        let s = summarise(&[]);
        let out = spend_json(&s);
        assert_eq!(
            out.get("outflowByCategory").unwrap().compact(),
            r#"{"transfers":"0","trading":"0","p2p":"0","fees":"0","withdrawals":"0","earn":"0","deposits":"0","rewards":"0","other":"0"}"#
        );
    }

    // ledger-history.ts / ledger-client.ts: the wire entry.

    #[test]
    fn a_wire_entry_parses_its_amount_to_the_scaled_integer_and_a_malformed_one_fails_the_read() {
        let ok = json_of(
            r#"{"txId":"t1","module":"bank","reason":"bank.transfer.manual","direction":"debit","amount":"10.5","postedAt":"2026-01-02T00:00:00.000Z"}"#,
        );
        assert_eq!(
            entry_of(&ok).unwrap(),
            Entry {
                reason: "bank.transfer.manual".to_owned(),
                credit: false,
                amount: amt("10.5")
            }
        );
        assert!(
            entry_of(&json_of(
                r#"{"reason":"x","direction":"credit","amount":"ten"}"#
            ))
            .is_err()
        );
        assert!(entry_of(&json_of(r#"{"direction":"credit","amount":"1"}"#)).is_err());
        assert!(entry_of(&Json::Null).is_err());
    }

    fn json_of(s: &str) -> Json {
        service_kit::json::parse(s).unwrap()
    }

    // ledger-history.socket.test.ts and ledger-client.test.ts (`createLedgerHistory`): §13 socket honesty.

    use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
    use service_kit::s2s::CallSigner;
    use std::sync::{Arc, Mutex};

    type Sent = Arc<Mutex<Vec<(String, String)>>>;

    struct Ledger(u16, &'static str, Sent);

    impl Fetch for Ledger {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.2
                .lock()
                .unwrap()
                .push((req.url.clone(), req.body.clone().unwrap_or_default()));
            Ok(HttpResponse {
                status: self.0,
                body: self.1.to_owned(),
            })
        }
    }

    fn history(status: u16, body: &'static str) -> (LedgerHistory, Sent) {
        let sent = Sent::default();
        let http = LedgerHttp::new(
            "http://ledger.test/",
            CallSigner::new(
                "svc-bank",
                "svc-ledger",
                "a-test-internal-secret-long-enough",
                None,
            ),
            Box::new(Ledger(status, body, sent.clone())),
        );
        (LedgerHistory(http), sent)
    }

    fn january() -> (Instant, Instant) {
        month_range("2026-01").unwrap()
    }

    fn read(h: &LedgerHistory) -> Result<Vec<Entry>, String> {
        let (from, to) = january();
        h.entries_for(
            &LedgerAccount::user_available("11111111-1111-4111-8111-111111111111", "USDT"),
            from,
            to,
        )
    }

    #[test]
    fn throws_on_non_ok_and_never_returns_an_empty_spend_list() {
        let (h, sent) = history(
            404,
            r#"{"message":"procedure not found","code":"NOT_FOUND"}"#,
        );
        assert!(read(&h).is_err());
        // The adapter asked the ledger, once: a missing procedure is never retried.
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn throws_on_500_with_no_silent_empty_fallback() {
        let (h, _) = history(500, "ledger.history unavailable");
        assert!(read(&h).is_err());
    }

    #[test]
    fn entries_for_posts_to_trpc_history_and_parses_amounts_to_scaled_integers() {
        let (h, sent) = history(
            200,
            r#"[{"txId":"t1","module":"bank","reason":"bank.transfer.manual","direction":"debit","amount":"10.5","postedAt":"2026-01-02T00:00:00.000Z"}]"#,
        );
        assert_eq!(
            read(&h).unwrap(),
            vec![Entry {
                reason: "bank.transfer.manual".to_owned(),
                credit: false,
                amount: amt("10.5")
            }]
        );
        let sent = sent.lock().unwrap();
        assert_eq!(sent[0].0, "http://ledger.test/trpc/history");
        assert_eq!(
            sent[0].1,
            r#"{"account":{"ownerType":"user","ownerId":"11111111-1111-4111-8111-111111111111","assetId":"USDT","kind":"available"},"from":"2026-01-01T00:00:00.000Z","to":"2026-02-01T00:00:00.000Z"}"#
        );
    }

    // budgets.ts helpers.

    #[test]
    fn a_month_runs_from_its_first_instant_to_the_next_months_and_december_rolls_the_year() {
        let (from, to) = month_range("2026-12").unwrap();
        assert_eq!(from.iso(), "2026-12-01T00:00:00.000Z");
        assert_eq!(to.iso(), "2027-01-01T00:00:00.000Z");
        assert!(is_month("2026-01") && is_month("2026-12"));
        assert!(!is_month("2026-13") && !is_month("2026-00") && !is_month("x"));
        assert_eq!(period_of(from), "2026-12");
    }

    #[test]
    fn progress_is_floored_basis_points_and_a_change_is_signed() {
        assert_eq!(bps(amt("79.99"), amt("100")).unwrap(), 7_999);
        assert_eq!(bps(amt("80"), amt("100")).unwrap(), 8_000);
        assert_eq!(signed(amt("-2.5")), "-2.5");
        assert_eq!(signed(amt("80")), "80");
    }
}

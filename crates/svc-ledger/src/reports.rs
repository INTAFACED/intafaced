//! The `reports` slice: `statementPnl`, `reportExport`, `custody`, `financeClose` and `resilience`
//! (`s2s-http.ts`, and `ledger/statement-pnl*.ts`, `report-export.ts`, `custody-adapters.ts`, `finance-close.ts`,
//! `resilience-gate.ts`). None of them posts. Four are pure answers to their input; `statementPnl` reads the owner's
//! balances when no lots are sent, and still refuses: posted cash is not lots, marks or NAV. Each answer is the
//! TypeScript's, key for key: `tests/reports_parity.rs` holds them to what the TypeScript answered.
//!
//! The door parses each body with the door's recorded schema first (`schemas.json`), so every function here reads an
//! input zod has already passed.
//!
//! Amounts are the kit's `i128` at 18 places, where the TypeScript's are unbounded bigints. Custody's one difference
//! is worked exactly; a statement sum or product past `i128` (about 1.7e20 units) is refused as the ledger's fault,
//! never wrapped or saturated into a wrong figure.

use std::collections::BTreeSet;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, mul, parse_amount};
use service_kit::schema::Value;
use service_kit::time::js_date;

use crate::db::{Store, with_client};
use crate::errors::Failure;

/// The five doors, by their name in `LEDGER_DOOR_CALLERS`.
pub const DOORS: [&str; 5] = [
    "statementPnl",
    "reportExport",
    "custody",
    "financeClose",
    "resilience",
];

pub const STATEMENT_LOTS_MISSING: &str = "ledger.statement.lots_missing";
pub const STATEMENT_LOT_BASIS_MISSING: &str = "ledger.statement.lot_basis_missing";
pub const STATEMENT_MARK_MISSING: &str = "ledger.statement.mark_missing";
pub const STATEMENT_NAV_INPUTS_MISSING: &str = "ledger.statement.nav_inputs_missing";

pub const ADAPTER_IS_NOT_BOOK: &str = "ledger.custody.adapter_is_not_book";
pub const BREAK_AUTO_CLEAR_REFUSED: &str = "ledger.custody.break_auto_clear_refused";
pub const OFF_EXCHANGE_OWNER_UNSET: &str = "ledger.custody.off_exchange_owner_unset";
pub const CUSTODY_AMOUNTS_MISSING: &str = "ledger.custody.amounts_missing";
pub const CUSTODY_AGE_MISSING: &str = "ledger.custody.age_missing";
pub const CUSTODY_BREAK_ID_MISSING: &str = "ledger.custody.break_id_missing";

pub const CLIENT_CORPORATE_COMMINGLED: &str = "ledger.finance.client_corporate_commingled";
pub const OWNERS_UNNAMED: &str = "ledger.finance.owners_unnamed";
pub const RECIPES_INCOMPLETE: &str = "ledger.finance.recipes_incomplete";
pub const POR_MISLEADING: &str = "ledger.finance.por_misleading";
pub const RESERVE_INVENTED: &str = "ledger.finance.reserve_invented";

pub const DEGRADED_REFUSES_NEW_RISK: &str = "ledger.resilience.degraded_refuses_new_risk";
pub const SPLIT_BRAIN_MONEY: &str = "ledger.resilience.split_brain_money";
pub const SLO_OWNER_UNSET: &str = "ledger.resilience.slo_owner_unset";

/// The owner's balances, read as `LedgerService.balances` reads them, for the statement that is sent no lots.
pub type ReadBalances<'a> = &'a dyn Fn(&str, &str) -> Result<(), Failure>;

/// The answer of report door `door` to an input its schema passed, or the failure `httpError` answers.
pub fn answer(
    door: &str,
    input: &Value,
    now_ms: i64,
    read_balances: ReadBalances<'_>,
) -> Result<Json, Failure> {
    match door {
        "statementPnl" => statement_pnl(input, read_balances),
        "reportExport" => Ok(report_export(input)),
        "custody" => custody(input, now_ms),
        "financeClose" => Ok(finance_close(input)),
        "resilience" => Ok(resilience(input)),
        _ => Err(Failure::Fault),
    }
}

/// `postgres-ledger.ts` `balances`: every account of the owner, each balance read as a stored amount. The rows
/// themselves change nothing in the statement; a read that fails fails the call.
pub fn read_balances(store: &Store, owner_type: &str, owner_id: &str) -> Result<(), Failure> {
    let pool = store.pool().map_err(|_| Failure::Fault)?;
    let balances = with_client(pool, |c| {
        let rows = c.query(
            "SELECT balance::text
               FROM accounts
              WHERE owner_type = $1::text::owner_type AND owner_id = $2
              ORDER BY asset_id, kind, purpose",
            &[&owner_type, &owner_id],
        )?;
        rows.iter()
            .map(|r| r.try_get::<_, String>(0).map_err(Into::into))
            .collect::<Result<Vec<String>, crate::db::StoreError>>()
    })
    .map_err(|_| Failure::Fault)?;
    for b in &balances {
        amount(b)?;
    }
    Ok(())
}

// ── What the five share ────────────────────────────────────────────────────────────────────────────────────────────

/// `parseAmount`: a `MoneyError` is the ledger's fault.
fn amount(text: &str) -> Result<Amount, Failure> {
    parse_amount(text).map_err(|_| Failure::Fault)
}

fn add(a: Amount, b: Amount) -> Result<Amount, Failure> {
    a.checked_add(b).ok_or(Failure::Fault)
}

fn sub(a: Amount, b: Amount) -> Result<Amount, Failure> {
    a.checked_sub(b).ok_or(Failure::Fault)
}

/// `mul(a, b, 'half-up')`; the kit saturates past `i128`, which is refused here rather than answered.
fn times(a: Amount, b: Amount) -> Result<Amount, Failure> {
    let out = mul(a, b);
    if out == Amount::MAX || out == Amount::MIN {
        return Err(Failure::Fault);
    }
    Ok(out)
}

fn field<'v>(input: &'v Value, key: &str) -> &'v Value {
    input.get(key)
}

/// The field as a string, when it is one.
fn string<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    field(input, key).as_str()
}

/// `text(raw)`: the string trimmed, or none when it is absent, null or blank.
fn trimmed(v: &Value) -> Option<&str> {
    v.as_str()
        .map(service_kit::money::js_trim)
        .filter(|s| !s.is_empty())
}

fn text<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    trimmed(field(input, key))
}

/// `input.<key> === true`.
fn is_true(input: &Value, key: &str) -> bool {
    *field(input, key) == Value::Bool(true)
}

/// `input.<key> !== undefined && input.<key> !== null`.
fn is_set(input: &Value, key: &str) -> bool {
    !matches!(field(input, key), Value::Undefined | Value::Null)
}

fn list<'v>(input: &'v Value, key: &str) -> Option<&'v [Value]> {
    field(input, key).as_array()
}

fn strs<S: AsRef<str>>(items: &[S]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(s.as_ref())).collect())
}

fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// `refuseInventedCostBasis`'s test: FIFO or lots made from history, or a cost basis handed in, are not lots.
fn invents_cost_basis(fifo: bool, lots_from_history: bool, cost_basis: bool) -> bool {
    fifo || lots_from_history || cost_basis
}

// ── statementPnl ───────────────────────────────────────────────────────────────────────────────────────────────────

/// The keys `Object.prototype` gives every plain object: a lookup of one that the marks do not hold finds a
/// function, not `undefined`, so the TypeScript counts the mark as there and its `parseAmount` then throws.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
];

/// `marks[assetId]`.
enum Mark<'v> {
    Own(&'v str),
    Inherited,
    Missing,
}

fn mark<'v>(marks: &'v [(String, Value)], asset: &str) -> Mark<'v> {
    match marks.iter().rev().find(|(k, _)| k == asset) {
        Some((_, Value::String(s))) => Mark::Own(s),
        Some(_) => Mark::Inherited,
        None if OBJECT_PROTOTYPE.contains(&asset) => Mark::Inherited,
        None => Mark::Missing,
    }
}

fn owner_fields(input: &Value) -> Vec<(&'static str, Json)> {
    ["ownerType", "ownerId", "reportingAssetId"]
        .into_iter()
        .map(|k| (k, Json::str(string(input, k).unwrap_or_default())))
        .collect()
}

fn statement(input: &Value, status: &str, codes: &[&str], figures: [Json; 3]) -> Json {
    let mut out = owner_fields(input);
    let [realized, unrealized, nav] = figures;
    out.extend([
        ("status", Json::str(status)),
        ("codes", strs(codes)),
        ("realized", realized),
        ("unrealized", unrealized),
        ("nav", nav),
    ]);
    obj(out)
}

fn statement_refused(input: &Value, codes: &[&str]) -> Json {
    statement(
        input,
        "refused",
        codes,
        [Json::Null, Json::Null, Json::Null],
    )
}

/// What this book refuses for: no lots, no marks, no NAV inputs (sorted, as `composeStatementPnl` sorts).
const BOOK_MISSING: [&str; 3] = [
    STATEMENT_LOTS_MISSING,
    STATEMENT_MARK_MISSING,
    STATEMENT_NAV_INPUTS_MISSING,
];

/// `handleStatementPnlHappyOrRefuse`.
fn statement_pnl(input: &Value, read_balances: ReadBalances<'_>) -> Result<Json, Failure> {
    if invents_cost_basis(
        is_true(input, "inventFifoFromHistory"),
        is_true(input, "lotsFromHistory"),
        is_set(input, "costBasis"),
    ) {
        return Ok(statement_refused(input, &BOOK_MISSING));
    }
    let lots = field(input, "lots");
    if *lots == Value::Undefined {
        // `handleStatementPnlFromBook`: the owner's posted balances are read, and are not lots, marks or NAV.
        read_balances(
            string(input, "ownerType").unwrap_or_default(),
            string(input, "ownerId").unwrap_or_default(),
        )?;
        return Ok(statement_refused(input, &BOOK_MISSING));
    }
    compose(input, lots)
}

/// `composeStatementPnl` over the lots, marks and NAV inputs sent.
fn compose(input: &Value, lots: &Value) -> Result<Json, Failure> {
    let closed = list(lots, "closed").unwrap_or_default();
    let open = list(lots, "open").unwrap_or_default();
    let marks = match field(input, "marks") {
        Value::Object(m) => Some(m.as_slice()),
        _ => None,
    };
    let nav_inputs = field(input, "navInputs");

    let mut codes = BTreeSet::new();
    if *nav_inputs == Value::Undefined {
        codes.insert(STATEMENT_NAV_INPUTS_MISSING);
    }
    for lot in closed {
        if *field(lot, "costBasis") == Value::Null || *field(lot, "proceeds") == Value::Null {
            codes.insert(STATEMENT_LOT_BASIS_MISSING);
        }
    }
    for lot in open {
        if *field(lot, "costBasis") == Value::Null {
            codes.insert(STATEMENT_LOT_BASIS_MISSING);
        }
    }
    if !open.is_empty() {
        match marks {
            None => {
                codes.insert(STATEMENT_MARK_MISSING);
            }
            Some(m) => {
                for lot in open {
                    if matches!(
                        mark(m, string(lot, "assetId").unwrap_or_default()),
                        Mark::Missing
                    ) {
                        codes.insert(STATEMENT_MARK_MISSING);
                    }
                }
            }
        }
    }
    if !codes.is_empty() {
        let codes: Vec<&str> = codes.into_iter().collect();
        return Ok(statement_refused(input, &codes));
    }

    let cash = amount(string(nav_inputs, "cashReporting").unwrap_or_default())?;
    if closed.is_empty() && open.is_empty() {
        return Ok(statement(
            input,
            "empty",
            &[],
            [Json::Null, Json::Null, Json::str(format_amount(cash))],
        ));
    }

    let mut realized: Amount = 0;
    for lot in closed {
        let proceeds = amount(string(lot, "proceeds").unwrap_or_default())?;
        let basis = amount(string(lot, "costBasis").unwrap_or_default())?;
        realized = add(realized, sub(proceeds, basis)?)?;
    }
    let mut unrealized: Amount = 0;
    let mut marked_open: Amount = 0;
    for lot in open {
        let qty = amount(string(lot, "qtyRemaining").unwrap_or_default())?;
        let price = match mark(
            marks.unwrap_or_default(),
            string(lot, "assetId").unwrap_or_default(),
        ) {
            Mark::Own(p) => amount(p)?,
            // `parseAmount` of a function or an object: a `MoneyError`.
            Mark::Inherited | Mark::Missing => return Err(Failure::Fault),
        };
        let value = times(qty, price)?;
        marked_open = add(marked_open, value)?;
        let basis = amount(string(lot, "costBasis").unwrap_or_default())?;
        unrealized = add(unrealized, sub(value, basis)?)?;
    }
    Ok(statement(
        input,
        "ok",
        &[],
        [
            Json::str(format_amount(realized)),
            Json::str(format_amount(unrealized)),
            Json::str(format_amount(add(cash, marked_open)?)),
        ],
    ))
}

// ── reportExport ───────────────────────────────────────────────────────────────────────────────────────────────────

fn required(kind: &str) -> &'static [&'static str] {
    match kind {
        "nav" => &["ownerId", "reportingPeriod"],
        "sftp" => &["ownerId", "legalEntityId", "reportingPeriod"],
        _ => &["ownerId", "legalEntityId", "regulatorId", "reportingPeriod"],
    }
}

fn export_refused(
    kind: &str,
    reason: &str,
    missing: &[&str],
    included: &[&str],
    detail: &str,
) -> Json {
    obj(vec![
        ("ok", Json::Bool(false)),
        ("reason", Json::str(reason)),
        ("kind", Json::str(kind)),
        ("complete", Json::Bool(false)),
        ("missing", strs(missing)),
        ("included", strs(included)),
        ("detail", Json::str(detail)),
    ])
}

fn any_lot(input: &Value) -> bool {
    list(input, "lotIds").is_some_and(|ids| ids.iter().any(|id| trimmed(id).is_some()))
}

/// `refuseIncompleteReportExport`.
fn report_export(input: &Value) -> Json {
    let kind = string(input, "kind").unwrap_or_default();
    let complete = is_true(input, "complete");
    let mut included: Vec<&str> = [
        "ownerId",
        "accountId",
        "legalEntityId",
        "regulatorId",
        "reportingPeriod",
    ]
    .into_iter()
    .filter(|k| text(input, k).is_some())
    .collect();
    if any_lot(input) {
        included.push("lotIds");
    }
    if invents_cost_basis(
        is_true(input, "inventFifoFromHistory") || is_true(input, "inventCostBasis"),
        is_true(input, "lotsFromHistory"),
        is_set(input, "costBasis"),
    ) {
        return export_refused(
            kind,
            "cost_basis_invented",
            &[],
            &included,
            "export will not invent cost basis from history or a bare number",
        );
    }
    let missing: Vec<&str> = required(kind)
        .iter()
        .copied()
        .filter(|k| text(input, k).is_none())
        .collect();
    // A regulator export is a ship: its ids refuse even when `complete` is not exactly true.
    let ids_required = complete || kind == "regulator";
    let claim = if complete {
        format!("complete {kind}")
    } else {
        kind.to_owned()
    };
    if ids_required && !missing.is_empty() {
        return export_refused(
            kind,
            "completeness_ids_missing",
            &missing,
            &included,
            &format!("{claim} export refuses — missing {}", missing.join(",")),
        );
    }
    if ids_required && !any_lot(input) {
        return export_refused(
            kind,
            STATEMENT_LOTS_MISSING,
            &["lotIds"],
            &included,
            &format!(
                "{} export refuses — lots are missing, cost basis is not invented",
                if complete { "complete" } else { kind }
            ),
        );
    }
    obj(vec![
        ("ok", Json::Bool(true)),
        ("kind", Json::str(kind)),
        ("complete", Json::Bool(complete)),
        ("included", strs(&included)),
    ])
}

// ── custody ────────────────────────────────────────────────────────────────────────────────────────────────────────

fn custody_refused(
    kind: &str,
    reason: &str,
    detail: &str,
    age_ms: Option<i64>,
    break_id: Option<&str>,
) -> Json {
    let mut out = vec![
        ("ok", Json::Bool(false)),
        ("reason", Json::str(reason)),
        ("kind", Json::str(kind)),
        ("role", Json::str("adapter")),
        ("detail", Json::str(detail)),
    ];
    if let Some(age) = age_ms {
        out.push(("ageMs", Json::int(age)));
    }
    if let Some(id) = break_id {
        out.push(("breakId", Json::str(id)));
    }
    obj(out)
}

/// `refuseCustodyProduct`. `now_ms` is `Date.now()`.
fn custody(input: &Value, now_ms: i64) -> Result<Json, Failure> {
    let kind = string(input, "kind").unwrap_or_default();
    if kind == "off_exchange" && !is_true(input, "ownerAuthorized") {
        return Ok(custody_refused(
            kind,
            OFF_EXCHANGE_OWNER_UNSET,
            "off-exchange custody is OWNER — product refuses until authorized",
            None,
            None,
        ));
    }
    if kind == "chain" || kind == "fiat" {
        if is_true(input, "treatAsBook") || string(input, "role") == Some("book") {
            return Ok(custody_refused(
                kind,
                ADAPTER_IS_NOT_BOOK,
                &format!("{kind} adapter is not the book"),
                None,
                None,
            ));
        }
        let Some(adapter) = string(input, "adapterAmount").filter(|a| !a.is_empty()) else {
            return Ok(custody_refused(
                kind,
                CUSTODY_AMOUNTS_MISSING,
                "adapter observation is missing, not 0",
                None,
                None,
            ));
        };
        return Ok(obj(vec![
            ("ok", Json::Bool(true)),
            ("kind", Json::str(kind)),
            ("role", Json::str("adapter")),
            ("observed", Json::str(format_amount(amount(adapter)?))),
        ]));
    }
    if kind == "off_exchange" {
        return Ok(obj(vec![
            ("ok", Json::Bool(true)),
            ("kind", Json::str("off_exchange")),
            ("role", Json::str("adapter")),
            ("ownerAuthorized", Json::Bool(true)),
        ]));
    }

    // A break.
    let break_id = text(input, "breakId");
    let age_ms = string(input, "firstSeenAt")
        .filter(|s| !s.is_empty())
        .and_then(js_date)
        .map(|start| now_ms - start.0)
        .filter(|age| *age >= 0);
    let Some(age_ms) = age_ms else {
        return Ok(custody_refused(
            "break",
            CUSTODY_AGE_MISSING,
            "break age is missing, not reported as new",
            None,
            break_id,
        ));
    };
    let adapter = string(input, "adapterAmount").filter(|a| !a.is_empty());
    let book = string(input, "bookAmount").filter(|a| !a.is_empty());
    let (Some(adapter), Some(book)) = (adapter, book) else {
        return Ok(custody_refused(
            "break",
            CUSTODY_AMOUNTS_MISSING,
            "break amounts are missing, not healed to 0",
            Some(age_ms),
            break_id,
        ));
    };
    let adapter = amount(adapter)?;
    let difference = difference(adapter, amount(book)?);
    let Some(break_id) = break_id else {
        return Ok(custody_refused(
            "break",
            CUSTODY_BREAK_ID_MISSING,
            "break id is missing, not invented",
            None,
            None,
        ));
    };
    if is_true(input, "autoClear") || string(input, "resolve") == Some("auto") {
        return Ok(custody_refused(
            "break",
            BREAK_AUTO_CLEAR_REFUSED,
            "breaks age and never auto-disappear",
            Some(age_ms),
            Some(break_id),
        ));
    }
    let status = if string(input, "resolve") == Some("operator") {
        "resolved"
    } else {
        "open"
    };
    Ok(obj(vec![
        ("ok", Json::Bool(true)),
        ("kind", Json::str("break")),
        ("role", Json::str("adapter")),
        ("status", Json::str(status)),
        ("ageMs", Json::int(age_ms)),
        ("breakId", Json::str(break_id)),
        ("difference", Json::str(difference)),
    ]))
}

/// `formatAmount(adapter - book)`, exact: two amounts inside `numeric(38,18)` differ by at most twice its largest,
/// which `i128` may not hold but its magnitude does.
fn difference(adapter: Amount, book: Amount) -> String {
    if let Some(d) = adapter.checked_sub(book) {
        return format_amount(d);
    }
    // Only opposite signs overflow, so the magnitude is the two magnitudes summed.
    let magnitude = adapter.unsigned_abs() + book.unsigned_abs();
    let scale = 1_000_000_000_000_000_000_u128;
    let (whole, frac) = (magnitude / scale, magnitude % scale);
    let sign = if adapter < book { "-" } else { "" };
    if frac == 0 {
        return format!("{sign}{whole}");
    }
    let frac = format!("{frac:018}");
    format!("{sign}{whole}.{}", frac.trim_end_matches('0'))
}

// ── financeClose ───────────────────────────────────────────────────────────────────────────────────────────────────

const CLOSE_RECIPES: [&str; 2] = ["clientBalances", "corporateBalances"];

fn finance_refused(
    kind: &str,
    reason: &str,
    missing: &[&str],
    included: &[&str],
    detail: &str,
) -> Json {
    obj(vec![
        ("ok", Json::Bool(false)),
        ("reason", Json::str(reason)),
        ("kind", Json::str(kind)),
        ("missing", strs(missing)),
        ("included", strs(included)),
        ("detail", Json::str(detail)),
    ])
}

fn unnamed(client: Option<&str>, corporate: Option<&str>) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if client.is_none() {
        missing.push("clientOwnerId");
    }
    if corporate.is_none() {
        missing.push("corporateOwnerId");
    }
    missing
}

/// `refuseIncompleteFinance`.
fn finance_close(input: &Value) -> Json {
    let kind = string(input, "kind").unwrap_or_default();
    let recipes: Vec<&str> = list(input, "recipes")
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let mut included: Vec<&str> = [
        "clientOwnerId",
        "corporateOwnerId",
        "periodId",
        "reserveRecipeId",
    ]
    .into_iter()
    .filter(|k| text(input, k).is_some())
    .collect();
    for recipe in &recipes {
        if !service_kit::money::js_trim(recipe).is_empty() && !included.contains(recipe) {
            included.push(recipe);
        }
    }
    let client = text(input, "clientOwnerId");
    let corporate = text(input, "corporateOwnerId");

    if is_true(input, "inventReserve")
        || (is_set(input, "reserveAmount") && text(input, "reserveRecipeId").is_none())
    {
        return finance_refused(
            kind,
            RESERVE_INVENTED,
            &["reserveRecipeId"],
            &included,
            "finance will not invent a reserve",
        );
    }
    if is_true(input, "commingle") || (client.is_some() && client == corporate) {
        return finance_refused(
            kind,
            CLIENT_CORPORATE_COMMINGLED,
            &[],
            &included,
            "client and corporate assets stay distinct",
        );
    }
    let claiming = is_true(input, "complete")
        || kind == "close"
        || kind == "por"
        || is_true(input, "claimFullyReserved");
    let not_named = "client and corporate owners were not named";
    if kind == "segregation" && (client.is_none() || corporate.is_none()) {
        return finance_refused(
            kind,
            OWNERS_UNNAMED,
            &unnamed(client, corporate),
            &included,
            not_named,
        );
    }
    if claiming {
        let mut missing = unnamed(client, corporate);
        if kind != "segregation" && text(input, "periodId").is_none() {
            missing.push("periodId");
        }
        let named: BTreeSet<&str> = recipes
            .iter()
            .map(|r| service_kit::money::js_trim(r))
            .filter(|r| !r.is_empty())
            .collect();
        missing.extend(CLOSE_RECIPES.iter().filter(|r| !named.contains(*r)));
        if !missing.is_empty() {
            return finance_refused(
                kind,
                RECIPES_INCOMPLETE,
                &missing,
                &included,
                &format!("finance {kind} refuses — recipes incomplete"),
            );
        }
    }
    if kind == "por" && is_true(input, "claimFullyReserved") {
        return finance_refused(
            "por",
            POR_MISLEADING,
            &["reserveRecipeId"],
            &included,
            "PoR will not claim fully reserved without an owner reserve recipe",
        );
    }
    let (Some(client), Some(corporate)) = (client, corporate) else {
        return finance_refused(
            kind,
            OWNERS_UNNAMED,
            &unnamed(client, corporate),
            &included,
            not_named,
        );
    };
    obj(vec![
        ("ok", Json::Bool(true)),
        ("kind", Json::str(kind)),
        ("complete", Json::Bool(is_true(input, "complete"))),
        ("clientOwnerId", Json::str(client)),
        ("corporateOwnerId", Json::str(corporate)),
        ("included", strs(&included)),
    ])
}

// ── resilience ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// `namedSet`'s size: the trimmed, non-blank, distinct values.
fn named(input: &Value, key: &str) -> usize {
    list(input, key)
        .unwrap_or_default()
        .iter()
        .filter_map(trimmed)
        .collect::<BTreeSet<&str>>()
        .len()
}

/// `refuseResilienceRisk`.
fn resilience(input: &Value) -> Json {
    let kind = string(input, "kind").unwrap_or_default();
    let metrics = obj(vec![
        (
            "observedCount",
            Json::str(text(input, "observedCount").unwrap_or("0")),
        ),
        (
            "observedLatencyMs",
            text(input, "observedLatencyMs").map_or(Json::Null, Json::str),
        ),
    ]);
    let refused = |kind: &str, reason: &str, detail: &str| {
        obj(vec![
            ("ok", Json::Bool(false)),
            ("reason", Json::str(reason)),
            ("kind", Json::str(kind)),
            ("posted", Json::Bool(false)),
            ("detail", Json::str(detail)),
            ("metrics", metrics.clone()),
        ])
    };
    if is_true(input, "splitBrain")
        || named(input, "writers") > 1
        || named(input, "sourcesOfTruth") > 1
    {
        return refused(
            kind,
            SPLIT_BRAIN_MONEY,
            "split-brain money is impossible — one writer, one book",
        );
    }
    if kind == "slo" && !is_true(input, "ownerSloSet") {
        return refused(
            kind,
            SLO_OWNER_UNSET,
            "SLO numbers are OWNER — raw metrics still emit",
        );
    }
    let status = string(input, "dependencyStatus");
    let accept = is_true(input, "acceptNewRisk");
    let degraded = matches!(status, Some("degraded" | "down"))
        || (kind == "risk" && status != Some("ok") && accept);
    // The TypeScript's later check (`risk`, not `ok`, accepting) is this one's case again, so it is never reached.
    if degraded && *field(input, "acceptNewRisk") != Value::Bool(false) {
        return refused(
            if kind == "slo" { "risk" } else { kind },
            DEGRADED_REFUSES_NEW_RISK,
            &format!(
                "degraded {} refuses new risk",
                text(input, "dependency").unwrap_or("dependency")
            ),
        );
    }
    obj(vec![
        ("ok", Json::Bool(true)),
        ("kind", Json::str(kind)),
        ("posted", Json::Bool(false)),
        (
            "acceptedNewRisk",
            Json::Bool(accept && status == Some("ok")),
        ),
        ("metrics", metrics),
    ])
}

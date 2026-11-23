//! `BusinessBooksService` (`business/business-books.ts`): a business keeps its books in order (J-bank-23 #1 #2 #3;
//! BK-bexp-03, BK-bexp-04, BK-bexp-05).
//!
//! The business's money and every line of it are the partner bank's: a line here is one line of the partner's own
//! record for the business's account, `business:<account id>`, named by the partner's reference. svc-bank keeps only
//! the business's bookkeeping about those lines. Nothing here moves money or posts to the ledger.
//!
//! - accounting: connecting accounting software needs `vendor.accounting`, switched off in this build; asking keeps the
//!   connection's record and connects nothing. The bank feed by file (the CSV statement) works instead;
//! - coding: a rule "payee contains <text> sets <category>" (and a GL code) is tried before it is saved; saved, it codes
//!   every line not yet coded that matches, on the next read. A person codes one line or many; a rule never overwrites
//!   a person's code;
//! - statements: CSV, MT940, CAMT.053 or QIF, each checked against the partner's own statement of the same period
//!   (line count, and opening plus lines is the closing) or refused `bank.statement_mismatch`. The partner's history
//!   window bounds the period; a period reaching back past its strong customer authentication age needs a fresh
//!   confirmation, `confirm`.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use postgres::Row;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::formats::{self, BookLine, BookStatement};
use crate::activity::analytics::partner_moves_between;
use crate::business_team::service::{Seat, partner_account, seat};
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::partner::{
    FEES_OWNER, HISTORY_DAYS, LABEL, MERCHANT, Move, PAY_INS_OWNER, PAYOUTS_OWNER, SCA_AFTER_DAYS,
    refuse,
};
use crate::spaces::space::{in_tx, pg, with};
use crate::transfers::Deps;

/// `ACCOUNTING_VENDOR_CODE`.
pub const ACCOUNTING_VENDOR_CODE: &str = "vendor.accounting";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_SPAN_MS: i64 = 366 * DAY_MS;
const MAX_BULK: usize = 200;

/// `cardCaptureKey` (`business/business-cards.ts`): the business key of a card purchase's capture at the partner.
fn card_capture_key(purchase_id: &str) -> String {
    format!("bank.business.card-capture:{purchase_id}")
}

/// A period: `[from, to)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub from: Instant,
    pub to: Instant,
}

/// `BookLineView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineView {
    pub line: BookLine,
    pub partner_key: String,
    pub coded_by: Option<String>,
    pub rule_id: Option<String>,
}

impl LineView {
    /// `lineView`, in `businessBookLineSchema`'s order.
    pub fn json(&self) -> Json {
        let l = &self.line;
        Json::obj([
            ("id", Json::str(l.id.clone())),
            ("bookedAt", Json::str(l.booked_at.iso())),
            ("amount", Json::str(format_amount(l.amount))),
            ("payee", Json::str(l.payee.clone())),
            ("partnerKey", Json::str(self.partner_key.clone())),
            ("category", opt(l.category.as_deref())),
            ("glCode", opt(l.gl_code.as_deref())),
            ("codedBy", opt(self.coded_by.as_deref())),
            ("ruleId", opt(self.rule_id.as_deref())),
        ])
    }
}

/// `{ items }` or `{ matches }`: a list of lines.
pub fn lines_json(key: &'static str, lines: &[LineView]) -> Json {
    Json::obj([(key, Json::Array(lines.iter().map(LineView::json).collect()))])
}

fn opt(s: Option<&str>) -> Json {
    s.map_or(Json::Null, Json::str)
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn get_s(r: &Row, i: usize) -> Result<String, Refusal> {
    r.try_get::<_, String>(i).map_err(|e| pg(&e))
}

fn get_o(r: &Row, i: usize) -> Result<Option<String>, Refusal> {
    r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e))
}

fn get_t(r: &Row, i: usize) -> Result<Instant, Refusal> {
    Ok(Instant(r.try_get::<_, i64>(i).map_err(|e| pg(&e))?))
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals

fn invalid(message: &str) -> Refusal {
    refuse("bank.business_books_field_invalid", message)
}

fn no_partner() -> Refusal {
    refuse(
        "bank.no_partner_bank",
        "This business\u{2019}s money is not held at a partner bank, so it has no statement.",
    )
}

/// `need`: the caller's role holds `permission`, or `bank.business_role_forbidden`.
fn need(seat: &Seat<'_>, permission: &str) -> Result<(), Refusal> {
    if seat.holds(permission) {
        return Ok(());
    }
    Err(refuse(
        "bank.business_role_forbidden",
        format!(
            "Your role on this business does not include {}, so this was refused. Nothing changed.",
            permission.replacen('_', " ", 1)
        ),
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// Text checks

/// `/^[^\p{Cc}]{1,<max>}$/u`: 1 to `max` code points, none a control character.
fn plain_text(s: &str, max: usize) -> bool {
    let n = s.chars().count();
    (1..=max).contains(&n) && !s.chars().any(char::is_control)
}

/// `GL_RE`: `/^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,31}$/`.
fn gl_shape(s: &str) -> bool {
    let b = s.as_bytes();
    let Some((first, rest)) = b.split_first() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && rest.len() <= 31
        && rest
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b" .-/".contains(c))
}

/// `coding`: a category, a GL code or both; blank text is none.
fn coding(
    category: Option<&str>,
    gl_code: Option<&str>,
) -> Result<(Option<String>, Option<String>), Refusal> {
    let category = category.map(js_trim).filter(|c| !c.is_empty());
    let gl_code = gl_code.map(js_trim).filter(|g| !g.is_empty());
    if category.is_some_and(|c| !plain_text(c, 60)) {
        return Err(invalid("A category is 1 to 60 characters."));
    }
    if gl_code.is_some_and(|g| !gl_shape(g)) {
        return Err(invalid(
            "A GL code is 1 to 32 letters, digits, spaces, dots, dashes or slashes.",
        ));
    }
    Ok((category.map(str::to_owned), gl_code.map(str::to_owned)))
}

/// `payeeText`.
fn payee_text(raw: &str) -> Result<String, Refusal> {
    let text = js_trim(raw);
    if !plain_text(text, 80) {
        return Err(invalid("A payee text is 1 to 80 characters."));
    }
    Ok(text.to_owned())
}

/// `matches`: the payee contains the text, either case.
fn matches(payee: &str, contains: &str) -> bool {
    payee.to_lowercase().contains(&contains.to_lowercase())
}

fn partner_of<'a>(seat: &'a Seat<'_>) -> Result<&'a Held<'a>, Refusal> {
    seat.partner.as_ref().ok_or_else(no_partner)
}

/// `checkRange`: the period starts before it ends, spans at most 366 days and starts inside the partner's history
/// window; with `sca`, whether it reaches back past the partner's strong customer authentication age. The TEST
/// partner, the only one this crate holds, always declares its window.
fn check_range(range: Range, now: Instant, sca: bool) -> Result<bool, Refusal> {
    let (from, to) = (range.from.0, range.to.0);
    if from >= to {
        return Err(refuse(
            "bank.statement_range",
            "The period\u{2019}s end is not after its start.",
        ));
    }
    if to - from > MAX_SPAN_MS {
        return Err(refuse(
            "bank.statement_range",
            "A statement covers at most 366 days.",
        ));
    }
    let earliest = now.0 - HISTORY_DAYS * DAY_MS;
    if from < earliest {
        return Err(refuse(
            "bank.statement_history_window",
            format!(
                "{LABEL} keeps {HISTORY_DAYS} days of history, from {}. Choose a later start.",
                Instant(earliest).iso().get(..10).unwrap_or_default()
            ),
        ));
    }
    Ok(sca && from < now.0 - SCA_AFTER_DAYS * DAY_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

const RULE_COLS: &str = "id::text, account_id::text, payee_contains, category, gl_code, \
     floor(extract(epoch from created_at) * 1000)::int8";

struct RuleRow {
    id: String,
    account_id: String,
    payee_contains: String,
    category: String,
    gl_code: Option<String>,
    created_at: Instant,
}

impl RuleRow {
    fn of(r: &Row) -> Result<RuleRow, Refusal> {
        Ok(RuleRow {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            payee_contains: get_s(r, 2)?,
            category: get_s(r, 3)?,
            gl_code: get_o(r, 4)?,
            created_at: get_t(r, 5)?,
        })
    }

    /// `ruleView`, in `businessCodingRuleSchema`'s order.
    fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("payeeContains", Json::str(self.payee_contains.clone())),
            ("category", Json::str(self.category.clone())),
            ("glCode", opt(self.gl_code.as_deref())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

struct CodeRow {
    category: Option<String>,
    gl_code: Option<String>,
    coded_by: String,
    rule_id: Option<String>,
}

const CODE_COLS: &str = "line_id, category, gl_code, coded_by, rule_id::text";

fn code_of(r: &Row) -> Result<(String, CodeRow), Refusal> {
    Ok((
        get_s(r, 0)?,
        CodeRow {
            category: get_o(r, 1)?,
            gl_code: get_o(r, 2)?,
            coded_by: get_s(r, 3)?,
            rule_id: get_o(r, 4)?,
        },
    ))
}

/// `connectionView`, in `businessAccountingConnectionSchema`'s order.
fn connection_json(r: &Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("status", Json::str(get_s(r, 0)?)),
        ("needs", Json::str(ACCOUNTING_VENDOR_CODE)),
        ("requestedBy", Json::str(get_s(r, 1)?)),
        ("requestedAt", Json::str(get_t(r, 2)?.iso())),
        (
            "attempts",
            Json::int(i64::from(r.try_get::<_, i32>(3).map_err(|e| pg(&e))?)),
        ),
    ]))
}

fn connection_cols() -> String {
    format!("status, requested_by, {}, attempts", ms("requested_at"))
}

fn rules_of(d: &Deps<'_>, account_id: &str) -> Result<Vec<RuleRow>, Refusal> {
    with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {RULE_COLS} FROM bank.business_coding_rules WHERE account_id = $1::text::uuid \
                 ORDER BY created_at, id LIMIT 200"
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(RuleRow::of)
        .collect()
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The calls

/// `overview`.
pub fn overview(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "view")?;
    let connection = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.business_accounting_connections WHERE account_id = $1::text::uuid",
                connection_cols()
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(connection_json)
        .transpose()
    })?;
    let rules = rules_of(d, account_id)?;
    let partner = seat.partner.as_ref();
    Ok(Json::obj([
        (
            "account",
            Json::obj([
                ("id", Json::str(seat.account.id.clone())),
                ("name", Json::str(seat.account.name.clone())),
                ("assetId", Json::str(seat.account.asset_id.clone())),
            ]),
        ),
        (
            "permissions",
            Json::Array(seat.permissions.iter().map(|p| Json::str(*p)).collect()),
        ),
        ("connection", connection.unwrap_or(Json::Null)),
        (
            "rules",
            Json::Array(rules.iter().map(RuleRow::json).collect()),
        ),
        (
            "partnerLabel",
            partner.map_or(Json::Null, |p| Json::str(p.label())),
        ),
        (
            "historyRules",
            partner.map_or(Json::Null, |p| {
                Json::obj([
                    ("label", Json::str(p.label())),
                    ("historyDays", Json::int(HISTORY_DAYS)),
                    ("scaAfterDays", Json::int(SCA_AFTER_DAYS)),
                ])
            }),
        ),
    ]))
}

/// `connectAccounting`: switched off in this build, so the record is kept and nothing is connected.
pub fn connect_accounting(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "manage_team")?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.business_accounting_connections (account_id, status, needs, requested_by) \
                     VALUES ($1::text::uuid, 'switched_off', $2, $3) \
                     ON CONFLICT (account_id) DO UPDATE SET attempts = bank.business_accounting_connections.attempts + 1, \
                       requested_by = EXCLUDED.requested_by, requested_at = now() \
                     RETURNING {}",
                    connection_cols()
                ),
                &[&account_id, &ACCOUNTING_VENDOR_CODE, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(connection_json)
            .ok_or_else(|| Refusal::Other("business_accounting_connections: no row".to_owned()))?
    })
}

/// `lines`: the partner's lines in `[from, to)`, oldest first, each with its coding; a line no person has coded that a
/// saved rule matches is coded by that rule now (the oldest rule wins), and stays coded.
pub fn lines(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    range: Range,
) -> Result<Vec<LineView>, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "view")?;
    let partner = partner_of(&seat)?;
    check_range(range, d.now, false)?;
    coded_lines(d, account_id, &seat.account.asset_id, partner, range, true)
}

/// `testRule`: every line in the range whose payee contains the text. Changes nothing.
pub fn test_rule(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    range: Range,
    payee_contains: &str,
) -> Result<Vec<LineView>, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "export")?;
    let contains = payee_text(payee_contains)?;
    let partner = partner_of(&seat)?;
    check_range(range, d.now, false)?;
    Ok(
        coded_lines(d, account_id, &seat.account.asset_id, partner, range, false)?
            .into_iter()
            .filter(|l| matches(&l.line.payee, &contains))
            .collect(),
    )
}

/// What `saveRule` asks.
pub struct RuleAsk<'a> {
    pub rule_id: &'a str,
    pub payee_contains: &'a str,
    pub category: &'a str,
    pub gl_code: Option<&'a str>,
}

/// `saveRule`: the same id on the same terms is the same rule; it codes matching lines on their next read.
pub fn save_rule(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    ask: &RuleAsk<'_>,
) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "export")?;
    let contains = payee_text(ask.payee_contains)?;
    let (category, gl_code) = coding(Some(ask.category), ask.gl_code)?;
    let Some(category) = category else {
        return Err(invalid("A rule sets a category."));
    };
    let row = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.business_coding_rules (id, account_id, payee_contains, category, gl_code, created_by) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6) \
                     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING {RULE_COLS}"
                ),
                &[&ask.rule_id, &account_id, &contains, &category, &gl_code, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(RuleRow::of)
            .ok_or_else(|| Refusal::Other("business_coding_rules: no row".to_owned()))?
    })?;
    if row.account_id != account_id
        || row.payee_contains != contains
        || row.category != category
        || row.gl_code != gl_code
    {
        return Err(refuse(
            "bank.business_request_conflict",
            "This rule id is already used on different terms.",
        ));
    }
    Ok(row.json())
}

/// What `codeLines` asks.
pub struct CodeAsk<'a> {
    pub range: Range,
    pub line_ids: &'a [String],
    pub category: Option<&'a str>,
    pub gl_code: Option<&'a str>,
}

/// `codeLines`: a person codes one line or many at once; each must be a line of the partner's record for this
/// business in the range. A person's code replaces any code a rule gave.
pub fn code_lines(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    ask: &CodeAsk<'_>,
) -> Result<Vec<LineView>, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "export")?;
    let mut ids: Vec<&str> = Vec::new();
    for id in ask.line_ids {
        if !ids.contains(&id.as_str()) {
            ids.push(id);
        }
    }
    if ids.is_empty() || ids.len() > MAX_BULK {
        return Err(invalid(&format!("Code 1 to {MAX_BULK} lines at once.")));
    }
    let (category, gl_code) = coding(ask.category, ask.gl_code)?;
    if category.is_none() && gl_code.is_none() {
        return Err(invalid("Give a category, a GL code or both."));
    }
    let partner = partner_of(&seat)?;
    check_range(ask.range, d.now, false)?;
    let asset = &seat.account.asset_id;
    let known: BTreeSet<String> = coded_lines(d, account_id, asset, partner, ask.range, false)?
        .into_iter()
        .map(|l| l.line.id)
        .collect();
    if let Some(unknown) = ids.iter().find(|id| !known.contains(**id)) {
        return Err(refuse(
            "bank.business_line_not_found",
            format!(
                "No line {unknown} is on this business\u{2019}s statement for the period. Nothing was coded."
            ),
        ));
    }
    in_tx(d.store, |tx| {
        for id in &ids {
            tx.execute(
                "INSERT INTO bank.business_line_codes (account_id, line_id, category, gl_code, coded_by, coded_by_user) \
                 VALUES ($1::text::uuid, $2, $3, $4, 'person', $5) \
                 ON CONFLICT (account_id, line_id) DO UPDATE SET category = EXCLUDED.category, gl_code = EXCLUDED.gl_code, \
                   coded_by = 'person', rule_id = NULL, coded_by_user = EXCLUDED.coded_by_user, coded_at = now()",
                &[&account_id, id, &category, &gl_code, &user_id],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    Ok(
        coded_lines(d, account_id, asset, partner, ask.range, false)?
            .into_iter()
            .filter(|l| ids.contains(&l.line.id.as_str()))
            .collect(),
    )
}

/// `exportStatement`: one period's statement in one format, checked against the partner's own statement of that
/// period first. `confirm` runs before any line is read when the period needs a fresh strong customer authentication.
pub fn export_statement(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    range: Range,
    format: &str,
    confirm: impl FnOnce() -> Result<(), Refusal>,
) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat, "export")?;
    let partner = partner_of(&seat)?;
    if check_range(range, d.now, true)? {
        confirm()?;
    }
    let asset = &seat.account.asset_id;
    let lines = coded_lines(d, account_id, asset, partner, range, true)?;
    let theirs = partner.statement(
        &partner_account(account_id, asset),
        range.from,
        range.to,
        d.now,
    )?;
    let net: Amount = lines.iter().map(|l| l.line.amount).sum();
    let count = u64::try_from(lines.len()).unwrap_or(u64::MAX);
    if theirs.lines != count || theirs.opening + net != theirs.closing {
        return Err(refuse(
            "bank.statement_mismatch",
            format!(
                "{}\u{2019}s statement lists {} lines closing at {}, and its record here gives {} lines closing at {}, so no file was made.",
                partner.label(),
                theirs.lines,
                format_amount(theirs.closing),
                lines.len(),
                format_amount(theirs.opening + net)
            ),
        ));
    }
    let book: Vec<BookLine> = lines.iter().map(|l| l.line.clone()).collect();
    let file = formats::render(
        &BookStatement {
            account_id,
            account_name: &seat.account.name,
            currency: asset,
            servicer: partner.label(),
            from: range.from,
            to: range.to,
            opening: theirs.opening,
            closing: theirs.closing,
            lines: &book,
            generated_at: d.now,
        },
        format,
    )
    .ok_or_else(|| Refusal::Other(format!("no statement format {format}")))?;
    let sha: String = Sha256::digest(&file.body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(Json::obj([
        ("format", Json::str(file.format)),
        ("fileName", Json::str(file.file_name)),
        ("contentType", Json::str(file.content_type)),
        ("bodyBase64", Json::str(STANDARD.encode(&file.body))),
        ("sha256", Json::str(sha)),
        ("opening", Json::str(format_amount(theirs.opening))),
        ("closing", Json::str(format_amount(theirs.closing))),
        (
            "lineCount",
            Json::int(i64::try_from(lines.len()).unwrap_or(i64::MAX)),
        ),
        (
            "partner",
            Json::obj([
                ("label", Json::str(theirs.label)),
                ("closing", Json::str(format_amount(theirs.closing))),
                (
                    "lines",
                    Json::int(i64::try_from(theirs.lines).unwrap_or(i64::MAX)),
                ),
                ("asOf", Json::str(theirs.as_of.iso())),
            ]),
        ),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Internals

/// `codedLines`: the partner's lines for the business's account, oldest first, with their codes; with `apply_rules`,
/// a line nobody has coded that a rule matches is coded by the oldest such rule now.
fn coded_lines(
    d: &Deps<'_>,
    account_id: &str,
    asset_id: &str,
    partner: &Held<'_>,
    range: Range,
    apply_rules: bool,
) -> Result<Vec<LineView>, Refusal> {
    let owner = partner_account(account_id, asset_id).user_id;
    let mut moves = partner_moves_between(partner, &owner, asset_id, range.from, range.to)?;
    moves.reverse();
    let payees = payees_of(d, &moves)?;
    let ids: Vec<String> = moves.iter().map(|m| m.id.clone()).collect();
    let mut codes: BTreeMap<String, CodeRow> = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {CODE_COLS} FROM bank.business_line_codes \
                 WHERE account_id = $1::text::uuid AND line_id = ANY($2::text[])"
            ),
            &[&account_id, &ids],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(code_of)
        .collect()
    })?;
    let rules = if apply_rules {
        rules_of(d, account_id)?
    } else {
        Vec::new()
    };
    let mut out = Vec::with_capacity(moves.len());
    for m in &moves {
        let payee = payees
            .get(&m.id)
            .cloned()
            .unwrap_or_else(|| "Transfer".to_owned());
        let mut code = codes.remove(&m.id);
        if code.is_none()
            && let Some(rule) = rules.iter().find(|r| matches(&payee, &r.payee_contains))
        {
            code = with(d.store, |c| {
                c.execute(
                    "INSERT INTO bank.business_line_codes (account_id, line_id, category, gl_code, coded_by, rule_id) \
                     VALUES ($1::text::uuid, $2, $3, $4, 'rule', $5::text::uuid) \
                     ON CONFLICT (account_id, line_id) DO NOTHING",
                    &[&account_id, &m.id, &rule.category, &rule.gl_code, &rule.id],
                )
                .map_err(|e| pg(&e))?;
                c.query(
                    &format!(
                        "SELECT {CODE_COLS} FROM bank.business_line_codes \
                         WHERE account_id = $1::text::uuid AND line_id = $2"
                    ),
                    &[&account_id, &m.id],
                )
                .map_err(|e| pg(&e))?
                .first()
                .map(code_of)
                .transpose()
            })?
            .map(|(_, c)| c);
        }
        let incoming = m.to.user_id == owner;
        out.push(LineView {
            line: BookLine {
                id: m.id.clone(),
                booked_at: m.moved_at,
                amount: if incoming { m.amount } else { -m.amount },
                payee,
                category: code.as_ref().and_then(|c| c.category.clone()),
                gl_code: code.as_ref().and_then(|c| c.gl_code.clone()),
            },
            partner_key: m.key.clone(),
            coded_by: code.as_ref().map(|c| c.coded_by.clone()),
            rule_id: code.and_then(|c| c.rule_id),
        });
    }
    Ok(out)
}

/// `payeesOf`: who each line was with, from what svc-bank itself sent the partner: a card's merchant, a payout's
/// payees.
fn payees_of(d: &Deps<'_>, moves: &[Move]) -> Result<BTreeMap<String, String>, Refusal> {
    let prefix = card_capture_key("");
    let capture_keys: Vec<String> = moves
        .iter()
        .filter(|m| m.key.starts_with(&prefix))
        .map(|m| m.key.clone())
        .collect();
    let merchants: BTreeMap<String, String> = if capture_keys.is_empty() {
        BTreeMap::new()
    } else {
        with(d.store, |c| {
            c.query(
                "SELECT partner_key, merchant FROM bank.business_card_purchases WHERE partner_key = ANY($1::text[])",
                &[&capture_keys],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?)))
            .collect::<Result<_, Refusal>>()
        })?
    };
    let mut out = BTreeMap::new();
    for m in moves {
        let other = if m.from.user_id.starts_with("business:")
            && m.from.space_id.is_none()
            && m.to.user_id != m.from.user_id
        {
            &m.to
        } else {
            &m.from
        };
        let payee = if let Some(name) = merchants.get(&m.key) {
            name.clone()
        } else if let Some(payees) = m.payees.as_ref().filter(|p| !p.is_empty()) {
            let names: Vec<&str> = payees.iter().take(3).map(|p| p.name.as_str()).collect();
            if payees.len() > 3 {
                format!("{} and {} more", names.join(", "), payees.len() - 3)
            } else {
                names.join(", ")
            }
        } else if other.user_id == PAY_INS_OWNER {
            "Pay-in".to_owned()
        } else if other.user_id == PAYOUTS_OWNER {
            "Outbound payment".to_owned()
        } else if other.user_id == FEES_OWNER {
            "Partner fee".to_owned()
        } else if other.user_id == MERCHANT {
            "TEST merchant".to_owned()
        } else if m.key.starts_with("bank.business.reimbursement:") {
            "Team reimbursement".to_owned()
        } else {
            "Transfer".to_owned()
        };
        out.insert(m.id.clone(), payee);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_checks_follow_the_typescript_patterns() {
        assert!(plain_text("TESTSHOP", 80));
        assert!(!plain_text("", 80));
        assert!(!plain_text("a\u{7f}b", 80));
        assert!(plain_text(&"é".repeat(60), 60));
        assert!(!plain_text(&"é".repeat(61), 60));
        assert!(gl_shape("6100"));
        assert!(gl_shape("A1 .-/"));
        assert!(!gl_shape("-6100"));
        assert!(!gl_shape(&"a".repeat(33)));
        assert!(gl_shape(&"a".repeat(32)));
        assert_eq!(
            coding(Some("  "), Some(" 6100 ")).ok(),
            Some((None, Some("6100".to_owned())))
        );
    }

    #[test]
    fn a_range_is_checked_against_the_test_partners_window() {
        let now = Instant(1_000 * DAY_MS);
        let r = |from: i64, to: i64| Range {
            from: Instant(from),
            to: Instant(to),
        };
        assert!(check_range(r(now.0, now.0), now, false).is_err());
        assert!(check_range(r(now.0 - 367 * DAY_MS, now.0), now, false).is_err());
        assert!(check_range(r(now.0 - 401 * DAY_MS, now.0 - 300 * DAY_MS), now, false).is_err());
        assert_eq!(
            check_range(r(now.0 - 100 * DAY_MS, now.0), now, true).ok(),
            Some(true)
        );
        assert_eq!(
            check_range(r(now.0 - 100 * DAY_MS, now.0), now, false).ok(),
            Some(false)
        );
        assert_eq!(
            check_range(r(now.0 - 10 * DAY_MS, now.0), now, true).ok(),
            Some(false)
        );
    }

    /// Every code the part refuses with is one `errors.ts` declares.
    #[test]
    fn every_code_is_declared() {
        let src = include_str!("service.rs");
        let codes: BTreeSet<&str> = src
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|s| {
                s.starts_with("bank.")
                    && !s.starts_with("bank.business.")
                    && !s.contains(char::is_whitespace)
            })
            .collect();
        assert!(codes.len() >= 8, "{codes:?}");
        for code in codes {
            assert!(
                crate::errors::BankError::new(code, "x").is_some(),
                "{code} is no BankError code"
            );
        }
    }
}

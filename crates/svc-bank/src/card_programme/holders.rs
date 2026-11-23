//! Cardholders (`programme-ops.ts`): the KYC and KYB gate with screening and the review queue, the directory and one
//! cardholder's cards and funds, bulk issue, reassign (`CardService.reassignOwner`) and the simulator's gate.

use std::collections::BTreeSet;

use icu_normalizer::ComposingNormalizerBorrowed;
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, is_js_whitespace, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::{Deps, LIST, assert_may_change, audit, is_uuid, js_len, jsonb};
use crate::cards::moves::{decide, settle};
use crate::cards::reads::{HoldReads, test_card_holds};
use crate::cards::{CARD_COLS, Card, core, ms};
use crate::errors::Refusal;
use crate::partner::{money_held_by, refuse};
use crate::spaces::ports::{DirError, Lookup};
use crate::spaces::space::{in_tx, pg, with};
use crate::transfers::ports::RecipientStatus;

/// `KYC_RANK`: an unknown tier ranks nothing, so it is never "below" full (`undefined < 2` is false).
fn kyc_rank(tier: &str) -> Option<u8> {
    match tier {
        "none" => Some(0),
        "basic" => Some(1),
        "full" => Some(2),
        "institutional" => Some(3),
        _ => None,
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// `uuidFromKey`: a uuid from a business key, so issuing the same bulk row twice is the same card.
pub fn uuid_from_key(key: &str) -> String {
    let h = sha256_hex(key);
    let part = |a: usize, b: usize| h.get(a..b).unwrap_or_default();
    let variant = u8::from_str_radix(part(16, 17), 16).unwrap_or(0) & 0x3 | 0x8;
    format!(
        "{}-{}-4{}-{variant:x}{}-{}",
        part(0, 8),
        part(8, 12),
        part(13, 16),
        part(17, 20),
        part(20, 32)
    )
}

/// `fold`: NFKC, trimmed, each run of white space one space, lower case.
pub fn fold(name: &str) -> String {
    let n = ComposingNormalizerBorrowed::new_nfkc().normalize(name);
    let mut out = String::new();
    let mut gap = false;
    for c in js_trim(&n).chars() {
        if is_js_whitespace(c) {
            gap = true;
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
    }
    out.to_lowercase()
}

/// `readCardholderSanctions`: the list as folded names, or `None` when it is unset or blank.
pub fn read_sanctions(raw: Option<&str>) -> Option<BTreeSet<String>> {
    let raw = raw?;
    if js_trim(raw).is_empty() {
        return None;
    }
    let names: BTreeSet<String> = raw.split('|').map(fold).filter(|n| !n.is_empty()).collect();
    (!names.is_empty()).then_some(names)
}

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
fn email_shape(e: &str) -> bool {
    if e.chars().any(is_js_whitespace) {
        return false;
    }
    let mut parts = e.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && domain
            .char_indices()
            .any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// `unconfiguredBusinessDirectory`'s words.
const DIRECTORY_UNSET: &str = "IDENTITY_URL is unset, so svc-bank cannot read public handles from svc-identity. Team list, approval history and recipient lookup stay closed until that directory is connected (bank.business_directory_unset)";

/// `findAccount`: an active account by exact email, or none.
pub fn find_account(d: &Deps<'_>, email: &str) -> Result<Option<String>, Refusal> {
    let e = js_trim(email).to_lowercase();
    if !email_shape(&e) {
        return Ok(None);
    }
    match d.cards.t.spaces.directory.find_active(&Lookup::Email(e)) {
        Ok(found) => Ok(found.map(|(id, _)| id)),
        Err(DirError::Unset) => Err(refuse("bank.business_directory_unset", DIRECTORY_UNSET)),
        Err(DirError::Unavailable) => Err(refuse(
            "bank.business_directory_unavailable",
            "svc-identity did not answer the account lookup. Nothing was changed.",
        )),
    }
}

/// `verifiedPerson`: whether one email is an active account at the full verification level; the gap in words when not.
fn verified_person(d: &Deps<'_>, email: &str) -> Result<(Option<String>, Option<String>), Refusal> {
    let Some(user_id) = find_account(d, email)? else {
        return Ok((
            None,
            Some(format!("No active account has the email {email}.")),
        ));
    };
    let state = d.cards.t.w.recipients.account_of(&user_id).map_err(|_| {
        refuse(
            "bank.business_directory_unavailable",
            "svc-identity did not answer the verification check. Nothing was changed.",
        )
    })?;
    let gap = match state {
        Some(s) if s.status == RecipientStatus::Active => match kyc_rank(&s.kyc_tier) {
            Some(r) if r < 2 => Some(format!(
                "The account for {email} is verified to \u{201c}{}\u{201d}, below the full level cards need.",
                s.kyc_tier
            )),
            _ => None,
        },
        _ => Some(format!("The account for {email} is not active.")),
    };
    Ok((Some(user_id), gap))
}

/// `CardholderRow`.
pub struct Holder {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub email: Option<String>,
    pub country: String,
    pub user_id: Option<String>,
    pub owners: Json,
    pub status: String,
    pub gap: Option<String>,
    pub gap_code: Option<String>,
    pub screening: String,
    pub screened_at: i64,
    pub test: bool,
    pub created_at: i64,
}

fn holder_cols() -> String {
    format!(
        "h.id::text, h.kind, h.name, h.email, h.country, h.user_id, h.beneficial_owners::text, h.status, h.gap, h.gap_code, \
         h.screening, {}, h.test, {}",
        ms("h.screened_at"),
        ms("h.created_at")
    )
}

impl Holder {
    fn from_row(r: &Row) -> Result<Holder, Refusal> {
        Ok(Holder {
            id: r.get(0),
            kind: r.get(1),
            name: r.get(2),
            email: r.get(3),
            country: r.get(4),
            user_id: r.get(5),
            owners: jsonb(&r.get::<_, String>(6))?,
            status: r.get(7),
            gap: r.get(8),
            gap_code: r.get(9),
            screening: r.get(10),
            screened_at: r.get(11),
            test: r.get(12),
            created_at: r.get(13),
        })
    }

    /// `toCardholder`, in the output's key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
        let f = |k: &str, v: Json| (k.to_owned(), v);
        vec![
            f("id", Json::str(self.id.clone())),
            f("kind", Json::str(self.kind.clone())),
            f("name", Json::str(self.name.clone())),
            f("email", opt(&self.email)),
            f("country", Json::str(self.country.clone())),
            f("userId", opt(&self.user_id)),
            f("beneficialOwners", owners_out(&self.owners)),
            f("status", Json::str(self.status.clone())),
            f("gap", opt(&self.gap)),
            f("gapCode", opt(&self.gap_code)),
            f("screening", Json::str(self.screening.clone())),
            f("screenedAt", Json::str(Instant(self.screened_at).iso())),
            f("test", Json::Bool(self.test)),
            f("createdAt", Json::str(Instant(self.created_at).iso())),
        ]
    }

    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }
}

/// The owners as the output schema reads them (`{ name, email }` each).
fn owners_out(owners: &Json) -> Json {
    match owners {
        Json::Array(list) => Json::Array(
            list.iter()
                .map(|o| {
                    Json::obj([
                        ("name", o.get("name").cloned().unwrap_or(Json::Null)),
                        ("email", o.get("email").cloned().unwrap_or(Json::Null)),
                    ])
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn holder_by_key(c: &mut impl GenericClient, key: &str) -> Result<Option<Holder>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.card_cardholders h WHERE h.request_key = $1",
            holder_cols()
        ),
        &[&key],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(Holder::from_row)
    .transpose()
}

/// `cardholderRow`: by id, or `bank.cardholder_not_found`; an id that is no uuid is not asked of the database.
fn holder_row(d: &Deps<'_>, id: &str) -> Result<Holder, Refusal> {
    let not_found = || {
        refuse(
            "bank.cardholder_not_found",
            "No such cardholder (bank.cardholder_not_found)",
        )
    };
    if !is_uuid(id) {
        return Err(not_found());
    }
    with(d.store(), |c| holder_by_id(c, id))?.ok_or_else(not_found)
}

fn holder_by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<Holder>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.card_cardholders h WHERE h.id = $1::text::uuid",
            holder_cols()
        ),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(Holder::from_row)
    .transpose()
}

/// What a create asked for, trimmed (`replay`'s `asked`).
struct Asked {
    kind: String,
    name: String,
    email: Option<String>,
    country: String,
    owners: Json,
}

/// `replay`: the same request key is the same cardholder; one in review refuses with its code.
fn replay(row: &Holder, asked: &Asked) -> Result<Json, Refusal> {
    if row.kind != asked.kind
        || row.name != asked.name
        || row.email != asked.email
        || row.country != asked.country
        || row.owners.compact() != asked.owners.compact()
    {
        return Err(refuse(
            "bank.cardholder_conflict",
            "That request key was used for a different cardholder (bank.cardholder_conflict)",
        ));
    }
    if row.status == "review" {
        let code = if row.gap_code.as_deref() == Some("bank.cardholder_under_review") {
            "bank.cardholder_under_review"
        } else {
            "bank.cardholder_unverified"
        };
        return Err(refuse(
            code,
            format!(
                "{} The cardholder is in the review queue ({code})",
                row.gap.as_deref().unwrap_or("null")
            ),
        ));
    }
    Ok(row.json())
}

/// One beneficial owner as asked.
pub struct Owner {
    pub name: String,
    pub email: String,
}

/// `CardholderInput`.
pub struct HolderAsk<'a> {
    pub request_key: &'a str,
    pub kind: &'a str,
    pub name: &'a str,
    pub email: Option<&'a str>,
    pub country: &'a str,
    pub owners: Vec<Owner>,
}

/// `createCardholder`: behind the KYC and KYB gate, after screening. Every name is screened first; an unset list
/// refuses and stores nothing. A cardholder whose gate fails or whose name matches is stored in review with the gap
/// named, and the create refuses with its code. The same request key returns the first answer.
pub fn create_cardholder(d: &Deps<'_>, actor: &str, ask: &HolderAsk<'_>) -> Result<Json, Refusal> {
    let key = js_trim(ask.request_key);
    let name = js_trim(ask.name).to_owned();
    let country = js_trim(ask.country).to_uppercase();
    let owners: Vec<(String, String)> = ask
        .owners
        .iter()
        .map(|o| {
            (
                js_trim(&o.name).to_owned(),
                js_trim(&o.email).to_lowercase(),
            )
        })
        .collect();
    let individual = ask.kind == "individual";
    let email = individual.then(|| js_trim(ask.email.unwrap_or_default()).to_lowercase());
    let country_ok = country.len() == 2 && country.bytes().all(|b| b.is_ascii_uppercase());
    if js_len(key) < 8
        || js_len(key) > 128
        || name.is_empty()
        || js_len(&name) > 120
        || !country_ok
        || (individual && email.as_deref().is_none_or(str::is_empty))
        || (individual && !owners.is_empty())
        || owners.len() > 10
        || owners.iter().any(|(n, e)| n.is_empty() || e.is_empty())
    {
        return Err(refuse(
            "bank.card_programme_invalid",
            "A cardholder needs a request key, a name and a two-letter country; a person an email, a business its beneficial owners (bank.card_programme_invalid)",
        ));
    }
    let owners_json = Json::Array(
        owners
            .iter()
            .map(|(n, e)| {
                Json::obj([
                    ("name", Json::str(n.clone())),
                    ("email", Json::str(e.clone())),
                ])
            })
            .collect(),
    );
    let asked = Asked {
        kind: ask.kind.to_owned(),
        name: name.clone(),
        email: email.clone(),
        country: country.clone(),
        owners: owners_json.clone(),
    };
    if let Some(prior) = with(d.store(), |c| holder_by_key(c, key))? {
        return replay(&prior, &asked);
    }
    with(d.store(), |c| assert_may_change(c, actor))?;
    let Some(list) = read_sanctions(d.w.sanctions.as_deref()) else {
        return Err(refuse(
            "bank.cardholder_screening_unset",
            "The cardholder sanctions list is not set, so no cardholder can be screened or created. Nothing was saved (bank.cardholder_screening_unset)",
        ));
    };
    let listed = std::iter::once(&name)
        .chain(owners.iter().map(|(n, _)| n))
        .find(|n| list.contains(&fold(n)))
        .cloned();
    let mut user_id: Option<String> = None;
    let mut gap: Option<String> = None;
    if individual {
        let (u, g) = verified_person(d, email.as_deref().unwrap_or_default())?;
        user_id = u;
        gap = g;
    } else if owners.is_empty() {
        gap = Some(
            "No beneficial owner on file: a business cardholder needs at least one verified beneficial owner (KYB)."
                .to_owned(),
        );
    } else {
        for (n, e) in &owners {
            if let (_, Some(g)) = verified_person(d, e)? {
                gap = Some(format!("Beneficial owner {n}: {g}"));
                break;
            }
        }
    }
    let gap_code = if listed.is_some() {
        Some("bank.cardholder_under_review")
    } else if gap.is_some() {
        Some("bank.cardholder_unverified")
    } else {
        None
    };
    let gap_words = match &listed {
        Some(l) => Some(format!("Screening match: {l} is on the sanctions list.")),
        None => gap,
    };
    let status = if gap_code.is_some() {
        "review"
    } else {
        "verified"
    };
    let screening = if listed.is_some() { "listed" } else { "clear" };
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    let now = d.cards.now().0;
    let test = d.test();
    let owners_text = owners_json.compact();
    in_tx(d.store(), |tx| {
        let inserted = tx
            .query(
                "INSERT INTO bank.card_cardholders (id, request_key, kind, name, email, country, user_id, beneficial_owners, \
                   status, gap, gap_code, screening, screened_at, test, created_by) \
                 VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10, $11, $12, \
                   to_timestamp($13::int8 / 1000.0), $14, $15) \
                 ON CONFLICT (request_key) DO NOTHING RETURNING id",
                &[
                    &id,
                    &key,
                    &ask.kind,
                    &name,
                    &email,
                    &country,
                    &user_id,
                    &owners_text,
                    &status,
                    &gap_words,
                    &gap_code,
                    &screening,
                    &now,
                    &test,
                    &actor,
                ],
            )
            .map_err(|e| pg(&e))?;
        if !inserted.is_empty() {
            audit(
                tx,
                actor,
                "cardholder.create",
                &name,
                None,
                Some(&Json::obj([
                    ("kind", Json::str(ask.kind)),
                    ("status", Json::str(status)),
                    ("gap", gap_words.clone().map_or(Json::Null, Json::str)),
                ])),
            )?;
        }
        Ok(())
    })?;
    let stored = with(d.store(), |c| holder_by_key(c, key))?
        .ok_or_else(|| Refusal::Other("the cardholder was not stored".to_owned()))?;
    replay(&stored, &asked)
}

/// `cardsOf`: the newest 50 cards of the cardholder's account.
fn cards_of(c: &mut impl GenericClient, user_id: Option<&str>) -> Result<Json, Refusal> {
    let Some(user_id) = user_id else {
        return Ok(Json::Array(Vec::new()));
    };
    let rows = c
        .query(
            "SELECT id::text, pan_tail, status::text, asset_id, simulated FROM bank.cards WHERE user_id = $1 \
             ORDER BY created_at DESC LIMIT $2",
            &[&user_id, &LIST],
        )
        .map_err(|e| pg(&e))?;
    Ok(Json::Array(
        rows.iter()
            .map(|r| {
                Json::obj([
                    ("id", Json::str(r.get::<_, String>(0))),
                    ("panTail", Json::str(r.get::<_, String>(1))),
                    ("status", Json::str(r.get::<_, String>(2))),
                    ("assetId", Json::str(r.get::<_, String>(3))),
                    ("test", Json::Bool(r.get(4))),
                ])
            })
            .collect(),
    ))
}

fn like_safe(q: &str) -> String {
    q.chars().fold(String::new(), |mut s, c| {
        if matches!(c, '\\' | '%' | '_') {
            s.push('\\');
        }
        s.push(c);
        s
    })
}

/// `cardholders`: the directory, by name, email or a card's last four digits; empty lists the newest.
pub fn cardholders(c: &mut impl GenericClient, query: Option<&str>) -> Result<Json, Refusal> {
    let q = js_trim(query.unwrap_or_default());
    let rows = if q.is_empty() {
        c.query(
            &format!(
                "SELECT {} FROM bank.card_cardholders h ORDER BY h.created_at DESC LIMIT $1",
                holder_cols()
            ),
            &[&LIST],
        )
    } else {
        let like = format!("%{}%", like_safe(q));
        c.query(
            &format!(
                "SELECT {} FROM bank.card_cardholders h \
                  WHERE h.name ILIKE $1 OR h.email ILIKE $1 \
                     OR (h.user_id IS NOT NULL AND EXISTS ( \
                           SELECT 1 FROM bank.cards k WHERE k.user_id = h.user_id AND k.pan_tail LIKE $1)) \
                  ORDER BY h.created_at DESC LIMIT $2",
                holder_cols()
            ),
            &[&like, &LIST],
        )
    }
    .map_err(|e| pg(&e))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let h = Holder::from_row(r)?;
        let mut fields = h.fields();
        fields.push(("cards".to_owned(), cards_of(c, h.user_id.as_deref())?));
        out.push(Json::Object(fields));
    }
    Ok(Json::Array(out))
}

/// `reviewQueue`: the newest 50 cardholders in review.
pub fn review_queue(c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.card_cardholders h WHERE h.status = 'review' ORDER BY h.created_at DESC LIMIT $1",
                holder_cols()
            ),
            &[&LIST],
        )
        .map_err(|e| pg(&e))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(Holder::from_row(r)?.json());
    }
    Ok(Json::Array(out))
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// `CardService.cardholderFunds`: per asset, this app's open holds and captures on the person's cards beside the card
/// partner's own figures for the person; a figure the partner does not report is null, never 0.
fn cardholder_funds(d: &Deps<'_>, user_id: &str) -> Result<Json, Refusal> {
    let rows = with(d.store(), |c| {
        c.query(
            "SELECT k.asset_id, \
                    COALESCE(SUM(GREATEST(a.amount - COALESCE(( \
                      SELECT SUM(s.amount) FROM bank.card_settlements s WHERE s.authorization_id = a.id AND s.status = 'settled' \
                    ), 0), 0)) FILTER (WHERE a.decision = 'approved' AND a.status = 'settled'), 0)::text, \
                    COALESCE(SUM(( \
                      SELECT COALESCE(SUM(s.amount), 0) FROM bank.card_settlements s \
                       WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled' \
                    )), 0)::text \
               FROM bank.cards k \
               LEFT JOIN bank.card_authorizations a ON a.card_id = k.id \
              WHERE k.user_id = $1 \
              GROUP BY k.asset_id \
              ORDER BY k.asset_id",
            &[&user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let partner = d.cards.t.partner;
    let held_by = money_held_by(partner.partner.as_ref(), user_id, &partner.custody_layer);
    let holds = if held_by == "partner" {
        test_card_holds(d.cards, &d.cards.w.holds)
    } else {
        None
    };
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let asset: String = r.get(0);
        let app_held = amount(&r.get::<_, String>(1))?;
        let app_captured = amount(&r.get::<_, String>(2))?;
        let (mut partner_held, mut partner_captured): (Option<Amount>, Option<Amount>) =
            (None, None);
        if let Some(h) = &holds {
            let figures = h.figures(user_id, &asset)?;
            let captured = match h.captured(user_id, &asset) {
                Some(c) => c?,
                None => None,
            };
            partner_held = figures.held.as_deref().map(amount).transpose()?;
            partner_captured = captured.as_deref().map(amount).transpose()?;
        }
        let app_figure = app_held + app_captured;
        let partner_figure = match (partner_held, partner_captured) {
            (Some(h), Some(c)) => Some(h + c),
            _ => None,
        };
        let difference = partner_figure.map(|p| p - app_figure);
        let a = |v: Option<Amount>| v.map_or(Json::Null, |v| Json::str(format_amount(v)));
        out.push(Json::obj([
            ("assetId", Json::str(asset)),
            ("appHeld", Json::str(format_amount(app_held))),
            ("appCaptured", Json::str(format_amount(app_captured))),
            ("appFigure", Json::str(format_amount(app_figure))),
            ("partnerHeld", a(partner_held)),
            ("partnerCaptured", a(partner_captured)),
            ("partnerFigure", a(partner_figure)),
            ("difference", a(difference)),
            (
                "status",
                Json::str(match difference {
                    None => "not_known",
                    Some(0) => "matches",
                    Some(_) => "break",
                }),
            ),
            ("test", Json::Bool(holds.is_some())),
        ]));
    }
    Ok(Json::Array(out))
}

/// `cardholder`: one cardholder with their cards and their card funds beside the partner's own figures.
pub fn cardholder(d: &Deps<'_>, id: &str) -> Result<Json, Refusal> {
    let h = holder_row(d, id)?;
    let funds = match h.user_id.as_deref() {
        None => Json::Array(Vec::new()),
        Some(u) => cardholder_funds(d, u)?,
    };
    let mut fields = h.fields();
    fields.push((
        "cards".to_owned(),
        with(d.store(), |c| cards_of(c, h.user_id.as_deref()))?,
    ));
    fields.push(("funds".to_owned(), funds));
    Ok(Json::Object(fields))
}

/// `verifiedHolder`: a verified individual with an account; a business's cards are held by its people.
fn verified_holder(d: &Deps<'_>, id: &str) -> Result<(Holder, String), Refusal> {
    let h = holder_row(d, id)?;
    if h.status == "review" {
        return Err(refuse(
            "bank.cardholder_under_review",
            format!(
                "{} is in the review queue: {} (bank.cardholder_under_review)",
                h.name,
                h.gap.as_deref().unwrap_or("null")
            ),
        ));
    }
    match h.user_id.clone() {
        Some(u) if h.kind == "individual" => Ok((h, u)),
        _ => Err(refuse(
            "bank.cardholder_unverified",
            format!(
                "{} is a business: its cards are held by its people, each a cardholder of their own (bank.cardholder_unverified)",
                h.name
            ),
        )),
    }
}

/// One row of a bulk file (`BulkRow`).
pub struct BulkRow {
    pub row: i64,
    pub cardholder_id: String,
    pub asset_id: String,
    pub limit: String,
    pub error: Option<String>,
}

/// `validateBulk`: each row checked: `cardholder_id,asset,per_authorisation_limit`, one card per row.
pub fn validate_bulk(d: &Deps<'_>, text: &str) -> Result<(String, Vec<BulkRow>), Refusal> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| js_trim(l.strip_suffix('\r').unwrap_or(l)))
        .filter(|l| !l.is_empty())
        .collect();
    let body = match lines.first() {
        Some(first) if first.to_lowercase().starts_with("cardholder") => {
            lines.get(1..).unwrap_or_default()
        }
        _ => &lines[..],
    };
    if body.is_empty() || body.len() > 500 {
        return Err(refuse(
            "bank.card_bulk_invalid",
            "A bulk card file has 1 to 500 rows (bank.card_bulk_invalid)",
        ));
    }
    let mut rows = Vec::with_capacity(body.len());
    for (i, line) in body.iter().enumerate() {
        let cells: Vec<&str> = line.split(',').map(js_trim).collect();
        let cell = |n: usize| cells.get(n).copied().unwrap_or_default();
        let (holder, asset, limit) = (cell(0), cell(1), cell(2));
        let mut row = BulkRow {
            row: i64::try_from(i).unwrap_or(i64::MAX) + 1,
            cardholder_id: holder.to_owned(),
            asset_id: asset.to_uppercase(),
            limit: limit.to_owned(),
            error: None,
        };
        if cells.len() > 3 {
            row.error = Some(
                "Too many columns: a row is cardholder id, asset, per-authorisation limit."
                    .to_owned(),
            );
        } else if !crate::cards::terms::is_decimal(limit)
            || !limit.bytes().any(|b| (b'1'..=b'9').contains(&b))
        {
            row.error = Some(format!(
                "The per-authorisation limit \u{201c}{limit}\u{201d} is not a positive amount."
            ));
        } else if !crate::cards::terms::is_asset_id(&row.asset_id) {
            row.error = Some(format!("\u{201c}{asset}\u{201d} is not an asset."));
        } else if let Err(e) = verified_holder(d, holder) {
            row.error = Some(match e {
                Refusal::Bank(b) => b.message,
                _ => "The cardholder could not be read.".to_owned(),
            });
        }
        rows.push(row);
    }
    let canonical: Vec<String> = rows
        .iter()
        .map(|r| {
            format!(
                "{},{},{}",
                r.cardholder_id.to_lowercase(),
                r.asset_id,
                r.limit
            )
        })
        .collect();
    Ok((sha256_hex(&canonical.join("\n")), rows))
}

/// `validateBulk` as the call answers it.
pub fn validate_bulk_json(d: &Deps<'_>, text: &str) -> Result<Json, Refusal> {
    let (batch, rows) = validate_bulk(d, text)?;
    let ok = rows.iter().all(|r| r.error.is_none());
    Ok(Json::obj([
        ("batchId", Json::str(batch)),
        ("ok", Json::Bool(ok)),
        (
            "rows",
            Json::Array(
                rows.into_iter()
                    .map(|r| {
                        Json::obj([
                            ("row", Json::int(r.row)),
                            ("cardholderId", Json::str(r.cardholder_id)),
                            ("assetId", Json::str(r.asset_id)),
                            ("perAuthorizationLimit", Json::str(r.limit)),
                            ("error", r.error.map_or(Json::Null, Json::str)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// `issueBulk`: nothing issues while any row is bad. Each row's card id comes from the file's hash and the row, so
/// issuing the same file again returns the same cards, never more.
pub fn issue_bulk(d: &Deps<'_>, actor: &str, text: &str) -> Result<Json, Refusal> {
    let (batch, rows) = validate_bulk(d, text)?;
    let bad: Vec<String> = rows
        .iter()
        .filter_map(|r| r.error.as_ref().map(|e| format!("row {}: {e}", r.row)))
        .collect();
    if !bad.is_empty() {
        return Err(refuse(
            "bank.card_bulk_invalid",
            format!(
                "Nothing was issued: {} (bank.card_bulk_invalid)",
                bad.join(" ")
            ),
        ));
    }
    with(d.store(), |c| assert_may_change(c, actor))?;
    let count = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.card_bulk_batches (id, rows, created_by) VALUES ($1, $2::int8::int4, $3) \
             ON CONFLICT (id) DO NOTHING",
            &[&batch, &count, &actor],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    let mut issued = Vec::with_capacity(rows.len());
    for r in &rows {
        let (holder, user_id) = verified_holder(d, &r.cardholder_id)?;
        let card_id = uuid_from_key(&format!("card-bulk:{batch}:{}", r.row));
        let card = core::issue(
            d.cards,
            &core::IssueAsk {
                card_id,
                user_id,
                asset_id: r.asset_id.clone(),
                per_authorization_limit: amount(&r.limit)?,
                ..core::IssueAsk::default()
            },
        )?;
        with(d.store(), |c| {
            c.execute(
                "INSERT INTO bank.card_bulk_cards (batch_id, row_no, cardholder_id, card_id) \
                 VALUES ($1, $2::int8::int4, $3::text::uuid, $4::text::uuid) ON CONFLICT (batch_id, row_no) DO NOTHING",
                &[&batch, &r.row, &holder.id, &card.id],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        })?;
        issued.push(Json::obj([
            ("row", Json::int(r.row)),
            ("cardId", Json::str(card.id)),
            ("panTail", Json::str(card.pan_tail)),
            ("cardholderId", Json::str(holder.id)),
        ]));
    }
    let made = i64::try_from(issued.len()).unwrap_or(i64::MAX);
    let in_batch: i64 = with(d.store(), |c| {
        audit(
            c,
            actor,
            "cards.bulk_issue",
            &batch,
            None,
            Some(&Json::obj([("rows", Json::int(made))])),
        )?;
        Ok(c.query(
            "SELECT count(*)::int8 FROM bank.card_bulk_cards WHERE batch_id = $1",
            &[&batch],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map_or(0, |r| r.get(0)))
    })?;
    Ok(Json::obj([
        ("batchId", Json::str(batch)),
        ("cards", Json::Array(issued)),
        ("cardsInBatch", Json::int(in_batch)),
        ("test", Json::Bool(d.test())),
    ]))
}

/// `CardService.reassignOwner`: move a card to another person. A card holds no money, so nothing moves; it draws on its
/// new holder's balance from the next authorisation. Refused for a closed card, for one with an approved authorisation
/// not yet captured or given back (whose hold is the first holder's), and over the new holder's count limit. Runs in
/// `tx`, so the caller records the move in the same transaction.
fn reassign_owner(
    d: &Deps<'_>,
    tx: &mut postgres::Transaction<'_>,
    card_id: &str,
    to_user_id: &str,
) -> Result<(String, Card), Refusal> {
    d.cards.assert_module_enabled()?;
    d.cards.assert_issuer_may_mutate()?;
    let lock = format!("card-count:{to_user_id}");
    tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&lock])
        .map_err(|e| pg(&e))?;
    let rows = tx
        .query(
            "SELECT user_id, status::text, card_type FROM bank.cards WHERE id = $1::text::uuid FOR UPDATE",
            &[&card_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(row) = rows.first() else {
        return Err(refuse(
            "bank.card_not_found",
            format!("Card {card_id} not found"),
        ));
    };
    let (from, status, card_type): (String, String, String) = (row.get(0), row.get(1), row.get(2));
    if status == "closed" {
        return Err(refuse(
            "bank.card_not_active",
            "A closed card cannot be reassigned (bank.card_not_active)",
        ));
    }
    if from == to_user_id {
        return Err(refuse(
            "bank.card_reassign_same",
            "The card already belongs to that cardholder (bank.card_reassign_same)",
        ));
    }
    let open: i64 = tx
        .query(
            "SELECT count(*)::int8 FROM bank.card_authorizations a \
              WHERE a.card_id = $1::text::uuid AND a.decision = 'approved' \
                AND NOT EXISTS (SELECT 1 FROM bank.card_settlements s WHERE s.authorization_id = a.id AND s.status = 'settled')",
            &[&card_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map_or(0, |r| r.get(0));
    if open > 0 {
        return Err(refuse(
            "bank.card_reassign_open_hold",
            "This card has an authorisation still held for its holder; it can be reassigned once that is captured or given back (bank.card_reassign_open_hold)",
        ));
    }
    if let Some(terms) = d.cards.settings().programme.as_ref() {
        core::assert_under_count(tx, to_user_id, &card_type, terms.limit(&card_type))?;
    }
    tx.execute(
        "UPDATE bank.cards SET user_id = $2, updated_at = now() WHERE id = $1::text::uuid",
        &[&card_id, &to_user_id],
    )
    .map_err(|e| pg(&e))?;
    let moved = tx
        .query(
            &format!("SELECT {CARD_COLS} FROM bank.cards WHERE id = $1::text::uuid"),
            &[&card_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(Card::from_row)
        .transpose()?
        .ok_or_else(|| refuse("bank.card_not_found", format!("Card {card_id} not found")))?;
    Ok((from, moved))
}

/// `reassign`: a card to a verified cardholder, recorded and audited in the move's transaction.
pub fn reassign(d: &Deps<'_>, actor: &str, card_id: &str, to: &str) -> Result<Json, Refusal> {
    let (holder, user_id) = verified_holder(d, to)?;
    with(d.store(), |c| assert_may_change(c, actor))?;
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    let card = in_tx(d.store(), |tx| {
        let (from, card) = reassign_owner(d, tx, card_id, &user_id)?;
        tx.execute(
            "INSERT INTO bank.card_reassignments (id, card_id, from_user_id, to_cardholder_id, actor) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::uuid, $5)",
            &[&id, &card.id, &from, &holder.id, &actor],
        )
        .map_err(|e| pg(&e))?;
        audit(
            tx,
            actor,
            "card.reassign",
            &format!("card {}", card.pan_tail),
            Some(&Json::obj([("userId", Json::str(from))])),
            Some(&Json::obj([
                ("cardholder", Json::str(holder.name.clone())),
                ("userId", Json::str(user_id.clone())),
            ])),
        )?;
        Ok(card)
    })?;
    Ok(Json::obj([
        ("cardId", Json::str(card.id)),
        ("panTail", Json::str(card.pan_tail)),
        ("cardholderId", Json::str(holder.id)),
    ]))
}

/// `simulate`: one TEST card event on a simulated card, on a dev or test stack, through slice `card-ops`' own
/// authorise, capture or reverse (`cards::moves`), then its audit row (`simulator.<kind>`, which the audit list leaves
/// out and the decision log shows).
pub fn simulate(d: &Deps<'_>, actor: &str, input: &Value) -> Result<Json, Refusal> {
    let text = |k: &str| input.get(k).as_str().unwrap_or_default().to_owned();
    let card = crate::cards::read_card(d.cards, &text("cardId"))?;
    if !d.w.simulator_allowed || !card.simulated {
        return Err(refuse(
            "bank.card_sim_not_live",
            "The card event simulator runs only on a dev or test stack, on a simulated card (bank.card_sim_not_live)",
        ));
    }
    with(d.store(), |c| assert_may_change(c, actor))?;
    let kind = text("kind");
    let reference = text("authorizationRef");
    let amount = || parse_amount(&text("amount")).map_err(Refusal::Other);
    let answer: Vec<(String, Json)> = match kind.as_str() {
        "authorize" => {
            let a = decide::authorize(
                d.moves,
                &decide::Ask {
                    card_id: card.id.clone(),
                    authorization_ref: reference.clone(),
                    amount: amount()?,
                    channel: input.get("channel").as_str().map(str::to_owned),
                    merchant_category: input
                        .get("merchantCategory")
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned),
                    three_ds: input.get("threeDs").as_str().map(str::to_owned),
                    ..decide::Ask::default()
                },
            )?;
            vec![
                ("authorizationId".to_owned(), Json::str(a.id)),
                ("decision".to_owned(), Json::str(a.decision)),
                (
                    "declineCode".to_owned(),
                    a.decline_code.map_or(Json::Null, Json::str),
                ),
            ]
        }
        "capture" => {
            let c = settle::capture(d.moves, &card.id, &reference, amount()?)?;
            vec![
                ("captured".to_owned(), Json::str(format_amount(c.captured))),
                ("returned".to_owned(), Json::str(format_amount(c.returned))),
            ]
        }
        _ => {
            let r = settle::reverse(d.moves, &card.id, &reference)?;
            vec![("returned".to_owned(), Json::str(format_amount(r.returned)))]
        }
    };
    let after = Json::Object(answer.clone());
    with(d.store(), |c| {
        audit(
            c,
            actor,
            &format!("simulator.{kind}"),
            &format!("card {} {reference}", card.pan_tail),
            None,
            Some(&after),
        )
    })?;
    let mut out = vec![
        ("test".to_owned(), Json::Bool(true)),
        ("kind".to_owned(), Json::str(kind)),
    ];
    out.extend(answer);
    Ok(Json::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bulk_card_id_is_a_version_4_uuid_from_its_key() {
        let id = uuid_from_key("card-bulk:abc:1");
        assert!(is_uuid(&id));
        assert_eq!(id.get(14..15), Some("4"));
        assert!(matches!(id.get(19..20), Some("8" | "9" | "a" | "b")));
        assert_eq!(id, uuid_from_key("card-bulk:abc:1"));
    }

    #[test]
    fn a_name_is_folded_as_the_list_is() {
        assert_eq!(
            fold("  local test  Sanctioned\u{a0}Cardholder "),
            "local test sanctioned cardholder"
        );
        assert_eq!(fold("\u{ff21}BC"), "abc");
        let list = read_sanctions(Some("LOCAL TEST Sanctioned Cardholder| |")).unwrap_or_default();
        assert!(list.contains("local test sanctioned cardholder"));
        assert_eq!(list.len(), 1);
        assert!(read_sanctions(Some(" ")).is_none());
        assert!(read_sanctions(Some("|")).is_none());
        assert!(read_sanctions(None).is_none());
    }

    #[test]
    fn an_email_has_one_at_and_a_dot_inside_its_domain() {
        assert!(email_shape("p@example.test"));
        assert!(!email_shape("p@example"));
        assert!(!email_shape("p@.test"));
        assert!(!email_shape("p@example."));
        assert!(!email_shape("p q@example.test"));
        assert!(!email_shape("p@@example.test"));
        assert!(email_shape("p@a..b"));
    }
}
